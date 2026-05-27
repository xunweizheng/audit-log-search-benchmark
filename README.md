# audit-log-search-benchmark

Benchmark and compare five MySQL approaches for searching inside the
`audit_logs.requestBody` JSON column.

This repository exists so that a recommendation on **how to support
request-body search in Audit History** is backed by reproducible numbers
rather than gut feeling.

> 🇨🇳 [中文版 README / Chinese README](./README.zh-CN.md)
>
> 📘 **New to this project? Read [`docs/schemes.md`](./docs/schemes.md) first.**
> It explains what each scheme actually does, with SQL examples and trade-offs.
> The overview below is just a quick reminder.

---

## TL;DR

```bash
git clone https://github.com/xunweizheng/audit-log-search-benchmark.git
cd audit-log-search-benchmark
npm install
cp .env.example .env       # then fill in your DB credentials
npm run inspect            # safe, read-only sanity check
npm run all                # full pipeline; produces reports/run-*.md
```

Output: a Markdown / JSON / CSV report in `reports/` with P50, P95, P99
latencies for every scheme × keyword × date-range, plus inserts/sec for
each scheme.

---

## Why this benchmark exists

The Audit History page in the Portal currently does **not** support
searching the `requestBody` column, because:

- `requestBody` is a `JSON` column with no usable index.
- The generic `buildWhere` helper only emits `LIKE` / `=` / `!=`, which
  do not work meaningfully against JSON.
- Request bodies can be large and the table grows quickly, so a naive
  `LIKE` over the whole table would blow past our 30-second query timeout.

Before introducing a heavier component (OpenSearch, an external
indexing pipeline, or moving Audit Log out of `portalBackend` into a
dedicated NestJS service), we want to see what is actually achievable
**with MySQL alone**.

---

## The 5 schemes at a glance

> Full deep dive with SQL examples, pros, cons and anti-patterns:
> **[`docs/schemes.md`](./docs/schemes.md)**.

| Scheme | One-line summary | Schema change? | Index on body? |
|---|---|---|---|
| **v1** | `CAST(JSON AS CHAR) + LIKE` — baseline, no schema change | none | none |
| **v2** | `JSON_SEARCH()` — native JSON function, no index | none | none |
| **v3** | `->>` path extract — known path, no index | none | none |
| **v4** | Generated column + B-tree — known path, indexed (fast but predefined-only) | column + index | yes (B-tree) |
| **v5** | Stringified column + FULLTEXT — free-text body search at scale (token-based) | column + index | yes (FULLTEXT) |

`v1`, `v2`, `v3` are always full-table scans and serve as baselines.
`v4` and `v5` are the candidate "real" solutions; their trade-offs are
the ones the recommendation is about.

---

## How the benchmark works

The pipeline has five phases, each a TypeScript script under `src/`:

1. **`inspect`** — read-only. Prints MySQL version, source-table size,
   `requestBody` size distribution, tenants and existing indexes.
2. **`setup`** — creates one sibling table per scheme
   (`audit_logs_bench_v1` … `audit_logs_bench_v5`), copies the source
   data into it, then applies scheme-specific schema changes
   (generated columns and indexes for v4 / v5). Idempotent — re-running
   is safe.
3. **`bench:read`** — for every scheme × keyword × date-range, runs
   `WARMUP` warmup queries (discarded) and `ITERATIONS` measured queries.
   Records P50 / P95 / P99 and captures `EXPLAIN ANALYZE` once per
   combination.
4. **`bench:write`** — inserts `WRITE_ITERATIONS` synthetic rows into
   each scheme's sibling table and records inserts/sec. Bench rows are
   deleted at the end so subsequent read benchmarks remain comparable.
5. **`teardown`** — drops all sibling tables. Skipped by default
   (`KEEP_BENCH_TABLES=true`), so you can re-run without paying setup
   cost again.

### Why sibling tables, not the source table?

We never modify `audit_logs`. Schemes v4 / v5 require `ALTER TABLE`,
which would disturb anything else using the dev database. Sibling
tables give us a clean, comparable surface that we can drop on demand.

### Why P95 / P99 and not the average?

A latency average hides tail behavior. If 99% of requests are 100 ms
but 1% take 10 seconds, the average is still 200 ms but the user
experience is unacceptable. P95 / P99 capture what the worst-served
users actually see — what an SLA is usually written against.

---

## Quick start

### Prerequisites
- Node.js 18+ (we use `tsx` to run TypeScript directly)
- A MySQL 8.x instance where you have full DDL rights (setup runs
  `ALTER TABLE` and `CREATE INDEX`)
- Network reachability from your machine to that MySQL instance

### Steps

```bash
git clone https://github.com/xunweizheng/audit-log-search-benchmark.git
cd audit-log-search-benchmark
npm install
cp .env.example .env
# Edit .env and fill in DB_HOST / DB_USER / DB_PASSWORD / DB_DATABASE.

npm run inspect       # 1) read-only sanity check
npm run setup         # 2) create sibling tables + apply schema changes
npm run bench:read    # 3) read latency benchmark
npm run bench:write   # 4) write throughput benchmark
npm run teardown      # 5) (optional) drop sibling tables
# or, all at once:
npm run all
```

Reports land in `reports/run-<timestamp>.{md,json,csv}` and are
intentionally committed so the run history stays reviewable.

---

## Configuration reference (.env)

See `.env.example` for the canonical version. Key knobs:

| Variable | Purpose | Default |
|---|---|---|
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_DATABASE` | Connection | (required) |
| `SOURCE_TABLE` | Source table to clone from | `audit_logs` |
| `BENCH_TABLE_PREFIX` | Sibling-table prefix | `audit_logs_bench_` |
| `ITERATIONS` | Measured runs per query | `200` |
| `WARMUP` | Warmup runs per query (discarded) | `5` |
| `WRITE_ITERATIONS` | Inserts per scheme in the write benchmark | `2000` |
| `SAMPLE_TENANT` | Tenant to focus on. Empty = auto-pick the largest | (empty) |
| `JSON_PATHS` | Paths used by v3 and v4 | `$.id,$.orderId,$.companyId` |
| `KEYWORDS_COMMON`, `KEYWORDS_RARE`, `KEYWORDS_MISSING` | Override keyword auto-sampling | (auto) |
| `KEEP_BENCH_TABLES` | Keep sibling tables after the run | `true` |

---

## How to interpret the report

Each run produces three files in `reports/`:

- **`run-*.md`** — human-readable summary with read / write result tables
  plus an auto-generated heuristic conclusion. **Start here.**
- **`run-*.json`** — full structured data including all latency samples.
- **`run-*.csv`** — flat table for spreadsheet import.

### Reading the read table

```
| Scheme | Keyword type | Keyword       | Path     | Date range | Rows | P50   | P95   | P99   |
|--------|-------------|---------------|----------|-----------|------|-------|-------|-------|
| v1     | common      | order         | -        | all       | 1234 | 1.8s  | 2.1s  | 2.4s  |
| v4     | path-value  | abc-123       | $.id     | all       | 1    | 0.6ms | 1.2ms | 2.1ms |
```

Things to check in order:

1. **P95 for `date_range = all`** — the hardest case. If v4 is
   acceptable here, you've found your answer. If only v5 is acceptable,
   you need a real index.
2. **Compare same scheme across date ranges.** If a scheme is unusable
   for `all` but acceptable for `24h`, the product can enforce a date
   filter and avoid escalating.
3. **Compare `common` vs `missing` for v1 / v2.** `missing` still scans
   the whole table, so its latency reveals raw scan cost independent of
   result-set size.

### Reading the write table

```
| Scheme | Inserts | Elapsed | Inserts/sec | Storage |
|--------|--------:|--------:|------------:|--------:|
| v1     | 2000    | 4.5s    | 444         | 95 MB   |
| v4     | 2000    | 5.1s    | 392 (-12%) | 110 MB  |
| v5     | 2000    | 8.7s    | 230 (-48%) | 180 MB  |
```

The percentage is the delta vs the v1 baseline. A -48% write penalty
is significant for a write-heavy table like `audit_logs` and must be
checked against the current production write QPS before adopting v5.

---

## Repository layout

```
audit-log-search-benchmark/
├── README.md                # this file (EN)
├── README.zh-CN.md          # Chinese version
├── package.json
├── tsconfig.json
├── .env.example             # config template
├── .gitignore
├── src/
│   ├── inspect.ts           # phase 1: read-only environment check
│   ├── setup.ts             # phase 2: create sibling tables + indexes
│   ├── benchRead.ts         # phase 3: read latency benchmark
│   ├── benchWrite.ts        # phase 4: write throughput benchmark
│   ├── teardown.ts          # phase 5: drop sibling tables
│   ├── runAll.ts            # convenience runner for phases 1-4 (+5)
│   └── lib/
│       ├── config.ts        # env parsing + typed config object
│       ├── db.ts            # mysql2 connection helpers
│       ├── num.ts           # safe coercion for mysql2 BIGINT / DECIMAL
│       ├── timer.ts         # hrtime + percentile math
│       ├── logger.ts        # timestamped console logging
│       ├── keywords.ts      # keyword auto-sampler
│       ├── schemes.ts       # definitions of v1..v5
│       └── report.ts        # markdown / json / csv writers
├── reports/                 # benchmark output (committed)
└── docs/
    ├── schemes.md           # 🌟 deep dive of the 5 schemes (English) — read first
    ├── schemes.zh-CN.md     # 🌟 deep dive of the 5 schemes (Chinese)
    ├── keywords.md          # why the read benchmark uses common/rare/missing buckets (EN)
    ├── keywords.zh-CN.md    # same, Chinese
    └── methodology.md       # extra notes on methodology
```

---

## Troubleshooting

**`EXPLAIN ANALYZE` fails with a syntax error.**
You are on MySQL 5.7. `EXPLAIN ANALYZE` requires 8.0+. The other phases
still work, the report will just be missing EXPLAIN snippets.

**FULLTEXT index build hangs for a long time.**
Expected on tables with millions of rows. Run `SHOW PROCESSLIST` in a
second session to confirm progress, and increase
`innodb_buffer_pool_size` if you can.

**`ALTER TABLE ... ADD COLUMN ... GENERATED ALWAYS AS (... STORED)` fails.**
Confirm MySQL is 5.7.6+ (5.7) or any 8.x. On 8.x, also confirm the
target column name doesn't already exist with a different definition.

**Reports show 0 rows matched for v3/v4.**
Either the `JSON_PATHS` you configured don't actually appear in any
`requestBody`, or the sampled value didn't exist in the bench tables.
Check `inspect` output for tenant row counts, then verify the path
manually:

```sql
SELECT requestBody->>'$.id' AS v, COUNT(*)
FROM audit_logs
WHERE requestBody->>'$.id' IS NOT NULL
GROUP BY v ORDER BY COUNT(*) DESC LIMIT 5;
```

**The benchmark is taking forever.**
Lower `ITERATIONS` (e.g. to 50) and `WRITE_ITERATIONS` (e.g. to 500)
for a quick smoke test. The defaults are tuned for a stable P95, not
for speed.

---

## Further reading

- **[`docs/schemes.md`](./docs/schemes.md)** — deep dive of each scheme,
  with SQL examples, pros / cons and user-intent mapping. **Start here.**
- [`docs/keywords.md`](./docs/keywords.md) — why the read benchmark uses
  three keyword buckets (common / rare / missing) and how to read each
  scheme's behavior across them.
- [`docs/methodology.md`](./docs/methodology.md) — why we don't use
  sysbench, why warmup matters, why we measure P95, what we don't
  measure and why.
