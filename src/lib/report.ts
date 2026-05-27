import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { toNum } from './num.js';
import type { Stats } from './timer.js';
import { fmtMs } from './timer.js';

// ---- Data models -----------------------------------------------------------

export interface EnvSnapshot {
    mysqlVersion: string;
    database: string;
    sourceTable: string;
    sourceTableRows: number;
    bodyAvgBytes: number;
    bodyMaxBytes: number;
    sampleTenant: string;
    sampleTenantRows: number;
    benchTablePrefix: string;
    jsonPaths: string[];
    iterations: number;
    warmup: number;
    runStartedAt: string;
    runFinishedAt: string;
}

export interface ReadResult {
    schemeId: string;
    schemeName: string;
    keywordType: 'common' | 'rare' | 'missing' | 'path-value';
    keyword: string;
    path: string | null;
    dateRange: string;
    rowsMatched: number;
    stats: Stats;
    explain: string | null;
}

export interface WriteResult {
    schemeId: string;
    schemeName: string;
    insertsAttempted: number;
    elapsedMs: number;
    insertsPerSec: number;
    storageBytes: number;
}

export interface BenchReport {
    env: EnvSnapshot;
    reads: ReadResult[];
    writes: WriteResult[];
    /** Free-form auto-generated text appended at the end of the markdown report. */
    autoConclusion: string;
}

// ---- File output -----------------------------------------------------------

export interface OutputPaths {
    md: string;
    json: string;
    csv: string;
}

export async function writeReport(report: BenchReport, outDir: string): Promise<OutputPaths> {
    await mkdir(outDir, { recursive: true });

    const stamp = report.env.runStartedAt.replace(/[:T]/g, '-').replace(/\.\d+Z?$/, '').replace(/Z$/, '');
    const base = path.join(outDir, `run-${stamp}`);

    const paths: OutputPaths = {
        md: `${base}.md`,
        json: `${base}.json`,
        csv: `${base}.csv`,
    };

    await writeFile(paths.json, JSON.stringify(report, null, 2), 'utf8');
    await writeFile(paths.csv, toCsv(report), 'utf8');
    await writeFile(paths.md, toMarkdown(report), 'utf8');

    return paths;
}

// ---- CSV -------------------------------------------------------------------

function toCsv(report: BenchReport): string {
    const headers = [
        'scheme_id',
        'scheme_name',
        'keyword_type',
        'keyword',
        'path',
        'date_range',
        'rows_matched',
        'count',
        'min_ms',
        'max_ms',
        'avg_ms',
        'p50_ms',
        'p95_ms',
        'p99_ms',
    ];
    const lines: string[] = [headers.join(',')];
    for (const r of report.reads) {
        const row = [
            r.schemeId,
            csvEscape(r.schemeName),
            r.keywordType,
            csvEscape(r.keyword),
            csvEscape(r.path ?? ''),
            r.dateRange,
            r.rowsMatched,
            r.stats.count,
            r.stats.min.toFixed(3),
            r.stats.max.toFixed(3),
            r.stats.avg.toFixed(3),
            r.stats.p50.toFixed(3),
            r.stats.p95.toFixed(3),
            r.stats.p99.toFixed(3),
        ];
        lines.push(row.join(','));
    }
    return lines.join('\n');
}

function csvEscape(v: string): string {
    if (v.includes(',') || v.includes('"') || v.includes('\n')) {
        return `"${v.replace(/"/g, '""')}"`;
    }
    return v;
}

// ---- Markdown --------------------------------------------------------------

function toMarkdown(report: BenchReport): string {
    const { env, reads, writes, autoConclusion } = report;
    const parts: string[] = [];

    parts.push(`# Audit Log Body Search Benchmark — ${env.runStartedAt}\n`);
    parts.push(`## Environment\n`);
    parts.push(
        [
            `- **MySQL version**: \`${env.mysqlVersion}\``,
            `- **Database**: \`${env.database}\``,
            `- **Source table**: \`${env.sourceTable}\` (${env.sourceTableRows.toLocaleString()} rows; avg body ${humanBytes(env.bodyAvgBytes)}, max ${humanBytes(env.bodyMaxBytes)})`,
            `- **Sample tenant**: \`${env.sampleTenant}\` (${env.sampleTenantRows.toLocaleString()} rows for this tenant)`,
            `- **Bench tables prefix**: \`${env.benchTablePrefix}\``,
            `- **JSON paths tested (v3, v4)**: ${env.jsonPaths.map(p => `\`${p}\``).join(', ')}`,
            `- **Iterations**: ${env.iterations}, **Warmup**: ${env.warmup}`,
            `- **Started**: ${env.runStartedAt}`,
            `- **Finished**: ${env.runFinishedAt}`,
        ].join('\n')
    );
    parts.push('\n');

    parts.push(`## Read Benchmark Results\n`);
    parts.push(`Each row = one (scheme × keyword × date range) combination, ${env.iterations} iterations each.\n`);
    parts.push('| Scheme | Keyword type | Keyword | Path | Date range | Rows matched | P50 | P95 | P99 | Avg |');
    parts.push('|---|---|---|---|---|---:|---:|---:|---:|---:|');
    for (const r of reads) {
        parts.push(
            `| ${r.schemeId} | ${r.keywordType} | \`${truncate(r.keyword, 32)}\` | ${
                r.path ? `\`${r.path}\`` : '-'
            } | ${r.dateRange} | ${r.rowsMatched} | ${fmtMs(r.stats.p50)} | ${fmtMs(
                r.stats.p95
            )} | ${fmtMs(r.stats.p99)} | ${fmtMs(r.stats.avg)} |`
        );
    }
    parts.push('\n');

    parts.push(`## Write Benchmark Results\n`);
    parts.push('| Scheme | Inserts attempted | Elapsed | Inserts/sec | Index/data size |');
    parts.push('|---|---:|---:|---:|---:|');
    const baselineWps = writes.find(w => w.schemeId === 'v1')?.insertsPerSec ?? 0;
    for (const w of writes) {
        const delta =
            baselineWps > 0 && w.schemeId !== 'v1'
                ? ` (${((w.insertsPerSec / baselineWps - 1) * 100).toFixed(1)}%)`
                : '';
        parts.push(
            `| ${w.schemeId} | ${w.insertsAttempted.toLocaleString()} | ${(w.elapsedMs / 1000).toFixed(2)}s | ${w.insertsPerSec.toFixed(
                1
            )}${delta} | ${humanBytes(w.storageBytes)} |`
        );
    }
    parts.push('\n');

    parts.push(`## Scheme Descriptions\n`);
    for (const r of dedupBy(reads, x => x.schemeId)) {
        parts.push(`### ${r.schemeName}\n`);
        // Description is duplicated across reads; emit once per scheme. We do
        // not re-import schemes.ts here to keep this module decoupled.
    }
    parts.push('See `README.md` for the full description of each scheme.\n');

    parts.push(`## EXPLAIN snippets\n`);
    parts.push('<details><summary>Click to expand</summary>\n');
    parts.push('```');
    for (const r of reads) {
        if (!r.explain) continue;
        parts.push(`-- ${r.schemeId} | ${r.keywordType} | ${truncate(r.keyword, 24)} | ${r.dateRange}`);
        parts.push(r.explain);
        parts.push('');
    }
    parts.push('```');
    parts.push('</details>\n');

    parts.push(`## Auto-generated conclusion\n`);
    parts.push(autoConclusion);
    parts.push('\n');

    return parts.join('\n');
}

function humanBytes(bytes: number): string {
    // Coerce defensively — callers may forward DB-returned BIGINT strings.
    const n = toNum(bytes);
    if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(2)} KB`;
    return `${Math.round(n)} B`;
}

function truncate(s: string, n: number): string {
    return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function dedupBy<T, K>(arr: T[], key: (item: T) => K): T[] {
    const seen = new Set<K>();
    const out: T[] = [];
    for (const item of arr) {
        const k = key(item);
        if (!seen.has(k)) {
            seen.add(k);
            out.push(item);
        }
    }
    return out;
}

// ---- Conclusion ------------------------------------------------------------

/**
 * Cheap heuristic to give the reader a starting interpretation. Looks at each
 * scheme's worst P95 with date_range=all (the hardest case) and labels it.
 */
export function buildAutoConclusion(reads: ReadResult[], writes: WriteResult[]): string {
    const lines: string[] = [];
    const allRanges = reads.filter(r => r.dateRange === 'all');

    const grouped = new Map<string, ReadResult[]>();
    for (const r of allRanges) {
        const arr = grouped.get(r.schemeId) ?? [];
        arr.push(r);
        grouped.set(r.schemeId, arr);
    }

    lines.push(`> Heuristic interpretation (date_range=all, worst-case P95 per scheme).`);
    lines.push('');
    const schemeIds = ['v1', 'v2', 'v3', 'v4', 'v5'];
    for (const id of schemeIds) {
        const rows = grouped.get(id) ?? [];
        if (rows.length === 0) continue;
        const worst = rows.reduce<ReadResult | null>(
            (acc, r) => (acc === null || r.stats.p95 > acc.stats.p95 ? r : acc),
            null
        );
        if (!worst) continue;
        const label =
            worst.stats.p95 < 100
                ? '✅ FAST (<100ms)'
                : worst.stats.p95 < 500
                  ? '🟢 GOOD (<500ms)'
                  : worst.stats.p95 < 2000
                    ? '🟡 ACCEPTABLE (<2s)'
                    : worst.stats.p95 < 10_000
                      ? '🟠 SLOW (>2s)'
                      : '🔴 UNUSABLE (>10s)';
        lines.push(`- **${id}** worst P95 = ${fmtMs(worst.stats.p95)} ${label}`);
    }

    lines.push('');
    const baseWps = writes.find(w => w.schemeId === 'v1')?.insertsPerSec ?? 0;
    if (baseWps > 0) {
        lines.push(`> Write throughput impact (baseline v1 = ${baseWps.toFixed(0)} inserts/sec).`);
        lines.push('');
        for (const w of writes) {
            if (w.schemeId === 'v1') continue;
            const ratio = (w.insertsPerSec / baseWps - 1) * 100;
            lines.push(
                `- **${w.schemeId}**: ${w.insertsPerSec.toFixed(0)} inserts/sec (${ratio.toFixed(1)}% vs baseline)`
            );
        }
    }
    return lines.join('\n');
}
