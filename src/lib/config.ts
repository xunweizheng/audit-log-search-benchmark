import 'dotenv/config';

export interface DatabaseConfig {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
}

export interface KeywordOverrides {
    common: string[];
    rare: string[];
    missing: string[];
}

export interface BenchConfig {
    db: DatabaseConfig;
    sourceTable: string;
    benchTablePrefix: string;
    iterations: number;
    warmup: number;
    writeIterations: number;
    sampleTenant: string | null;
    jsonPaths: string[];
    keywords: KeywordOverrides;
    keepBenchTables: boolean;
}

function required(name: string): string {
    const v = process.env[name];
    if (v === undefined || v === '') {
        throw new Error(`Missing required env var: ${name}`);
    }
    return v;
}

function parseInt10(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number.parseInt(raw, 10);
    if (Number.isNaN(n) || n < 0) {
        throw new Error(`Invalid integer env var ${name}=${raw}`);
    }
    return n;
}

function parseList(raw: string | undefined, separator: RegExp = /\s*,\s*/): string[] {
    if (!raw) return [];
    const trimmed = raw.trim();
    if (trimmed === '') return [];

    // Support either JSON-array form or comma-separated form.
    if (trimmed.startsWith('[')) {
        try {
            const parsed: unknown = JSON.parse(trimmed);
            if (!Array.isArray(parsed)) {
                throw new Error('not an array');
            }
            return parsed.map(v => String(v)).filter(s => s.length > 0);
        } catch (err) {
            throw new Error(`Failed to parse JSON array env: ${trimmed}: ${(err as Error).message}`);
        }
    }
    return trimmed.split(separator).filter(s => s.length > 0);
}

export const config: BenchConfig = {
    db: {
        host: required('DB_HOST'),
        port: parseInt10('DB_PORT', 3306),
        user: required('DB_USER'),
        password: process.env.DB_PASSWORD ?? '',
        database: required('DB_DATABASE'),
    },
    sourceTable: process.env.SOURCE_TABLE?.trim() || 'audit_logs',
    benchTablePrefix: process.env.BENCH_TABLE_PREFIX?.trim() || 'audit_logs_bench_',
    iterations: parseInt10('ITERATIONS', 200),
    warmup: parseInt10('WARMUP', 5),
    writeIterations: parseInt10('WRITE_ITERATIONS', 2000),
    sampleTenant: process.env.SAMPLE_TENANT?.trim() || null,
    jsonPaths: parseList(process.env.JSON_PATHS) || ['$.id', '$.orderId', '$.companyId'],
    keywords: {
        common: parseList(process.env.KEYWORDS_COMMON),
        rare: parseList(process.env.KEYWORDS_RARE),
        missing: parseList(process.env.KEYWORDS_MISSING),
    },
    keepBenchTables: (process.env.KEEP_BENCH_TABLES ?? 'true').toLowerCase() === 'true',
};

// Ensure JSON_PATHS defaulting works even when parseList returns an empty array.
if (config.jsonPaths.length === 0) {
    config.jsonPaths = ['$.id', '$.orderId', '$.companyId'];
}

/**
 * Convert a JSON path like '$.user.name' to a safe column name like 'user_name'.
 * Used to derive generated-column / index names from path expressions.
 */
export function pathToColumnSuffix(path: string): string {
    return path
        .replace(/^\$\.?/, '')
        .replace(/\./g, '_')
        .replace(/[^a-zA-Z0-9_]/g, '');
}

export function benchTableName(schemeId: string): string {
    return `${config.benchTablePrefix}${schemeId}`;
}
