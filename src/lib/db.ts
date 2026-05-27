import mysql, { Connection } from 'mysql2/promise';

import { config } from './config.js';

let cached: Connection | null = null;

export async function getConnection(): Promise<Connection> {
    if (cached) return cached;
    cached = await mysql.createConnection({
        host: config.db.host,
        port: config.db.port,
        user: config.db.user,
        password: config.db.password,
        database: config.db.database,
        multipleStatements: false,
        // Avoid timezone conversion surprises when comparing dateTime ranges.
        dateStrings: true,
        // Generous timeouts — benchmark queries can be long.
        connectTimeout: 30_000,
    });
    return cached;
}

export async function closeConnection(): Promise<void> {
    if (cached) {
        await cached.end();
        cached = null;
    }
}

/**
 * Run a query and return the rows. Thin wrapper to keep the call sites compact.
 * The generic parameter T is used only to type the returned rows for callers;
 * mysql2's own RowDataPacket brand is bypassed because it forces every row
 * interface to declare a literal constructor.name property.
 */
export async function query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = []
): Promise<T[]> {
    const conn = await getConnection();
    const [rows] = await conn.query(sql, params);
    return rows as unknown as T[];
}

/**
 * Check whether a table exists in the configured database.
 */
export async function tableExists(tableName: string): Promise<boolean> {
    const rows = await query<{ ok: number }>(
        `SELECT 1 AS ok FROM information_schema.tables
         WHERE table_schema = ? AND table_name = ?
         LIMIT 1`,
        [config.db.database, tableName]
    );
    return rows.length > 0;
}

/**
 * Returns whether a column exists on a given table. Useful before issuing
 * ALTER TABLE ADD COLUMN, to make setup idempotent.
 */
export async function columnExists(tableName: string, columnName: string): Promise<boolean> {
    const rows = await query<{ ok: number }>(
        `SELECT 1 AS ok FROM information_schema.columns
         WHERE table_schema = ? AND table_name = ? AND column_name = ?
         LIMIT 1`,
        [config.db.database, tableName, columnName]
    );
    return rows.length > 0;
}

/**
 * Returns whether an index exists on a given table.
 */
export async function indexExists(tableName: string, indexName: string): Promise<boolean> {
    const rows = await query<{ ok: number }>(
        `SELECT 1 AS ok FROM information_schema.statistics
         WHERE table_schema = ? AND table_name = ? AND index_name = ?
         LIMIT 1`,
        [config.db.database, tableName, indexName]
    );
    return rows.length > 0;
}

/**
 * Returns the list of columns on a table that are NOT generated columns.
 *
 * Why this exists: `INSERT INTO sibling SELECT * FROM source` blows up when
 * the source table has GENERATED columns, because the SELECT pulls those
 * generated values and MySQL refuses to let us assign them on the target
 * (the target re-computes them itself). We use this helper to issue an
 * explicit column list in both the INSERT and the SELECT clause.
 *
 * Generated columns are identified by the `EXTRA` field in information_schema
 * containing the substring "GENERATED" (covers both STORED and VIRTUAL).
 */
export async function getNonGeneratedColumns(tableName: string): Promise<string[]> {
    const rows = await query<{ COLUMN_NAME: string; EXTRA: string | null }>(
        `SELECT COLUMN_NAME, EXTRA
         FROM information_schema.columns
         WHERE table_schema = ? AND table_name = ?
         ORDER BY ORDINAL_POSITION`,
        [config.db.database, tableName]
    );
    return rows
        .filter(r => !/GENERATED/i.test(r.EXTRA ?? ''))
        .map(r => r.COLUMN_NAME);
}

/**
 * Count rows in a table. Used to detect "table exists but is empty" so that
 * a re-run of setup after a partial failure can resume and copy data.
 */
export async function countRows(tableName: string): Promise<number> {
    const rows = await query<{ n: unknown }>(`SELECT COUNT(*) AS n FROM ${tableName}`);
    const raw = rows[0]?.n;
    if (raw === null || raw === undefined) return 0;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
}
