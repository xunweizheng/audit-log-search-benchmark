import { randomUUID } from 'node:crypto';

import { config } from './config.js';
import { query } from './db.js';
import { log } from './logger.js';

export interface KeywordSet {
    common: string[];
    rare: string[];
    missing: string[];
}

/**
 * Pull a sample of requestBody documents from the source table and harvest
 * candidate keywords from them. We use these to make the read benchmark
 * meaningful: testing high-cardinality vs low-cardinality vs zero-hit queries.
 */
export async function autoSampleKeywords(tenant: string | null, sampleSize = 500): Promise<KeywordSet> {
    log.info(`Auto-sampling up to ${sampleSize} requestBody rows to derive keywords...`);

    const tenantFilter = tenant ? `AND tenant = ${escapeStringLiteral(tenant)}` : '';
    const rows = await query<{ requestBody: unknown }>(
        `SELECT requestBody FROM ${config.sourceTable}
         WHERE requestBody IS NOT NULL ${tenantFilter}
         ORDER BY RAND()
         LIMIT ${sampleSize}`
    );

    const freq = new Map<string, number>();
    for (const row of rows) {
        let body: unknown = row.requestBody;
        if (typeof body === 'string') {
            try {
                body = JSON.parse(body);
            } catch {
                continue;
            }
        }
        collectStrings(body, freq);
    }

    const sortedByFreq = [...freq.entries()].sort((a, b) => b[1] - a[1]);

    const common = sortedByFreq
        .filter(([, c]) => c >= 5)
        .slice(0, 3)
        .map(([v]) => v);

    const rare = sortedByFreq
        .filter(([, c]) => c === 1 || c === 2)
        .slice(0, 3)
        .map(([v]) => v);

    const missing = Array.from({ length: 3 }, () => randomUUID());

    log.info(
        `Auto-sampled: ${common.length} common, ${rare.length} rare, ${missing.length} missing keywords`
    );
    return { common, rare, missing };
}

/**
 * Resolve the final keyword set: env overrides win over auto-sampled defaults.
 */
export async function resolveKeywords(tenant: string | null): Promise<KeywordSet> {
    const sampled = await autoSampleKeywords(tenant);
    return {
        common: config.keywords.common.length > 0 ? config.keywords.common : sampled.common,
        rare: config.keywords.rare.length > 0 ? config.keywords.rare : sampled.rare,
        missing: config.keywords.missing.length > 0 ? config.keywords.missing : sampled.missing,
    };
}

/**
 * Pick a few real, non-null values for a JSON path. Used to seed
 * benchmark queries for the path-extract / generated-column schemes.
 * Falls back to a random UUID (which won't be found) when no row has the path.
 */
export async function samplePathValues(
    table: string,
    tenant: string | null,
    jsonPath: string,
    count = 2
): Promise<string[]> {
    const tenantFilter = tenant ? `AND tenant = ${escapeStringLiteral(tenant)}` : '';
    const rows = await query<{ v: string | null }>(
        `SELECT requestBody->>'${jsonPath}' AS v FROM ${table}
         WHERE requestBody IS NOT NULL ${tenantFilter}
           AND requestBody->>'${jsonPath}' IS NOT NULL
           AND requestBody->>'${jsonPath}' <> ''
         ORDER BY RAND()
         LIMIT ${count}`
    );
    const values = rows.map(r => r.v).filter((v): v is string => v !== null && v !== '');
    if (values.length === 0) {
        log.warn(
            `No non-null values found for ${jsonPath} in ${table} — using random UUIDs (zero hits expected)`
        );
        return [randomUUID(), randomUUID()];
    }
    return values;
}

// ---- helpers ---------------------------------------------------------------

function collectStrings(node: unknown, freq: Map<string, number>): void {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
        const trimmed = node.trim();
        // Skip very short or very long strings; they are rarely useful keywords.
        if (trimmed.length >= 4 && trimmed.length <= 80) {
            freq.set(trimmed, (freq.get(trimmed) ?? 0) + 1);
        }
        return;
    }
    if (typeof node === 'object') {
        if (Array.isArray(node)) {
            for (const item of node) collectStrings(item, freq);
        } else {
            for (const value of Object.values(node as Record<string, unknown>)) {
                collectStrings(value, freq);
            }
        }
    }
}

/**
 * Escape a string for use in a SQL literal. We only need this for the few
 * places where we inline a tenant name into a query (because the auto-sampler
 * cannot use parameter binding for ORDER BY / LIMIT in the same statement).
 */
function escapeStringLiteral(s: string): string {
    return `'${s.replace(/'/g, "''")}'`;
}
