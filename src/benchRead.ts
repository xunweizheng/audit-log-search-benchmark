/**
 * benchRead.ts — read benchmark.
 *
 * For every scheme × keyword × date-range combination:
 *   1. Run WARMUP queries (timing discarded).
 *   2. Run ITERATIONS queries, recording each latency.
 *   3. Run EXPLAIN ANALYZE once and capture the output.
 *   4. Record rows matched.
 *
 * Aggregated results are written to reports/ as markdown + JSON + CSV.
 */
import path from 'node:path';

import { config } from './lib/config.js';
import { closeConnection, getConnection, query } from './lib/db.js';
import { resolveKeywords, samplePathValues } from './lib/keywords.js';
import { log } from './lib/logger.js';
import {
    type BenchReport,
    type EnvSnapshot,
    type ReadResult,
    type WriteResult,
    buildAutoConclusion,
    writeReport,
} from './lib/report.js';
import { type DateRange, type Scheme, dateRanges, schemes } from './lib/schemes.js';
import { computeStats, fmtMs, timeRepeated } from './lib/timer.js';

interface CountRow {
    n: number;
}

async function main(): Promise<void> {
    log.step('Read benchmark');

    const env = await snapshotEnv();
    log.info(`MySQL ${env.mysqlVersion} | source rows: ${env.sourceTableRows.toLocaleString()}`);
    log.info(`Sample tenant: ${env.sampleTenant} (${env.sampleTenantRows.toLocaleString()} rows)`);

    const keywords = await resolveKeywords(env.sampleTenant);
    log.info(`Keywords — common: [${keywords.common.join(', ')}]`);
    log.info(`Keywords — rare:   [${keywords.rare.join(', ')}]`);
    log.info(`Keywords — missing:[${keywords.missing.join(', ')}]`);

    const reads: ReadResult[] = [];

    for (const scheme of schemes) {
        log.step(`Scheme ${scheme.id}: ${scheme.name}`);
        if (scheme.supports.includes('path-value')) {
            // v3 + v4: iterate JSON paths and pick a real value for each.
            for (const jsonPath of config.jsonPaths) {
                const values = await samplePathValues(scheme.table, env.sampleTenant, jsonPath, 1);
                const value = values[0];
                for (const dr of dateRanges) {
                    reads.push(
                        await runOne(scheme, env.sampleTenant, value, dr, 'path-value', jsonPath)
                    );
                }
            }
        } else {
            // v1 + v2 + v5: iterate keyword buckets.
            const buckets: Array<['common' | 'rare' | 'missing', string[]]> = [
                ['common', keywords.common],
                ['rare', keywords.rare],
                ['missing', keywords.missing],
            ];
            for (const [type, kws] of buckets) {
                if (kws.length === 0) {
                    log.warn(`No ${type} keywords available — skipping`);
                    continue;
                }
                // To keep run time reasonable, take only the first keyword of each bucket.
                const keyword = kws[0];
                for (const dr of dateRanges) {
                    reads.push(await runOne(scheme, env.sampleTenant, keyword, dr, type, null));
                }
            }
        }
    }

    env.runFinishedAt = new Date().toISOString();
    const writes: WriteResult[] = []; // benchWrite.ts produces these separately
    const report: BenchReport = {
        env,
        reads,
        writes,
        autoConclusion: buildAutoConclusion(reads, writes),
    };

    const outDir = path.resolve(process.cwd(), 'reports');
    const paths = await writeReport(report, outDir);
    log.step('Report written');
    log.sub(`Markdown : ${paths.md}`);
    log.sub(`JSON     : ${paths.json}`);
    log.sub(`CSV      : ${paths.csv}`);

    await closeConnection();
}

async function runOne(
    scheme: Scheme,
    tenant: string,
    keyword: string,
    dateRange: DateRange,
    keywordType: 'common' | 'rare' | 'missing' | 'path-value',
    jsonPath: string | null
): Promise<ReadResult> {
    const { sql, params } = scheme.buildQuery({
        tenant,
        keyword,
        dateRange,
        ...(jsonPath ? { path: jsonPath } : {}),
    });
    const compactSql = sql.replace(/\s+/g, ' ').trim();

    log.sub(
        `${scheme.id} | ${keywordType.padEnd(11)} | kw=${truncate(keyword, 24)} | range=${dateRange.label}`
    );

    // Measure latencies.
    let rowsMatched = 0;
    const fn = async (): Promise<void> => {
        const rows = await query<{ id: number }>(compactSql, params);
        rowsMatched = rows.length;
    };
    let samples: number[] = [];
    let explainText: string | null = null;
    try {
        samples = await timeRepeated(fn, config.iterations, config.warmup);

        // Capture EXPLAIN ANALYZE once for the report.
        explainText = await captureExplain(compactSql, params);
    } catch (err) {
        log.error(`Query failed: ${(err as Error).message}`);
    }
    const stats = computeStats(samples);
    log.sub(
        `    rows=${rowsMatched} | P50=${fmtMs(stats.p50)} P95=${fmtMs(stats.p95)} P99=${fmtMs(
            stats.p99
        )} (avg ${fmtMs(stats.avg)})`
    );

    return {
        schemeId: scheme.id,
        schemeName: scheme.name,
        keywordType,
        keyword,
        path: jsonPath,
        dateRange: dateRange.label,
        rowsMatched,
        stats,
        explain: explainText,
    };
}

async function captureExplain(sql: string, params: unknown[]): Promise<string | null> {
    try {
        const conn = await getConnection();
        // EXPLAIN ANALYZE actually executes the query, but only once.
        const [rows] = await conn.query(`EXPLAIN ANALYZE ${sql}`, params);
        const arr = rows as Array<Record<string, string>>;
        return arr.map(r => Object.values(r)[0]).join('\n');
    } catch (err) {
        log.warn(`EXPLAIN ANALYZE failed: ${(err as Error).message}`);
        return null;
    }
}

async function snapshotEnv(): Promise<EnvSnapshot> {
    const [v] = await query<{ v: string }>(`SELECT VERSION() AS v`);
    const [stats] = await query<{
        total_rows: number;
        avg_bytes: number | null;
        max_bytes: number | null;
    }>(
        `SELECT COUNT(*) AS total_rows,
                AVG(LENGTH(requestBody)) AS avg_bytes,
                MAX(LENGTH(requestBody)) AS max_bytes
         FROM ${config.sourceTable}`
    );

    let tenant = config.sampleTenant;
    if (!tenant) {
        const tenants = await query<{ tenant: string; n: number }>(
            `SELECT tenant, COUNT(*) AS n FROM ${config.sourceTable}
             GROUP BY tenant ORDER BY n DESC LIMIT 1`
        );
        tenant = tenants[0]?.tenant ?? '';
    }
    const [tcount] = await query<CountRow>(
        `SELECT COUNT(*) AS n FROM ${config.sourceTable} WHERE tenant = ?`,
        [tenant]
    );

    return {
        mysqlVersion: v.v,
        database: config.db.database,
        sourceTable: config.sourceTable,
        sourceTableRows: stats.total_rows,
        bodyAvgBytes: stats.avg_bytes ?? 0,
        bodyMaxBytes: stats.max_bytes ?? 0,
        sampleTenant: tenant,
        sampleTenantRows: tcount.n,
        benchTablePrefix: config.benchTablePrefix,
        jsonPaths: config.jsonPaths,
        iterations: config.iterations,
        warmup: config.warmup,
        runStartedAt: new Date().toISOString(),
        runFinishedAt: '', // filled in at end
    };
}

function truncate(s: string, n: number): string {
    return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

main().catch(err => {
    log.error(err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
