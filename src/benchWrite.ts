/**
 * benchWrite.ts — write benchmark.
 *
 * For each sibling table (v1..v5) we insert WRITE_ITERATIONS rows and measure
 * total elapsed time and inserts/sec. Each scheme uses the same generated
 * payload so the only variable is the schema (extra columns, FULLTEXT index).
 *
 * Inserted rows are cleaned up at the end of each scheme so subsequent
 * read benchmarks remain comparable.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { config } from './lib/config.js';
import { closeConnection, getConnection, query } from './lib/db.js';
import { log } from './lib/logger.js';
import { toNum } from './lib/num.js';
import {
    type BenchReport,
    type EnvSnapshot,
    type WriteResult,
    buildAutoConclusion,
    writeReport,
} from './lib/report.js';
import { schemes } from './lib/schemes.js';

interface MaxIdRow {
    max_id: unknown;
}

interface SizeRow {
    data_length: unknown;
    index_length: unknown;
}

async function main(): Promise<BenchReport> {
    log.step('Write benchmark');
    log.info(
        `Inserting ${config.writeIterations.toLocaleString()} rows per scheme in batches of ${config.writeBatchSize}`
    );

    const env = await snapshotEnv();
    const results: WriteResult[] = [];

    for (const scheme of schemes) {
        log.step(`Scheme ${scheme.id}: ${scheme.name}`);

        const [{ max_id: beforeMax }] = await query<MaxIdRow>(
            `SELECT MAX(id) AS max_id FROM ${scheme.table}`
        );
        // MAX(id) can come back as a JS string for BIGINT-promoted results;
        // toNum normalizes that. Fallback 0 handles an empty table.
        const safeBefore = toNum(beforeMax, 0);

        const conn = await getConnection();
        const t0 = Date.now();
        let insertedSoFar = 0;
        try {
            // Batch the inserts so the wall-clock time reflects MySQL's actual
            // write cost rather than the network round-trip per row. With a
            // remote DB, single-row INSERTs are completely dominated by RTT
            // and hide the real per-scheme write penalty (FULLTEXT in
            // particular).
            const batchSize = Math.max(1, config.writeBatchSize);
            for (let i = 0; i < config.writeIterations; i += batchSize) {
                const rowsInBatch = Math.min(batchSize, config.writeIterations - i);
                const placeholders: string[] = [];
                const params: unknown[] = [];
                const nowSec = Math.floor(Date.now() / 1000);
                for (let j = 0; j < rowsInBatch; j++) {
                    placeholders.push('(?, ?, ?, ?, ?, ?, ?, NOW())');
                    params.push(
                        nowSec,
                        nowSec,
                        env.sampleTenant,
                        randomUUID(),
                        '/bench/insert',
                        'POST',
                        JSON.stringify(buildSyntheticBody())
                    );
                }
                await conn.query(
                    `INSERT INTO ${scheme.table}
                     (timestamp, absoluteTimestamp, tenant, requestId, apiCall, method,
                      requestBody, dateTime)
                     VALUES ${placeholders.join(', ')}`,
                    params
                );
                insertedSoFar += rowsInBatch;
                // Light progress beacon every ~10% so long runs are visible.
                if (insertedSoFar % Math.max(batchSize, Math.floor(config.writeIterations / 10)) === 0) {
                    log.sub(`inserted ${insertedSoFar}/${config.writeIterations}`);
                }
            }
        } catch (err) {
            log.error(`Insert failed at iteration ${insertedSoFar}: ${(err as Error).message}`);
        }
        const elapsedMs = Date.now() - t0;
        const actuallyInserted = insertedSoFar > 0 ? insertedSoFar : config.writeIterations;
        const insertsPerSec = actuallyInserted / (elapsedMs / 1000);

        const [size] = await query<SizeRow>(
            `SELECT data_length, index_length
             FROM information_schema.tables
             WHERE table_schema = ? AND table_name = ?`,
            [config.db.database, scheme.table]
        );

        log.info(
            `${scheme.id}: ${config.writeIterations} inserts in ${(elapsedMs / 1000).toFixed(2)}s → ${insertsPerSec.toFixed(1)} inserts/sec`
        );

        results.push({
            schemeId: scheme.id,
            schemeName: scheme.name,
            insertsAttempted: config.writeIterations,
            elapsedMs,
            insertsPerSec,
            // BIGINT columns can be returned as strings; "12+34" would otherwise
            // do string concatenation instead of arithmetic.
            storageBytes: size ? toNum(size.data_length) + toNum(size.index_length) : 0,
        });

        // Clean up bench rows so read benchmarks remain comparable.
        log.sub(`cleaning up ${scheme.id} bench inserts ...`);
        await conn.query(`DELETE FROM ${scheme.table} WHERE id > ?`, [safeBefore]);
    }

    env.runFinishedAt = new Date().toISOString();
    const report: BenchReport = {
        env,
        reads: [],
        writes: results,
        autoConclusion: buildAutoConclusion([], results),
    };

    const outDir = path.resolve(process.cwd(), 'reports');
    const paths = await writeReport(report, outDir, 'write');
    log.step('Write report written');
    log.sub(`Markdown: ${paths.md}`);
    log.sub(`JSON    : ${paths.json}`);
    log.sub(`CSV     : ${paths.csv}`);

    await closeConnection();
    return report;
}

export { main as runWriteBenchmark };

function buildSyntheticBody(): Record<string, unknown> {
    return {
        id: randomUUID(),
        orderId: randomUUID(),
        companyId: randomUUID(),
        action: ['create', 'update', 'delete'][Math.floor(Math.random() * 3)],
        amount: Math.random() * 10_000,
        currency: 'USD',
        metadata: {
            note: `synthetic note ${Math.random().toString(36).slice(2)}`,
            tags: ['bench', 'write-test'],
        },
    };
}

async function snapshotEnv(): Promise<EnvSnapshot> {
    const [v] = await query<{ v: string }>(`SELECT VERSION() AS v`);
    const [stats] = await query<{
        total_rows: unknown;
        avg_bytes: unknown;
        max_bytes: unknown;
    }>(
        `SELECT COUNT(*) AS total_rows,
                AVG(LENGTH(requestBody)) AS avg_bytes,
                MAX(LENGTH(requestBody)) AS max_bytes
         FROM ${config.sourceTable}`
    );

    let tenant = config.sampleTenant;
    if (!tenant) {
        const tenants = await query<{ tenant: string; n: unknown }>(
            `SELECT tenant, COUNT(*) AS n FROM ${config.sourceTable}
             GROUP BY tenant ORDER BY n DESC LIMIT 1`
        );
        tenant = tenants[0]?.tenant ?? 'unknown';
    }
    const [tcount] = await query<{ n: unknown }>(
        `SELECT COUNT(*) AS n FROM ${config.sourceTable} WHERE tenant = ?`,
        [tenant]
    );

    return {
        mysqlVersion: v.v,
        database: config.db.database,
        sourceTable: config.sourceTable,
        sourceTableRows: toNum(stats.total_rows),
        bodyAvgBytes: toNum(stats.avg_bytes),
        bodyMaxBytes: toNum(stats.max_bytes),
        sampleTenant: tenant,
        sampleTenantRows: toNum(tcount.n),
        benchTablePrefix: config.benchTablePrefix,
        jsonPaths: config.jsonPaths,
        iterations: config.writeIterations,
        warmup: 0,
        runStartedAt: new Date().toISOString(),
        runFinishedAt: '',
    };
}

// Only auto-run when invoked directly (e.g. `tsx src/benchWrite.ts`).
// When imported by runAll.ts, the parent decides when to call us.
import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    main().catch(err => {
        log.error(err.message);
        if (err.stack) console.error(err.stack);
        process.exit(1);
    });
}
