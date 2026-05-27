# audit-log-search-benchmark

Benchmark and compare five MySQL approaches for searching inside the
`audit_logs.requestBody` JSON column.

This repository exists so that a recommendation on **how to support
request-body search in Audit History** is backed by reproducible numbers
rather than gut feeling.

> 📖 **中文文档在文件末尾** — [跳到中文版](#中文版)

---

## Table of contents

- [TL;DR](#tldr)
- [Why this benchmark exists](#why-this-benchmark-exists)
- [The 5 schemes under test](#the-5-schemes-under-test)
  - [v1 — `CAST(JSON AS CHAR) + LIKE` (baseline)](#v1--castjson-as-char--like-baseline)
  - [v2 — `JSON_SEARCH()`](#v2--json_search)
  - [v3 — `->>` path extract (no index)](#v3-----path-extract-no-index)
  - [v4 — Generated column + B-tree index](#v4--generated-column--b-tree-index)
  - [v5 — Stringified column + FULLTEXT index](#v5--stringified-column--fulltext-index)
- [How the benchmark works](#how-the-benchmark-works)
- [Quick start](#quick-start)
- [Configuration reference (.env)](#configuration-reference-env)
- [How to interpret the report](#how-to-interpret-the-report)
- [Repository layout](#repository-layout)
- [Troubleshooting](#troubleshooting)
- [中文版](#中文版)

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
searching the `requestBody` column. The reasons are well known:

- `requestBody` is a `JSON` column with no usable index.
- The generic `buildWhere` helper only emits `LIKE` / `=` / `!=`, which
  do not work meaningfully against JSON.
- Request bodies can be large (we have seen ~3 MB rows in dev) and the
  table grows quickly, so a naive `LIKE` over the whole table would
  blow past our 30-second query timeout.

Before deciding to introduce a heavier component (OpenSearch, an
external indexing pipeline, or moving Audit Log out of `portalBackend`
into a dedicated NestJS service), we want to see what is actually
achievable **with MySQL alone**.

This benchmark answers: *given our real data and our real MySQL version,
how fast can each in-database approach be, and what is its cost?*

---

## The 5 schemes under test

All five schemes are tested on identical data, in the same MySQL
instance, against the same set of keywords. The only thing that varies
is the table schema and the query SQL.

### v1 — `CAST(JSON AS CHAR) + LIKE` (baseline)

The literal "stringify the whole JSON and substring-match it" approach.
Zero schema change, zero index. Closest to the *contains* semantics users
typically expect, but forces a full table scan with per-row JSON
serialization.

**SQL example**

```sql
SELECT id
FROM audit_logs_bench_v1
WHERE tenant = 'tenant_X'
  AND CAST(requestBody AS CHAR) LIKE '%abc-123%';
```

**Pros**
- Zero schema change, works out of the box.
- True substring matching — easy for users to reason about.

**Cons**
- Always a full table scan; cost grows linearly with row count and body size.
- CPU-heavy: every row's JSON must be deserialized then serialized to CHAR.

**Use it as**: the baseline that everything else is measured against.

---

### v2 — `JSON_SEARCH()`

Use MySQL's native `JSON_SEARCH(col, 'one', '%kw%')` function to look for
a string value inside the JSON document.

**SQL example**

```sql
SELECT id
FROM audit_logs_bench_v2
WHERE tenant = 'tenant_X'
  AND JSON_SEARCH(requestBody, 'one', '%abc-123%') IS NOT NULL;
```

**Pros**
- Slightly nicer than v1 because it does not need to stringify the whole row
  into a CHAR buffer first.
- Returns the path where the match occurred (useful for debugging).

**Cons**
- Still a full table scan — no index can help.
- Can only match **string** leaves; numbers and booleans are invisible.
- Often *slower* than v1 because it walks every key/value pair in the JSON tree.

**Use it as**: a "nicer-looking" baseline. Rarely meaningfully faster than v1.

---

### v3 — `->>` path extract (no index)

When the search key sits at a known JSON path (for example
`requestBody.subscriberId`), extract it with the `->>` operator and
compare directly. No index — yet.

**SQL example**

```sql
SELECT id
FROM audit_logs_bench_v3
WHERE tenant = 'tenant_X'
  AND requestBody->>'$.id' = 'abc-123';
```

**Pros**
- Cleaner SQL than `JSON_SEARCH` for the common "I know the exact field" case.
- Foundation for v4 — once you know the path, you can add an index for it.

**Cons**
- Still a full table scan in this v3 form (no index on a path expression).
- Only works if the user / API has agreed on a fixed path.

**Use it as**: the "I know which field I want, but I haven't added an index yet"
baseline, so v4's index benefit is measured against the same query shape.

---

### v4 — Generated column + B-tree index

Materialize a known JSON path into a STORED generated column and add a
B-tree index on `(tenant, generated_column)`. This is the only scheme
that turns body search into an **O(log N) index lookup** instead of a
full scan.

**SQL example**

```sql
-- one-time schema change
ALTER TABLE audit_logs_bench_v4
  ADD COLUMN reqBody_id VARCHAR(256)
  GENERATED ALWAYS AS (requestBody->>'$.id') STORED;

CREATE INDEX idx_reqBody_id_tenant
  ON audit_logs_bench_v4 (tenant, reqBody_id);

-- the query becomes an indexed equality
SELECT id
FROM audit_logs_bench_v4
WHERE tenant = 'tenant_X'
  AND reqBody_id = 'abc-123';
```

**Pros**
- The fastest possible read; typical P95 should be 1 ms or less.
- Reuses all of MySQL's existing operators (`=`, `IN`, `BETWEEN`, etc.)
  on the generated column.

**Cons**
- Only works for **paths you predefine**. If users want to search by a
  field you didn't index, this scheme can't help them.
- Adds a generated column + a secondary index to a hot table —
  measurable write-throughput penalty (see write benchmark).
- Each new path needs another column + index, and an `ALTER TABLE` on
  a 30M+ row table is not free.

**Use it as**: the answer when you have a small set of high-value paths
(e.g. `subscriberId`, `orderId`, `companyId`) that users actually search by.

---

### v5 — Stringified column + FULLTEXT index

Add a generated column that contains the JSON serialized as text, then
create a `FULLTEXT` index on it. This is the only scheme that gives
sub-second **free-text** body search at scale, but it changes the
search semantics (token-based, not substring) and writes are noticeably
heavier.

**SQL example**

```sql
-- one-time schema change
ALTER TABLE audit_logs_bench_v5
  ADD COLUMN requestBodyText LONGTEXT
  GENERATED ALWAYS AS (CAST(requestBody AS CHAR)) STORED;

ALTER TABLE audit_logs_bench_v5
  ADD FULLTEXT INDEX ftx_requestBodyText (requestBodyText);

-- query
SELECT id
FROM audit_logs_bench_v5
WHERE tenant = 'tenant_X'
  AND MATCH(requestBodyText) AGAINST ('abc-123' IN BOOLEAN MODE);
```

**Important semantic differences from v1**:

- FULLTEXT is **token-based**. With the default parser, a UUID like
  `abc-123-def` is split on `-` into tokens. `MATCH ... AGAINST ('abc')`
  finds the document; `AGAINST ('bc-12')` does not.
- The default `innodb_ft_min_token_size` is 3, so 1–2 character keywords
  are silently ignored.
- For prefix search use `AGAINST ('abc*' IN BOOLEAN MODE)`.
- For non-ASCII data (CJK), consider `WITH PARSER ngram`.

**Pros**
- Real index → orders of magnitude faster than v1/v2/v3 for free-text search.
- Works for arbitrary keywords, not just predefined paths.

**Cons**
- Token semantics ≠ substring semantics; the UX needs to explain this.
- ~2× storage cost (original JSON column + stringified column + index).
- Insert throughput drops because FULLTEXT must tokenize and update the
  inverted index on every write.
- Building the FULLTEXT index on a big table takes a long time and can
  block writes during the build.

**Use it as**: the realistic in-MySQL option for free-text body search.
If even this scheme can't meet the SLA, that's the trigger to escalate
to OpenSearch.

---

## How the benchmark works

The benchmark proceeds in five phases, each implemented as a TypeScript
script under `src/`:

1. **`inspect`** — read-only. Prints MySQL version, source table size,
   `requestBody` size distribution, top tenants and existing indexes.
   Use this first to confirm you are pointing at the right database.
2. **`setup`** — creates one sibling table per scheme
   (`audit_logs_bench_v1` … `audit_logs_bench_v5`), copies all rows from
   the source table into it, then applies scheme-specific schema changes
   (generated columns and indexes for v4 and v5). Idempotent — re-running
   is safe.
3. **`bench:read`** — for every scheme × keyword × date-range:
   - run `WARMUP` warmup queries (timing discarded)
   - run `ITERATIONS` measured queries
   - record latency samples and compute P50 / P95 / P99
   - run `EXPLAIN ANALYZE` once and capture its output
4. **`bench:write`** — for every scheme, insert `WRITE_ITERATIONS`
   synthetic rows and record inserts/sec. Inserted rows are deleted at
   the end of each scheme so subsequent read benchmarks remain comparable.
5. **`teardown`** — drops all sibling tables. Skipped by default when
   `KEEP_BENCH_TABLES=true`, which lets you re-run the benchmark
   without paying setup time again.

### Why sibling tables and not the source table?

We never modify the source `audit_logs` table. Schemes v4 and v5 require
`ALTER TABLE` to add generated columns and indexes; doing that on the
real table would affect other services using the dev database. Sibling
tables give us a clean, comparable surface that we can drop on demand.

### Why measure P95 / P99 instead of average?

A latency average hides tail behavior. If 99% of requests are 100 ms
but 1% take 10 seconds, the average is still 200 ms but the user
experience is unacceptable. P95 / P99 capture what the worst-served
users actually see, which is what an SLA is usually written against.

### Keyword buckets

Schemes v1, v2 and v5 are tested with three kinds of keywords:

- **common** — a high-frequency string sampled from real data.
  This is the *worst case* for many schemes because lots of rows match.
- **rare** — a string that appears once or twice. Very few matches.
- **missing** — a random UUID. Guaranteed zero matches.

Schemes v3 and v4 are path-based, so they use real values sampled from
the configured JSON paths (`JSON_PATHS` in `.env`).

---

## Quick start

### Prerequisites

- Node.js 18+ (we use `tsx` to run TypeScript directly)
- A MySQL 8.x instance you have full DDL rights on (because `setup`
  runs `ALTER TABLE` and `CREATE INDEX`)
- Network reachability from your machine to that MySQL instance

### Steps

```bash
git clone https://github.com/xunweizheng/audit-log-search-benchmark.git
cd audit-log-search-benchmark
npm install

cp .env.example .env
# Edit .env and fill in DB_HOST / DB_USER / DB_PASSWORD / DB_DATABASE.

# 1) read-only sanity check — confirm version, table, tenants
npm run inspect

# 2) create sibling tables and apply scheme-specific schema changes
#    (this takes several minutes on a large table; mostly the FULLTEXT
#    index build for v5)
npm run setup

# 3) run the read latency benchmark
npm run bench:read

# 4) run the write throughput benchmark
npm run bench:write

# 5) (optional) drop sibling tables when done
npm run teardown

# Convenience: do steps 1-4 in one go
npm run all
```

Reports are written to `reports/run-<timestamp>.{md,json,csv}` and are
intentionally **committed** so the history of runs is reviewable.

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
| `SAMPLE_TENANT` | Tenant to focus the benchmark on. Empty = auto-pick the largest | `` (empty) |
| `JSON_PATHS` | Paths used by v3 and v4 | `$.id,$.orderId,$.companyId` |
| `KEYWORDS_COMMON`, `KEYWORDS_RARE`, `KEYWORDS_MISSING` | Override keyword auto-sampling | `` (auto) |
| `KEEP_BENCH_TABLES` | Keep sibling tables after the run | `true` |

---

## How to interpret the report

Each run produces three files in `reports/`:

- **`run-*.md`** — human-readable summary with tables for read and write
  results plus an auto-generated heuristic conclusion. Look here first.
- **`run-*.json`** — full structured data including all latency samples.
  Useful for ad-hoc post-processing.
- **`run-*.csv`** — flat table suitable for importing into a spreadsheet.

### Reading the read table

```
| Scheme | Keyword type | Keyword       | Path     | Date range | Rows | P50   | P95   | P99   |
|--------|-------------|---------------|----------|-----------|------|-------|-------|-------|
| v1     | common      | order         | -        | all       | 1234 | 1.8s  | 2.1s  | 2.4s  |
| v4     | path-value  | abc-123       | $.id     | all       | 1    | 0.6ms | 1.2ms | 2.1ms |
```

Things to look at, in order:

1. **P95 for `date_range = all`** — that's the hardest case. If even v4
   is acceptable here, you've found your answer. If only v5 is acceptable,
   you'll need a real index.
2. **Compare same scheme across date ranges.** If a scheme is unusable
   for `all` but acceptable for `24h`, the product can enforce a date
   filter and avoid escalating.
3. **Compare `common` vs `missing` for v1 / v2.** A `missing` query
   still scans the whole table, so its latency reveals raw scan cost
   independent of result-set size.

### Reading the write table

```
| Scheme | Inserts | Elapsed | Inserts/sec | Storage |
|--------|--------:|--------:|------------:|--------:|
| v1     | 2000    | 4.5s    | 444         | 95 MB   |
| v4     | 2000    | 5.1s    | 392 (-12%) | 110 MB  |
| v5     | 2000    | 8.7s    | 230 (-48%) | 180 MB  |
```

The percentage in `Inserts/sec` is the delta vs the v1 baseline. A 48%
write penalty is significant for a write-heavy table like audit_logs
and must be checked against the current production write QPS before
adopting v5.

### Auto-generated conclusion

The report ends with a heuristic interpretation that labels each scheme
as ✅ / 🟢 / 🟡 / 🟠 / 🔴 based on its worst-case P95. This is *not* a
substitute for human judgment — it's a starting point.

---

## Repository layout

```
audit-log-search-benchmark/
├── README.md                # this file
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
│       ├── timer.ts         # hrtime + percentile math
│       ├── logger.ts        # timestamped console logging
│       ├── keywords.ts      # keyword auto-sampler
│       ├── schemes.ts       # definitions of v1..v5
│       └── report.ts        # markdown / json / csv writers
├── reports/                 # benchmark output (committed)
└── docs/
    └── methodology.md       # extra notes on methodology
```

---

## Troubleshooting

**`EXPLAIN ANALYZE` fails with a syntax error.**
You are on MySQL 5.7. `EXPLAIN ANALYZE` requires 8.0+. The other phases
still work, but the report will be missing the EXPLAIN snippets.

**FULLTEXT index build hangs for a long time.**
Expected on tables with millions of rows. Run `SHOW PROCESSLIST` in a
second session to confirm it is making progress, and increase
`innodb_buffer_pool_size` if you can.

**`ALTER TABLE ... ADD COLUMN ... GENERATED ALWAYS AS (... STORED)` fails.**
Confirm MySQL is 5.7.6+ (5.7) or any 8.x. On 8.x, also confirm the
target column name does not already exist (setup is idempotent but
something else may have created the column with a different definition).

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
for a quick smoke test. The default values are tuned for a stable P95,
not for speed.

---

---

# 中文版

针对 `audit_logs.requestBody` 这个 JSON 列，对比 5 种 MySQL 搜索方案的
性能。

这个仓库存在的目的，是让"Audit History 是否能支持按 request body
搜索 / 怎么支持"的结论建立在**可复现的真实数字**之上，而不是拍脑袋。

---

## 目录

- [TL;DR](#tldr-1)
- [为什么要做这个 benchmark](#为什么要做这个-benchmark)
- [5 种待测方案](#5-种待测方案)
  - [v1 — `CAST(JSON AS CHAR) + LIKE`（基线）](#v1--castjson-as-char--like基线)
  - [v2 — `JSON_SEARCH()`](#v2--json_search-1)
  - [v3 — `->>` path 提取（无索引）](#v3-----path-提取无索引)
  - [v4 — 生成列 + B-tree 索引](#v4--生成列--b-tree-索引)
  - [v5 — 字符串化列 + FULLTEXT 索引](#v5--字符串化列--fulltext-索引)
- [benchmark 怎么跑](#benchmark-怎么跑)
- [快速开始](#快速开始)
- [配置说明（.env）](#配置说明env)
- [怎么读报告](#怎么读报告)
- [仓库结构](#仓库结构)
- [常见问题](#常见问题)

---

## TL;DR

```bash
git clone https://github.com/xunweizheng/audit-log-search-benchmark.git
cd audit-log-search-benchmark
npm install
cp .env.example .env       # 填上数据库连接信息
npm run inspect            # 只读侦察，0 风险
npm run all                # 跑全套，产物在 reports/run-*.md
```

产物：`reports/` 目录下生成 Markdown / JSON / CSV 三份报告，包含每个
方案 × 每个 keyword × 每个时间范围 的 P50 / P95 / P99 延迟，以及每个
方案的写入吞吐量。

---

## 为什么要做这个 benchmark

Portal 的 Audit History 页面目前 **不支持** 搜索 `requestBody` 列，
原因已经梳理清楚：

- `requestBody` 是 `JSON` 列，**没有可用索引**。
- 通用 `buildWhere` 只会生成 `LIKE` / `=` / `!=`，对 JSON 列没意义。
- request body 可能很大（开发库里见过 ~3 MB 的行），audit_logs 表本身
  增长很快，朴素的 `LIKE` 全表扫必然超过 30s 的查询超时。

在决定是否要引入更重的组件（OpenSearch、独立的 indexing pipeline，
或者把 Audit Log 从 `portalBackend` 抽出到独立的 NestJS service）之前，
我们想先看清楚：**只用 MySQL 本身能做到什么程度**。

这个 benchmark 回答的是：*用我们真实的数据 + 真实的 MySQL 版本，每种
in-database 方案的极限速度是多少、代价是什么？*

---

## 5 种待测方案

5 个方案都在**同一份数据、同一个 MySQL 实例、同一组 keyword** 上跑。
唯一变化的是表结构和查询 SQL。

### v1 — `CAST(JSON AS CHAR) + LIKE`（基线）

最朴素的"把整个 JSON 转成字符串再做 substring 匹配"。零 schema 改动、
零索引。最贴合用户期望的 *contains* 语义，但每次都是全表扫 + 每行 JSON
序列化。

**SQL 示例**

```sql
SELECT id
FROM audit_logs_bench_v1
WHERE tenant = 'tenant_X'
  AND CAST(requestBody AS CHAR) LIKE '%abc-123%';
```

**优点**
- 零 schema 改动，开箱即用。
- 真正的 substring 匹配，用户直觉一致。

**缺点**
- 永远全表扫，成本随行数和 body 大小线性增长。
- 非常吃 CPU：每一行的 JSON 都要先反序列化再序列化成 CHAR。

**用作**：作为基线，让其他方案有个比较对象。

---

### v2 — `JSON_SEARCH()`

用 MySQL 原生 `JSON_SEARCH(col, 'one', '%kw%')` 在 JSON 文档里找某个
字符串值。

**SQL 示例**

```sql
SELECT id
FROM audit_logs_bench_v2
WHERE tenant = 'tenant_X'
  AND JSON_SEARCH(requestBody, 'one', '%abc-123%') IS NOT NULL;
```

**优点**
- 比 v1 稍优雅一点，不用先把整行 stringify 成 CHAR。
- 能返回命中的 path，对 debug 有用。

**缺点**
- 还是全表扫，没有任何索引能帮上忙。
- **只能匹配字符串值**，对 number / boolean 无效。
- 实际上通常**比 v1 还慢**，因为要遍历 JSON 树的每个键值对。

**用作**：另一种基线。极少能比 v1 显著更快。

---

### v3 — `->>` path 提取（无索引）

当搜索目标在已知 JSON path 上时（例如 `requestBody.subscriberId`），
用 `->>` 操作符提取后直接比较。**暂时不加索引**。

**SQL 示例**

```sql
SELECT id
FROM audit_logs_bench_v3
WHERE tenant = 'tenant_X'
  AND requestBody->>'$.id' = 'abc-123';
```

**优点**
- 对"我明确知道要查哪个字段"的场景，SQL 比 `JSON_SEARCH` 干净。
- 是 v4 的基础——一旦确定 path，下一步就能给它加索引。

**缺点**
- 在 v3 这个形态下仍然是全表扫（path 表达式上没有索引）。
- 仅当前端/API 与后端约定了固定 path 才能用。

**用作**："我知道要哪个字段、但还没加索引"的基线，让 v4 的索引收益能
用同样的查询形态对比。

---

### v4 — 生成列 + B-tree 索引

把已知 JSON path 用 STORED 生成列**物化**出来，再在
`(tenant, generated_column)` 上加 B-tree 索引。这是唯一能把 body 搜索
变成 **O(log N) 索引查找**（而不是全表扫）的方案。

**SQL 示例**

```sql
-- 一次性 schema 改动
ALTER TABLE audit_logs_bench_v4
  ADD COLUMN reqBody_id VARCHAR(256)
  GENERATED ALWAYS AS (requestBody->>'$.id') STORED;

CREATE INDEX idx_reqBody_id_tenant
  ON audit_logs_bench_v4 (tenant, reqBody_id);

-- 查询变成普通索引等值
SELECT id
FROM audit_logs_bench_v4
WHERE tenant = 'tenant_X'
  AND reqBody_id = 'abc-123';
```

**优点**
- 极快，P95 通常在 1ms 以内。
- 生成列上可以用 MySQL 全部操作符（`=`、`IN`、`BETWEEN` 等）。

**缺点**
- 只对**事先预定义的 path** 有效。如果用户想搜你没建索引的字段，这个方案
  帮不上忙。
- 给热表加了生成列 + secondary index，**写入吞吐会下降**（看 write benchmark）。
- 每多一个 path 就要多一列 + 多一个索引；在 3000 万行的表上 `ALTER TABLE`
  绝不便宜。

**用作**：如果有少量高价值字段（如 `subscriberId`、`orderId`、`companyId`）
是用户实际搜的，这是最快的答案。

---

### v5 — 字符串化列 + FULLTEXT 索引

加一个生成列把整个 JSON 序列化成 text，然后在它上面建 `FULLTEXT` 索引。
这是规模下唯一能做到**亚秒级 free-text body 搜索**的 in-MySQL 方案，
但搜索语义会变（token-based，不是 substring），写入也更重。

**SQL 示例**

```sql
-- 一次性 schema 改动
ALTER TABLE audit_logs_bench_v5
  ADD COLUMN requestBodyText LONGTEXT
  GENERATED ALWAYS AS (CAST(requestBody AS CHAR)) STORED;

ALTER TABLE audit_logs_bench_v5
  ADD FULLTEXT INDEX ftx_requestBodyText (requestBodyText);

-- 查询
SELECT id
FROM audit_logs_bench_v5
WHERE tenant = 'tenant_X'
  AND MATCH(requestBodyText) AGAINST ('abc-123' IN BOOLEAN MODE);
```

**和 v1 语义的关键差异**：

- FULLTEXT 是 **token-based** 分词搜索。默认分词器会把 UUID 形如
  `abc-123-def` 按 `-` 拆成多个 token。`MATCH ... AGAINST ('abc')` 命中，
  `AGAINST ('bc-12')` 不命中。
- 默认 `innodb_ft_min_token_size = 3`，所以 1-2 个字符的关键词**会被
  静默忽略**。
- 想做前缀搜索要用 `AGAINST ('abc*' IN BOOLEAN MODE)`。
- 中日韩等非 ASCII 数据建议用 `WITH PARSER ngram`。

**优点**
- 真正走索引，free-text 搜索比 v1/v2/v3 快几个数量级。
- 任意关键词都能搜，不限于预定义 path。

**缺点**
- token 语义 ≠ substring 语义，UX 上要明确告诉用户。
- 存储开销约 2 倍（原 JSON 列 + 字符串化列 + 索引）。
- 写入吞吐下降明显，因为每次 INSERT 都要做分词 + 更新倒排索引。
- 大表上建 FULLTEXT 索引耗时很长，建索引期间可能阻塞写入。

**用作**：MySQL 体系内做 free-text body 搜索的现实选择。如果连这个方案
都达不到 SLA，就是升级到 OpenSearch 的明确信号。

---

## benchmark 怎么跑

benchmark 分 5 个阶段，每个对应 `src/` 下的一个 TypeScript 脚本：

1. **`inspect`** — 只读。打印 MySQL 版本、源表大小、`requestBody` 大小
   分布、tenant 排行和现有索引。**第一步先跑这个**，确认连对了库。
2. **`setup`** — 为每个方案建一张姐妹表（`audit_logs_bench_v1` …
   `audit_logs_bench_v5`），从源表复制全部数据，然后应用方案特定的
   schema 改动（v4 的生成列+索引、v5 的字符串化列+FULLTEXT 索引）。
   **幂等**——重复跑安全。
3. **`bench:read`** — 对每个 方案 × keyword × 时间范围：
   - 跑 `WARMUP` 次预热（时间丢弃）
   - 跑 `ITERATIONS` 次测量
   - 采集延迟样本，计算 P50 / P95 / P99
   - 跑一次 `EXPLAIN ANALYZE` 并记录输出
4. **`bench:write`** — 对每个方案，向姐妹表插入 `WRITE_ITERATIONS` 条
   合成数据，记录 inserts/sec。每个方案跑完后会把测试数据删干净，
   保证后续 read benchmark 仍可比较。
5. **`teardown`** — drop 所有姐妹表。当 `KEEP_BENCH_TABLES=true` 时
   默认跳过，方便不重新 setup 就再跑一次。

### 为什么用姐妹表而不直接在源表上跑？

我们**绝不修改源 `audit_logs` 表**。v4 和 v5 需要 `ALTER TABLE` 加
生成列和索引，直接动源表会影响 dev 库上别人的服务。姐妹表是干净的、
可对比的、可随时 drop 的隔离区。

### 为什么测 P95 / P99 而不是平均数？

平均数会**掩盖尾延迟**。如果 99% 的请求是 100ms、1% 是 10s，平均还是
200ms 看着挺好，但用户体验已经崩了。P95 / P99 反映的是"最差体验的那部分
用户"实际感受，这也是 SLA 通常写的对象。

### Keyword 分组

v1、v2、v5 用三种关键词测：

- **common** — 高频字符串，来自真实数据采样。这是**最坏情况**，因为命
  中行很多。
- **rare** — 只出现一两次的字符串。命中极少。
- **missing** — 随机 UUID。保证 0 命中。

v3、v4 是 path-based，会从配置的 JSON path（`.env` 里的 `JSON_PATHS`）
对应数据里采样真实存在的值来测。

---

## 快速开始

### 前置要求

- Node.js 18+（用 `tsx` 直接跑 TS）
- 一个 MySQL 8.x 实例，且**你有完整 DDL 权限**（`setup` 会 `ALTER TABLE`
  和 `CREATE INDEX`）
- 网络上能从你机器访问到这个 MySQL

### 步骤

```bash
git clone https://github.com/xunweizheng/audit-log-search-benchmark.git
cd audit-log-search-benchmark
npm install

cp .env.example .env
# 编辑 .env，填上 DB_HOST / DB_USER / DB_PASSWORD / DB_DATABASE

# 1) 只读侦察，确认版本、表、tenant
npm run inspect

# 2) 建姐妹表 + 应用方案特定 schema 改动
#   （大表上可能要几分钟，主要是 v5 的 FULLTEXT 索引）
npm run setup

# 3) 跑读延迟 benchmark
npm run bench:read

# 4) 跑写吞吐 benchmark
npm run bench:write

# 5) （可选）跑完清理姐妹表
npm run teardown

# 一键全套（1-4 步）
npm run all
```

报告写到 `reports/run-<时间戳>.{md,json,csv}`，**有意提交进 git**，
方便回看历史。

---

## 配置说明（.env）

完整版见 `.env.example`。重要参数：

| 变量 | 用途 | 默认值 |
|---|---|---|
| `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_DATABASE` | 数据库连接 | （必填）|
| `SOURCE_TABLE` | 源表名 | `audit_logs` |
| `BENCH_TABLE_PREFIX` | 姐妹表前缀 | `audit_logs_bench_` |
| `ITERATIONS` | 每个查询的测量次数 | `200` |
| `WARMUP` | 每个查询的预热次数（丢弃） | `5` |
| `WRITE_ITERATIONS` | 每个方案写入测试的 insert 数 | `2000` |
| `SAMPLE_TENANT` | 用哪个 tenant 跑。留空 = 自动选行数最多的 | 空 |
| `JSON_PATHS` | v3、v4 用的 path | `$.id,$.orderId,$.companyId` |
| `KEYWORDS_COMMON` / `KEYWORDS_RARE` / `KEYWORDS_MISSING` | 覆盖自动采样 | 空（自动） |
| `KEEP_BENCH_TABLES` | 跑完是否保留姐妹表 | `true` |

---

## 怎么读报告

每次跑会在 `reports/` 下产出三个文件：

- **`run-*.md`** — 人类可读的总结，读延迟表 + 写吞吐表 + 自动生成的
  启发式结论。**先看这个**。
- **`run-*.json`** — 完整结构化数据，含所有延迟样本，方便后期处理。
- **`run-*.csv`** — 扁平表，可以直接拖进 Excel 画图。

### 读延迟表的读法

```
| Scheme | Keyword type | Keyword       | Path     | Date range | Rows | P50   | P95   | P99   |
|--------|-------------|---------------|----------|-----------|------|-------|-------|-------|
| v1     | common      | order         | -        | all       | 1234 | 1.8s  | 2.1s  | 2.4s  |
| v4     | path-value  | abc-123       | $.id     | all       | 1    | 0.6ms | 1.2ms | 2.1ms |
```

按顺序看：

1. **`date_range = all` 的 P95** —— 最难场景。如果连 v4 都能接受，
   答案就有了；如果只有 v5 能接受，那就需要真索引。
2. **同方案在不同时间范围的对比**。如果某方案 `all` 不行但 `24h` 行，
   产品可以强制用户先选时间范围，绕过升级问题。
3. **v1 / v2 的 `common` vs `missing` 对比**。`missing` 查询照样扫
   全表，所以它的延迟反映"纯扫描成本"，与结果集大小无关。

### 写吞吐表的读法

```
| Scheme | Inserts | Elapsed | Inserts/sec | Storage |
|--------|--------:|--------:|------------:|--------:|
| v1     | 2000    | 4.5s    | 444         | 95 MB   |
| v4     | 2000    | 5.1s    | 392 (-12%) | 110 MB  |
| v5     | 2000    | 8.7s    | 230 (-48%) | 180 MB  |
```

`Inserts/sec` 后面的百分比是相对 v1 基线的差异。对 audit_logs 这种
写密集表来说，-48% 的写性能下降很显著，采纳 v5 之前必须对照生产的
写入 QPS 看看有没有余量。

### 自动结论

报告末尾有启发式解读，用 ✅ / 🟢 / 🟡 / 🟠 / 🔴 给每个方案的最差 P95
打标签。**这只是起点**，不能代替人的判断。

---

## 仓库结构

```
audit-log-search-benchmark/
├── README.md                # 本文件
├── package.json
├── tsconfig.json
├── .env.example             # 配置模板
├── .gitignore
├── src/
│   ├── inspect.ts           # 阶段 1：只读环境检查
│   ├── setup.ts             # 阶段 2：建姐妹表 + 加索引
│   ├── benchRead.ts         # 阶段 3：读延迟 benchmark
│   ├── benchWrite.ts        # 阶段 4：写吞吐 benchmark
│   ├── teardown.ts          # 阶段 5：drop 姐妹表
│   ├── runAll.ts            # 串起 1-4（+5）
│   └── lib/
│       ├── config.ts        # env 解析 + 强类型 config 对象
│       ├── db.ts            # mysql2 连接 helper
│       ├── timer.ts         # hrtime + 分位数计算
│       ├── logger.ts        # 带时间戳的 console 输出
│       ├── keywords.ts      # 关键词自动采样
│       ├── schemes.ts       # 5 个方案的定义
│       └── report.ts        # markdown / json / csv 输出
├── reports/                 # benchmark 输出（入库）
└── docs/
    └── methodology.md       # 方法学补充说明
```

---

## 常见问题

**`EXPLAIN ANALYZE` 报语法错。**
你在 MySQL 5.7。`EXPLAIN ANALYZE` 需要 8.0+。其他阶段照常跑，只是报告里
缺 EXPLAIN 片段。

**FULLTEXT 索引建很久。**
大表（几百万行起）正常现象。在另一个 session 里 `SHOW PROCESSLIST` 确认
进度，如果可能就调大 `innodb_buffer_pool_size`。

**`ALTER TABLE ... ADD COLUMN ... GENERATED ALWAYS AS (... STORED)` 失败。**
确认 MySQL 是 5.7.6+ 或任意 8.x。在 8.x 上还要确认目标列名不存在
（setup 是幂等的，但可能别的东西用同名建了别的定义的列）。

**报告里 v3/v4 显示 0 命中。**
要么你配的 `JSON_PATHS` 在任何 `requestBody` 里都不存在，要么采样到的
值在姐妹表里没有。先看 `inspect` 的 tenant 行数，再手动验一下 path：

```sql
SELECT requestBody->>'$.id' AS v, COUNT(*)
FROM audit_logs
WHERE requestBody->>'$.id' IS NOT NULL
GROUP BY v ORDER BY COUNT(*) DESC LIMIT 5;
```

**benchmark 跑太久。**
快速 smoke test 可以把 `ITERATIONS` 调到 50、`WRITE_ITERATIONS` 调到 500。
默认值是按"P95 稳定"调的，不是为速度调的。
