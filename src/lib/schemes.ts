import { benchTableName, config, pathToColumnSuffix } from './config.js';

/**
 * Each scheme represents one technical approach to searching inside the
 * requestBody JSON column. The benchmark runs every scheme against the
 * same data set and compares latency, scan size and write throughput.
 */
export interface Scheme {
    id: string;
    name: string;
    /** One-paragraph description shown in reports. */
    description: string;
    /** Sibling-table name for this scheme. */
    table: string;
    /** Which kinds of keywords this scheme can be benchmarked with. */
    supports: SchemeSupport[];
    /**
     * Build the SELECT query for a keyword. `extra` carries scheme-specific
     * context — e.g. v3 and v4 use `path` to choose which JSON path/column
     * to query.
     */
    buildQuery: (params: BuildQueryParams) => SqlAndParams;
    /**
     * Idempotent setup statements to run after the table has been cloned
     * from the source table. Used by v4 (generated column + index) and
     * v5 (stringified column + FULLTEXT index).
     */
    setupStatements: (() => SetupStatement[]) | null;
}

export type SchemeSupport = 'common' | 'rare' | 'missing' | 'path-value';

export interface BuildQueryParams {
    tenant: string;
    keyword: string;
    dateRange: DateRange;
    /** Required for path-value schemes (v3, v4). */
    path?: string;
}

export interface SqlAndParams {
    sql: string;
    params: unknown[];
}

export interface DateRange {
    label: string;
    /** Extra WHERE clause fragment (must start with "AND" or be empty). */
    fragment: string;
}

export interface SetupStatement {
    /** Human-readable label used in logs. */
    label: string;
    /** Plain SQL to execute. */
    sql: string;
    /** Optional probe: if it returns truthy, skip this statement (idempotency). */
    skipIf?: () => Promise<boolean>;
}

// ---- Date range presets ----------------------------------------------------

export const dateRanges: DateRange[] = [
    { label: 'all', fragment: '' },
    { label: '7d', fragment: 'AND dateTime > NOW() - INTERVAL 7 DAY' },
    { label: '24h', fragment: 'AND dateTime > NOW() - INTERVAL 1 DAY' },
];

// ---- Helpers ---------------------------------------------------------------

export function pathColumnName(jsonPath: string): string {
    return `reqBody_${pathToColumnSuffix(jsonPath)}`;
}

// ---- Schemes ---------------------------------------------------------------

const v1: Scheme = {
    id: 'v1',
    name: 'v1: CAST(JSON AS CHAR) + LIKE (baseline)',
    description:
        'Stringify the JSON column at query time and apply a SQL LIKE. Zero schema change, zero index. ' +
        'Forces a full table scan with per-row JSON serialization. Closest to the literal "contains" UX users expect.',
    table: benchTableName('v1'),
    supports: ['common', 'rare', 'missing'],
    buildQuery: ({ tenant, keyword, dateRange }) => ({
        sql: `SELECT id FROM ${benchTableName('v1')}
              WHERE tenant = ?
                AND CAST(requestBody AS CHAR) LIKE ?
                ${dateRange.fragment}`,
        params: [tenant, `%${keyword}%`],
    }),
    setupStatements: null,
};

const v2: Scheme = {
    id: 'v2',
    name: 'v2: JSON_SEARCH()',
    description:
        'Use the native JSON_SEARCH function to find a string value inside the JSON document. ' +
        'No index is used — every row is parsed and every string leaf is checked.',
    table: benchTableName('v2'),
    supports: ['common', 'rare', 'missing'],
    buildQuery: ({ tenant, keyword, dateRange }) => ({
        sql: `SELECT id FROM ${benchTableName('v2')}
              WHERE tenant = ?
                AND JSON_SEARCH(requestBody, 'one', ?) IS NOT NULL
                ${dateRange.fragment}`,
        params: [tenant, `%${keyword}%`],
    }),
    setupStatements: null,
};

const v3: Scheme = {
    id: 'v3',
    name: 'v3: ->> path extract (no index)',
    description:
        'Extract a known path with the ->> operator and compare exactly. ' +
        'Requires knowing the path in advance and still does a full table scan unless an index is added (see v4).',
    table: benchTableName('v3'),
    supports: ['path-value'],
    buildQuery: ({ tenant, keyword, dateRange, path }) => {
        if (!path) throw new Error('v3 requires a JSON path');
        return {
            sql: `SELECT id FROM ${benchTableName('v3')}
                  WHERE tenant = ?
                    AND requestBody->>'${path}' = ?
                    ${dateRange.fragment}`,
            params: [tenant, keyword],
        };
    },
    setupStatements: null,
};

const v4: Scheme = {
    id: 'v4',
    name: 'v4: Generated column + B-tree index',
    description:
        'Materialize each predefined JSON path into a STORED generated column and add a (tenant, column) B-tree index. ' +
        'The only scheme that turns body search into an O(log N) index lookup, but only for paths known in advance.',
    table: benchTableName('v4'),
    supports: ['path-value'],
    buildQuery: ({ tenant, keyword, dateRange, path }) => {
        if (!path) throw new Error('v4 requires a JSON path');
        const col = pathColumnName(path);
        return {
            sql: `SELECT id FROM ${benchTableName('v4')}
                  WHERE tenant = ?
                    AND ${col} = ?
                    ${dateRange.fragment}`,
            params: [tenant, keyword],
        };
    },
    setupStatements: () => {
        const out: SetupStatement[] = [];
        for (const path of config.jsonPaths) {
            const col = pathColumnName(path);
            const indexName = `idx_${col}_tenant`;
            out.push({
                label: `add generated column ${col} (path=${path})`,
                sql: `ALTER TABLE ${benchTableName('v4')}
                      ADD COLUMN ${col} VARCHAR(256)
                      GENERATED ALWAYS AS (requestBody->>'${path}') STORED`,
            });
            out.push({
                label: `add index ${indexName}`,
                sql: `CREATE INDEX ${indexName}
                      ON ${benchTableName('v4')} (tenant, ${col})`,
            });
        }
        return out;
    },
};

const v5: Scheme = {
    id: 'v5',
    name: 'v5: Stringified column + FULLTEXT index',
    description:
        'Add a STORED generated column containing the stringified JSON, then create a FULLTEXT index on it. ' +
        'Token-based search (not substring), but the only scheme that gives sub-second free-text body search at scale. ' +
        'Trade-off is write throughput and index storage size.',
    table: benchTableName('v5'),
    supports: ['common', 'rare', 'missing'],
    buildQuery: ({ tenant, keyword, dateRange }) => ({
        sql: `SELECT id FROM ${benchTableName('v5')}
              WHERE tenant = ?
                AND MATCH(requestBodyText) AGAINST (? IN BOOLEAN MODE)
                ${dateRange.fragment}`,
        params: [tenant, keyword],
    }),
    setupStatements: () => [
        {
            label: 'add stringified column requestBodyText',
            sql: `ALTER TABLE ${benchTableName('v5')}
                  ADD COLUMN requestBodyText LONGTEXT
                  GENERATED ALWAYS AS (CAST(requestBody AS CHAR)) STORED`,
        },
        {
            label: 'add FULLTEXT index ftx_requestBodyText',
            sql: `ALTER TABLE ${benchTableName('v5')}
                  ADD FULLTEXT INDEX ftx_requestBodyText (requestBodyText)`,
        },
    ],
};

export const schemes: Scheme[] = [v1, v2, v3, v4, v5];

export function findScheme(id: string): Scheme {
    const s = schemes.find(x => x.id === id);
    if (!s) throw new Error(`Unknown scheme: ${id}`);
    return s;
}
