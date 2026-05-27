/**
 * setup.ts — create sibling bench tables (v1..v5), clone data into them,
 * and apply scheme-specific schema changes (generated columns, FULLTEXT
 * indexes, B-tree indexes). Idempotent: existing tables/columns/indexes
 * are skipped, so re-running is safe.
 */
import { config } from './lib/config.js';
import {
    closeConnection,
    columnExists,
    countRows,
    getConnection,
    getNonGeneratedColumns,
    indexExists,
    tableExists,
} from './lib/db.js';
import { log } from './lib/logger.js';
import { schemes } from './lib/schemes.js';

async function main(): Promise<void> {
    log.step('Sibling bench table setup');

    // Confirm source table exists before doing anything.
    if (!(await tableExists(config.sourceTable))) {
        throw new Error(`Source table "${config.sourceTable}" does not exist in ${config.db.database}`);
    }

    // Discover the list of columns we are allowed to INSERT into. Generated
    // columns must be excluded — MySQL computes them itself and refuses an
    // explicit assignment. We compute this once and reuse it for every scheme.
    const insertableColumns = await getNonGeneratedColumns(config.sourceTable);
    if (insertableColumns.length === 0) {
        throw new Error(`Source table "${config.sourceTable}" reports zero columns`);
    }
    log.info(`Source table has ${insertableColumns.length} non-generated columns to copy`);

    for (const scheme of schemes) {
        const table = scheme.table;
        log.step(`Scheme ${scheme.id}: ${scheme.name}`);

        // State machine — three cases:
        //   1. Table doesn't exist            → CREATE LIKE + INSERT
        //   2. Table exists but is empty      → INSERT only (recover from partial setup)
        //   3. Table exists and has rows      → skip CREATE + INSERT
        const exists = await tableExists(table);
        if (!exists) {
            log.info(`Creating ${table} LIKE ${config.sourceTable} ...`);
            await runStatement(`CREATE TABLE ${table} LIKE ${config.sourceTable}`);
            await copyRows(table, insertableColumns);
        } else {
            const existingRows = await countRows(table);
            if (existingRows === 0) {
                log.info(`Table ${table} exists but is empty — copying rows ...`);
                await copyRows(table, insertableColumns);
            } else {
                log.info(
                    `Table ${table} already exists with ${existingRows.toLocaleString()} rows — skipping CREATE/INSERT`
                );
            }
        }

        // Apply scheme-specific schema changes (v4 and v5 only).
        if (scheme.setupStatements) {
            for (const stmt of scheme.setupStatements()) {
                await applySetupStatement(scheme.id, scheme.table, stmt.label, stmt.sql);
            }
        }
    }

    log.step('Setup complete');
    log.info('Next step: `npm run bench:read` and `npm run bench:write` (or `npm run all`)');
    await closeConnection();
}

/**
 * Copy every non-generated column from the source table into the target
 * sibling table. Uses an explicit column list on both sides because the
 * source table contains generated columns (e.g. idType / idValue) that
 * cannot be assigned to the target.
 */
async function copyRows(targetTable: string, insertableColumns: string[]): Promise<void> {
    const colList = insertableColumns.map(c => `\`${c}\``).join(', ');
    const sql = `INSERT INTO ${targetTable} (${colList})
                 SELECT ${colList} FROM ${config.sourceTable}`;
    const t0 = Date.now();
    const conn = await getConnection();
    const [res] = await conn.query(sql);
    const inserted = (res as { affectedRows?: number }).affectedRows ?? 0;
    log.info(`Inserted ${inserted.toLocaleString()} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

/**
 * Apply one setup statement (ALTER TABLE / CREATE INDEX), skipping if the
 * underlying object already exists. We probe the schema instead of trusting
 * the SQL because some MySQL builds throw on duplicate add but others warn.
 */
async function applySetupStatement(
    schemeId: string,
    table: string,
    label: string,
    sql: string
): Promise<void> {
    const trimmed = sql.replace(/\s+/g, ' ').trim();

    // Skip if it's adding a column that already exists.
    const colMatch = trimmed.match(/ADD COLUMN\s+(\w+)/i);
    if (colMatch && (await columnExists(table, colMatch[1]))) {
        log.sub(`[${schemeId}] skip ${label} — column ${colMatch[1]} already exists`);
        return;
    }

    // Skip if it's creating an index that already exists.
    const idxMatch =
        trimmed.match(/^CREATE\s+(?:UNIQUE\s+|FULLTEXT\s+)?INDEX\s+(\w+)/i) ||
        trimmed.match(/ADD\s+(?:UNIQUE\s+|FULLTEXT\s+)?INDEX\s+(\w+)/i);
    if (idxMatch && (await indexExists(table, idxMatch[1]))) {
        log.sub(`[${schemeId}] skip ${label} — index ${idxMatch[1]} already exists`);
        return;
    }

    log.info(`[${schemeId}] ${label} ...`);
    const t0 = Date.now();
    try {
        await runStatement(sql);
        log.sub(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (err) {
        log.error(`Failed: ${(err as Error).message}`);
        throw err;
    }
}

async function runStatement(sql: string): Promise<void> {
    const conn = await getConnection();
    await conn.query(sql);
}

main().catch(err => {
    log.error(err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
