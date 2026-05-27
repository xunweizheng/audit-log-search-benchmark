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
import {
    type BenchReport,
    type EnvSnapshot,
    type WriteResult,
    buildAutoConclusion,
    writeReport,
} from './lib/report.js';
import { schemes } from './lib/schemes.js';

interface MaxIdRow {
    max_id: number | null;
}

interface SizeRow {
    data_length: number;
    index_length: number;
}

async function main(): Promise<void> {
    log.step('Write benchmark');

    const env = await snapshotEnv();
    const results: WriteResult[] = [];

    for (const scheme of schemes) {
        log.step(`Scheme ${scheme.id}: ${scheme.name}`);

        const [{ max_id: beforeMax }] = await query<MaxIdRow>(
            `SELECT MAX(id) AS max_id FROM ${scheme.table}`
        );
        const safeBefore = beforeMax ?? 0;

        const conn = await getConnection();
        const t0 = Date.now();
        try {
            for (let i = 0; i < config.writeIterations; i++) {
                const body = JSON.stringify(buildSyntheticBody());
                await conn.query(
                    `INSERT INTO ${scheme.table}
                     (timestamp, absoluteTimestamp, tenant, requestId, apiCall, method,
                      requestBody, dateTime)
                     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
                    [
                        Math.floor(Date.now() / 1000),
                        Math.floor(Date.now() / 1000),
                        env.sampleTenant,
                        randomUUID(),
                        '/bench/insert',
                        'POST',
                        body,
                    ]
                );
                if (i > 0 && i % 500 === 0) {
                    log.sub(`  inserted ${i}/${config.writeIterations}`);
                }
            }
        } catch (err) {
            log.error(`Insert failed at iteration: ${(err as Error).message}`);
        }
        const elapsedMs = Date.now() - t0;
        const insertsPerSec = config.writeIterations / (elapsedMs / 1000);

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
            storageBytes: size ? size.data_length + size.index_length : 0,
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
    const paths = await writeReport(report, outDir);
    log.step('Write report written');
    log.sub(`Markdown: ${paths.md}`);
    log.sub(`JSON    : ${paths.json}`);
    log.sub(`CSV     : ${paths.csv}`);

    await closeConnection();
}

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
        tenant = tenants[0]?.tenant ?? 'unknown';
    }
    const [tcount] = await query<{ n: number }>(
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
        iterations: config.writeIterations,
        warmup: 0,
        runStartedAt: new Date().toISOString(),
        runFinishedAt: '',
    };
}

main().catch(err => {
    log.error(err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
