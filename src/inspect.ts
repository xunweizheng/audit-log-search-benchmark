/**
 * inspect.ts — read-only environment + table inspection.
 * Safe to run anytime. Touches nothing except SELECTs.
 */
import { config } from './lib/config.js';
import { closeConnection, query } from './lib/db.js';
import { log } from './lib/logger.js';
import { toNum, toNumOrNull } from './lib/num.js';

interface VersionRow {
    version: string;
}

// MySQL returns AVG/SUM/DECIMAL/BIGINT as JS strings to avoid precision loss,
// so DB row fields stay `unknown` and we normalize with toNum at use sites.
interface StatsRow {
    total_rows: unknown;
    avg_bytes: unknown;
    max_bytes: unknown;
    total_mb: unknown;
}

interface TenantRow {
    tenant: string;
    n: unknown;
}

interface SpaceRow {
    data_mb: unknown;
    index_mb: unknown;
}

interface IndexRow {
    Key_name: string;
    Seq_in_index: number;
    Column_name: string;
    Cardinality: unknown;
}

async function main(): Promise<void> {
    log.step('Environment inspection');

    const [v] = await query<VersionRow>(`SELECT VERSION() AS version`);
    log.info(`MySQL version: ${v.version}`);
    if (!v.version.startsWith('8.')) {
        log.warn(
            `Some schemes (FULLTEXT on generated columns, EXPLAIN ANALYZE) require MySQL 8.x. ` +
                `Current version may not support them.`
        );
    }

    log.info(`Database: ${config.db.database}`);
    log.info(`Source table: ${config.sourceTable}`);

    const [stats] = await query<StatsRow>(
        `SELECT COUNT(*) AS total_rows,
                AVG(LENGTH(requestBody)) AS avg_bytes,
                MAX(LENGTH(requestBody)) AS max_bytes,
                SUM(LENGTH(requestBody)) / 1024 / 1024 AS total_mb
         FROM ${config.sourceTable}`
    );
    const totalRows = toNum(stats.total_rows);
    log.info(`Total rows: ${totalRows.toLocaleString()}`);
    log.info(`requestBody avg/max: ${fmtBytes(toNumOrNull(stats.avg_bytes))} / ${fmtBytes(toNumOrNull(stats.max_bytes))}`);
    log.info(`requestBody total stored: ${toNum(stats.total_mb).toFixed(2)} MB`);

    const space = await query<SpaceRow>(
        `SELECT ROUND(data_length/1024/1024, 2) AS data_mb,
                ROUND(index_length/1024/1024, 2) AS index_mb
         FROM information_schema.tables
         WHERE table_schema = ? AND table_name = ?`,
        [config.db.database, config.sourceTable]
    );
    if (space.length > 0) {
        log.info(
            `Table size: data ${toNum(space[0].data_mb).toFixed(2)} MB, indexes ${toNum(space[0].index_mb).toFixed(2)} MB`
        );
    }

    log.step('Top tenants by row count');
    const tenants = await query<TenantRow>(
        `SELECT tenant, COUNT(*) AS n
         FROM ${config.sourceTable}
         GROUP BY tenant
         ORDER BY n DESC
         LIMIT 10`
    );
    for (const t of tenants) {
        log.sub(`${t.tenant.padEnd(40)} ${toNum(t.n).toLocaleString()} rows`);
    }
    if (!config.sampleTenant) {
        log.info(`SAMPLE_TENANT is empty in .env — will auto-pick: ${tenants[0]?.tenant ?? '<none>'}`);
    } else {
        log.info(`SAMPLE_TENANT from .env: ${config.sampleTenant}`);
    }

    log.step('Existing indexes on source table');
    const indexes = await query<IndexRow>(`SHOW INDEX FROM ${config.sourceTable}`);
    const byName = new Map<string, IndexRow[]>();
    for (const ix of indexes) {
        const arr = byName.get(ix.Key_name) ?? [];
        arr.push(ix);
        byName.set(ix.Key_name, arr);
    }
    log.info(`Index count: ${byName.size}`);
    for (const [name, parts] of byName) {
        const cols = parts
            .sort((a, b) => a.Seq_in_index - b.Seq_in_index)
            .map(p => p.Column_name)
            .join(' + ');
        log.sub(`${name.padEnd(50)} (${cols})`);
    }

    log.step('Bench config preview');
    log.sub(`bench table prefix : ${config.benchTablePrefix}`);
    log.sub(`json paths         : ${config.jsonPaths.join(', ')}`);
    log.sub(`iterations / warmup: ${config.iterations} / ${config.warmup}`);
    log.sub(`write iterations   : ${config.writeIterations}`);
    log.sub(`keep bench tables  : ${config.keepBenchTables}`);

    log.info('\nInspection complete. Next step: `npm run setup`');
    await closeConnection();
}

function fmtBytes(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return 'N/A';
    if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
    if (value >= 1024) return `${(value / 1024).toFixed(2)} KB`;
    return `${Math.round(value)} B`;
}

main().catch(err => {
    log.error(err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
