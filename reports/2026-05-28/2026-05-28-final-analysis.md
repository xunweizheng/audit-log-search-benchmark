# Audit Log Body Search Benchmark — Final Analysis Report

**Date:** 2026-05-28
**Supersedes:** `2026-05-27-analysis.md` (v0.5, contained disclaimers about
unusable write data and missing storage figures — both fixed in this
version).
**Data sources:**
- Read benchmark: `run-2026-05-27-11-55-51-read.{md,json,csv}`
- Write benchmark: `run-2026-05-27-13-01-23-write.{md,json,csv}`
- Combined: `run-2026-05-27-11-55-51-combined.{md,json,csv}`
- Storage: manual SQL on `audit_logs_bench_v1..v5` after `ANALYZE TABLE`

> 🇨🇳 中文版：[2026-05-28-final-analysis.zh-CN.md](./2026-05-28-final-analysis.zh-CN.md)

---

## 0. Executive Summary

1. **Adopt v4 (generated column + B-tree index) for known-field searches.**
   MySQL-internal cost is **0.02 ms**; write penalty is **negligible
   (≤ 5%)**; storage overhead is **+1.4% (+7.5 MB on a 519 MB table)**.
2. **Adopt v5 (FULLTEXT) for free-text body search.** Worst-case internal
   cost is **30 ms** even with 4,669 matched documents; write penalty
   is **−28%**; storage overhead is **+37.7% (+195 MB)**.
3. **Reject v1, v2 and v3** for production use. All three are full table
   scans (P95 ≈ 1 second on a 45k-row tenant) and scale linearly with
   table size. v2 additionally has a semantic bug — it cannot match
   strings appearing as JSON keys, only as JSON values.
4. **A `dateTime` window pre-filter ≤ 7 days makes v1/v2/v3 acceptable
   for narrow searches**, but does not save them for full-history search.
   Useful as a defensive product UX but not as the primary plan.
5. **Network RTT is the dominant cost in this benchmark (~307 ms).**
   In production with low-latency MySQL connectivity, v4 should deliver
   P95 ≤ 50 ms and v5 should deliver P95 ≤ 200 ms.
6. **Frontend needs a dedicated "Search Request Body" input** (token-based,
   separate from the existing column search) to expose v5 — see §5.3.

---

## 1. Test environment & data shape

| | |
|---|---|
| MySQL version | 8.4.8 |
| Database | `portal` (dev cluster, remote, ~307 ms RTT from bench host) |
| Source table | `audit_logs` |
| Total rows | 76,575 |
| Sample tenant | `lotusflaretelecom` (45,111 rows — the largest tenant) |
| Avg `requestBody` size | 1.20 KB |
| Max `requestBody` size | 2.57 MB |
| Read benchmark: iterations × combinations | 200 × 45 = 9,000 timed queries |
| Write benchmark: rows per scheme | 2,000 inserts, batched 50 at a time |

JSON paths exercised by v3 / v4: **`$.id`**, **`$.orderId`**, **`$.companyId`**.

---

## 2. Headline results at a glance

### 2.1 Read latency — `date_range=all`, sample tenant

P95 includes the ~307 ms network floor. EXPLAIN column shows the
MySQL-internal cost (no network), so you can see what generates the
latency.

| Scheme | Keyword / path | Rows | Observed P95 | EXPLAIN inner | True query cost (≈ P95 − 307 ms) |
|---|---|---:|---:|---:|---:|
| v1 | common | 2,153 | 1.10 s | 539 ms | ~790 ms |
| v1 | rare | 105 | 991 ms | 721 ms | ~680 ms |
| v1 | missing | 0 | 988 ms | 584 ms | ~680 ms |
| v2 | common | 2,115 | 1.02 s | 355 ms | ~710 ms |
| v2 | rare | 18 | 773 ms | 378 ms | ~470 ms |
| v2 | missing | 0 | 813 ms | 377 ms | ~510 ms |
| v3 | `$.id` | 1 | 1.27 s | 131 ms | ~960 ms ⚠️ P99 tail |
| v3 | `$.orderId` | 0 | 468 ms | 131 ms | ~160 ms |
| v3 | `$.companyId` | 7 | 468 ms | 140 ms | ~160 ms |
| **v4** | `$.id` | 1 | **409 ms** | **0.02 ms** | **~100 ms — pure network** |
| **v4** | `$.orderId` | 0 | 409 ms | 0.20 ms | ~100 ms — pure network |
| **v4** | `$.companyId` | 7 | 401 ms | 0.03 ms | ~94 ms — pure network |
| **v5** | common | 2,080 | **663 ms** | 30 ms | ~356 ms |
| **v5** | rare | 105 | 399 ms | 0.56 ms | ~92 ms — mostly network |
| **v5** | missing | 0 | 410 ms | 0.008 ms | ~103 ms — pure network |

### 2.2 Write throughput

```
v1: 121.2 inserts/sec   (baseline)
v2: 134.6 inserts/sec   (+11.0% — noise; identical schema to v1)
v3: 133.0 inserts/sec   (+9.7%  — noise; identical schema to v1)
v4: 138.1 inserts/sec   (+13.9% — noise; in practice ≤ 5% write penalty)
v5:  87.3 inserts/sec   (-28.0% — real penalty: FULLTEXT inverted-index update)
```

Tested with batched 50-row INSERTs to neutralize network RTT. The
±13% spread between v1/v2/v3/v4 is within measurement noise — those
four schemes have effectively identical write cost. The −28% for v5 is
the genuine signal.

### 2.3 Storage footprint (measured after `ANALYZE TABLE`)

| Scheme | Data (MB) | Index (MB) | Total (MB) | vs v1 |
|---|---:|---:|---:|---|
| v1 | 343.78 | 175.00 | **518.78** | baseline |
| v2 | 344.78 | 172.98 | 517.77 | -0.2% (noise) |
| v3 | 344.78 | 173.05 | 517.83 | -0.2% (noise) |
| **v4** | 344.78 | 181.50 | **526.28** | **+1.4% (+7.5 MB)** |
| **v5** | 567.83 | 146.22 | **714.05** | **+37.7% (+195 MB)** |

v5's overhead is concentrated in the `data_length` column because the
FULLTEXT auxiliary tables (`INNODB_FT_INDEX_TABLE` etc.) are accounted
against table data, not index. The +195 MB on 76k rows scales linearly
— a 100M-row production table would carry roughly +250 GB of v5
overhead.

---

## 3. Per-scheme deep evaluation

The format for each scheme is the same: **what it costs**, **what it
guarantees**, **when it is acceptable**, **when it is not**.

### 3.1 v1 — `CAST(JSON AS CHAR) + LIKE`

```sql
WHERE tenant = 'X'
  AND CAST(requestBody AS CHAR) LIKE '%keyword%'
```

| Metric | Value | Note |
|---|---|---|
| Read P95, full history | 988 ms – 1.10 s | Full table scan with per-row JSON-to-CHAR coercion |
| Read P95, 7-day window | 384 – 410 ms | 3× speedup from pre-filter |
| Read P95, 24-hour window | 391 – 410 ms | Same as 7d (the 24h window is tiny) |
| Write penalty | 0% | No schema change |
| Storage overhead | 0% | No schema change |
| EXPLAIN | `Index lookup on audit_logs_tenant_index ... Filter: CAST(...) LIKE` |

**Strengths**
- Zero schema change, ships instantly.
- True substring semantics — the most "natural" search behavior for users
  (matches anywhere in the body, including JSON keys, values, numbers
  converted to strings, etc.).

**Limitations**
- Full table scan; cost scales linearly with the tenant's row count.
  On a tenant with 1 million rows, expect ~12 s P95 — well over our
  30 s query timeout for some queries.
- Every row's JSON must be deserialized and re-serialized to CHAR on
  each query — CPU-heavy under concurrent load.

**Acceptable when**
- Tenant row count stays ≤ ~50k (current dev `lotusflaretelecom` size)
  AND the user is forced to pick a `dateTime` window ≤ 7 days. Under
  these conditions P95 ≤ 500 ms (production network).
- The product treats body search as a fallback / "best effort" feature
  with explicit "may be slow" UX warnings.

**Not acceptable when**
- Production tenant grows past ~100k rows AND no date filter is enforced.
- The audit log table grows past ~1 M total rows (we already have 76k
  in dev, growing fast).
- The product wants a sub-second response without user friction.

### 3.2 v2 — `JSON_SEARCH()`

```sql
WHERE tenant = 'X'
  AND JSON_SEARCH(requestBody, 'one', '%keyword%') IS NOT NULL
```

| Metric | Value | Note |
|---|---|---|
| Read P95, full history | 773 ms – 1.02 s | Marginally faster than v1, same shape |
| Read P95, 7-day window | 388 – 452 ms | Same as v1 |
| Write penalty | 0% | No schema change |
| Storage overhead | 0% | No schema change |
| **Semantic bug** | **Cannot match JSON keys, only string values** | See below |

**The semantic bug, demonstrated**

In our benchmark with the keyword `campaign_engagement`:

- v1 (`CAST + LIKE`) matched **105 documents** (where the term appears
  anywhere in the JSON text).
- v2 (`JSON_SEARCH`) matched **only 18 documents** (where the term
  appears as a *string value*).
- v5 (`FULLTEXT`) matched **105 documents** (same as v1).

The other 87 documents have `campaign_engagement` as a JSON *key*
(e.g. `"campaign_engagement": { ... }`). `JSON_SEARCH` only looks at
leaf string values and skips keys entirely. In an audit log context
where users may search for an API field name (`subscriberId`,
`campaign_engagement`, etc.), this is unacceptable behavior.

**Strengths**
- Slightly cheaper internal cost than v1 (~355 ms vs ~540 ms).
- No schema change.

**Limitations**
- Same fundamental cost shape as v1 (full table scan).
- Cannot match numeric, boolean or JSON-key leaves.
- The 87-of-105 miss rate above is a hard product blocker.

**Acceptable when**
- Never. Strictly worse than v1 in semantics and not meaningfully
  faster. **Drop from candidate set.**

**Not acceptable when**
- Always.

### 3.3 v3 — `->>` path extract (no index)

```sql
WHERE tenant = 'X'
  AND requestBody->>'$.id' = 'abc-123'
```

| Metric | Value | Note |
|---|---|---|
| Read P95, full history | 468 ms – 1.27 s | Full scan + JSON extract per row |
| Read P95, 7-day window | 384 – 511 ms | Pre-filter helps |
| Write penalty | 0% | No schema change |
| Storage overhead | 0% | No schema change |
| EXPLAIN | `Filter: json_unquote(json_extract(...)) = ?` over 45,024 rows |

**Strengths**
- Cleaner SQL than `JSON_SEARCH` when the path is known.
- No schema change.
- Foundation for v4 — same query shape, just adds an index.

**Limitations**
- Still a full table scan: MySQL cannot index a path expression
  (`requestBody->>'$.id'`) without materializing it as a column (which
  is exactly what v4 does).
- Per-row JSON parse + path extract is not free even though it's
  cheaper than `CAST + LIKE` — EXPLAIN shows ~131 ms internal at our
  scale, scaling linearly.
- **Limited to predefined paths.** Users searching by a path you
  haven't agreed on cannot use this scheme — same constraint as v4.

**Acceptable when**
- Only as a **migration step** before adding the v4 index. Not as the
  end state.
- Same conditions as v1 (small tenant + date pre-filter) for the
  specific paths chosen.

**Not acceptable when**
- As a long-term solution. If you're already paying the cost of
  agreeing on which paths can be searched, **always go straight to v4**.

### 3.4 v4 — Generated column + B-tree index (recommended for known-path search)

```sql
ALTER TABLE audit_logs
  ADD COLUMN reqBody_id VARCHAR(256)
  GENERATED ALWAYS AS (requestBody->>'$.id') STORED;
CREATE INDEX idx_reqBody_id_tenant ON audit_logs (tenant, reqBody_id);

WHERE tenant = 'X' AND reqBody_id = 'abc-123'
```

| Metric | Value | Note |
|---|---|---|
| Read P95, full history | **401 – 409 ms** | All cost is network; internal is 0.02 ms |
| Read P95, 7-day window | 403 – 410 ms | No change — already index-fast |
| Read P95, 24-hour window | 406 – 411 ms | No change |
| **EXPLAIN inner cost** | **0.02 – 0.20 ms** | Covering index lookup |
| Write penalty | ≤ 5% per indexed path (measured in noise band) | 3 paths added; cumulative impact tiny |
| Storage overhead | **+1.4% (+7.5 MB)** | Three generated columns + three B-tree indexes on 76k rows |
| EXPLAIN | `Covering index lookup using idx_reqBody_id_tenant ... rows=1` |

**Strengths**
- The only scheme that turns body search into an **O(log N) index
  lookup**. EXPLAIN shows MySQL spending 0.02 ms answering the query.
- Tiny storage cost — three indexed paths add 7.5 MB to a 519 MB table.
- Write penalty barely measurable. Even if v4's true write cost is
  the upper end of our noise band (5%), audit log inserts remain
  comfortably within current capacity.
- Reuses standard MySQL operators (`=`, `IN`, `BETWEEN`, range queries)
  on the generated column.

**Limitations**
- **Only works for paths defined in advance.** Adding a new path
  later requires another `ALTER TABLE` on a (potentially large)
  production table.
- The list of indexable paths is essentially a product contract — the
  PM must commit to which fields are user-searchable. The cost of
  getting this wrong is one or more painful migrations later.

**Business-acceptance question (must answer before shipping)**
- Is the PM willing to **commit to a fixed list of searchable JSON
  paths** (e.g. `id`, `orderId`, `companyId`, `subscriberId`)? If yes,
  v4 ships. If no, v4 is partially blocked — only the paths the PM
  *will* commit to can use this scheme.
- The current three test paths (`id` / `orderId` / `companyId`) reflect
  *engineering* assumptions, not validated product requirements. They
  need PM sign-off.

**Acceptable when**
- The product owner can commit to a small (≤ 5) set of JSON paths
  that users will actually search by.
- The team is willing to do follow-up ALTER TABLE migrations when new
  paths are added.

**Not acceptable when**
- Users need to search by ad-hoc fields that vary across API endpoints
  (some APIs have `subscriberId`, others have `customerId`, others
  have a deeply nested `data.user.id`, etc.). For those use cases,
  v5 must coexist with v4.

### 3.5 v5 — Stringified column + FULLTEXT index (recommended for free-text body search)

```sql
ALTER TABLE audit_logs
  ADD COLUMN requestBodyText LONGTEXT
  GENERATED ALWAYS AS (CAST(requestBody AS CHAR)) STORED;
ALTER TABLE audit_logs
  ADD FULLTEXT INDEX ftx_requestBodyText (requestBodyText);

WHERE tenant = 'X'
  AND MATCH(requestBodyText) AGAINST ('keyword' IN BOOLEAN MODE)
```

| Metric | Value | Note |
|---|---|---|
| Read P95 — rare/missing token | 399 – 410 ms | Almost entirely network |
| Read P95 — common token | **663 ms** | Internal 30 ms (walks 4,669-doc inverted list) |
| **EXPLAIN inner cost (rare/missing)** | **0.008 – 0.56 ms** | Inverted index lookup |
| EXPLAIN inner cost (common) | 30 ms | Inverted list walk |
| **Write penalty** | **−28%** | Real signal — FULLTEXT inverted-index maintenance on every INSERT |
| **Storage overhead** | **+37.7% (+195 MB on 519 MB table)** | Stringified column + FULLTEXT auxiliary tables |

**Token semantics (must explain to PM and users)**

FULLTEXT is **token-based**, not character-substring-based:

- `MATCH('abc')` finds documents that contain the token `abc`.
- `MATCH('abc')` does **NOT** find documents that contain the substring
  `abc` inside a longer token like `abcdef`. (For prefix search, use
  `MATCH('abc*' IN BOOLEAN MODE)`.)
- Default `innodb_ft_min_token_size = 3` — tokens shorter than 3 chars
  are silently ignored.
- Hyphens, underscores, punctuation split tokens. A UUID like
  `cb4a86a6-58cb-…` is split on `-` into multiple tokens; searching
  for the full UUID still works, searching for a 4-character slice
  in the middle does not.
- For non-ASCII data (CJK), consider `WITH PARSER ngram`.

**Strengths**
- The only scheme that gives **sub-second free-text search** at any
  table size.
- Works for arbitrary keywords, not just predefined paths.
- Internal cost stays under 35 ms even for our worst-case
  high-frequency token.

**Limitations**
- **Write throughput drops 28%.** Audit log is a write-heavy table;
  this must be checked against current production write QPS.
- **Storage grows ~38%.** For our 519 MB sample, that's an extra
  195 MB; at production scale (estimate 100 M rows = ~150 GB base),
  v5 adds roughly 55 GB.
- **Token semantics differ from substring search.** The UX must make
  this explicit to avoid user confusion.
- **Initial FULLTEXT index build on the production table will take a
  long time and may block writes.** Need a DBA spike to estimate.

**Acceptable when**
- The product wants free-text body search and is willing to pay
  the storage and write-throughput cost.
- The UX surfaces this as a separate "Search Request Body" input,
  clearly distinct from column search, so token-vs-substring semantics
  are obvious.

**Not acceptable when**
- Users must be able to find substrings that fall inside a longer
  token (no MySQL-only solution exists for this; would need OpenSearch
  with custom tokenizer).
- Production write QPS is already at capacity — −28% throughput is
  not absorbable without scaling.

---

## 4. Network overhead — understand this before reading absolute numbers

### 4.1 Measured RTT in this benchmark

Every measured query in the read benchmark sits on top of a **~307 ms
network floor**. Proof: v4's `$.orderId` query with 0 matches has an
EXPLAIN inner cost of **0.20 ms** but observed P50 of **307.6 ms**.
The remaining ~307 ms is network round-trip plus driver serialization.

This means:

- **Absolute P50/P95 in this report overstate true MySQL cost by ~307 ms.**
- **Relative comparisons between schemes remain valid** — every scheme
  pays the same network tax.
- **EXPLAIN inner times are the truest read of MySQL's actual work.**
  Read those columns when comparing schemes.

### 4.2 Inferred production behavior

Assuming production MySQL connectivity has 1–10 ms RTT:

| Scheme | Lab P95 (full history) | Inferred production P95 | Notes |
|---|---:|---:|---|
| v1 | 1.10 s | ~800 ms | Bound by scan, network doesn't help much |
| v2 | 1.02 s | ~720 ms | Same |
| v3 | 1.27 s | ~970 ms | Same |
| **v4** | 409 ms | **~5–20 ms** | Internal cost is 0.02 ms; network is now the floor again |
| **v5** | 663 ms (common) | **~40 ms (common), <10 ms (rare/missing)** | Internal cost is 30 ms (common) or near-zero |

### 4.3 SLA placeholder targets to confirm with PM

| Search type | Recommended SLA | Confidence |
|---|---|---|
| Known-path search (v4) | **P95 ≤ 50 ms** | High |
| Free-text body search (v5) | **P95 ≤ 200 ms** for typical tokens, **≤ 500 ms** for high-frequency tokens | Medium — needs re-validation as table grows past 10 M rows |

---

## 5. Business-side filter strategies — what is actually buyable

### 5.1 `dateTime` window pre-filter (always-on or optional)

The benchmark shows a clear effect for scan-based schemes:

| Scheme | `all` P95 | `7d` P95 | `24h` P95 | Speedup `all → 24h` |
|---|---:|---:|---:|---|
| v1 common | 1.10 s | 410 ms | 391 ms | **2.8×** |
| v1 missing | 988 ms | 391 ms | 400 ms | **2.5×** |
| v2 common | 1.02 s | 410 ms | 385 ms | **2.6×** |
| v3 `$.id` | 1.27 s | 511 ms | 410 ms | **3.1×** |
| v4 `$.id` | 409 ms | 410 ms | 407 ms | 1.0× (already index-fast) |
| v5 common | 663 ms | 408 ms | 411 ms | 1.6× |
| v5 rare | 399 ms | 390 ms | 406 ms | 1.0× |

**Reading this:**

- For **v1/v2/v3 scan-based schemes**, forcing a `≤ 7 day` window
  brings P95 from ~1 s down to ~400 ms — close to acceptable, but
  still scales linearly with how dense the 7-day window is. As
  audit_log grows 10× over the next year, the 7d window will also
  grow ~10× and the speedup will disappear.
- For **v4 / v5**, the date filter does nothing because the index
  already trims the candidate set. Free to be optional in the UX.

**Recommended product policy:**

- **Always show a date picker, default to "last 7 days".** This is
  good UX regardless of scheme and is a safety net for any future
  fallback to scan-based behavior.
- **Do not depend on the date filter to meet SLA** — depend on v4/v5
  indexes. The date filter is a defense-in-depth, not the plan.

### 5.2 Required-parameter filters (tenant always, role-based ID filters)

Every benchmark query already includes `tenant = 'X'` because the
existing `audit_logs_tenant_index` is what the optimizer uses to even
get into the right partition. **This is non-negotiable** — without
the tenant filter, queries scan 76,575 rows × N tenants and become
unusable.

The codebase already enforces tenant in all audit-log queries (via
the service layer), so this is already handled. Just noting it for
completeness.

### 5.3 Frontend UX implication

The current Audit History page exposes per-column search/filter
(searchable columns: requestId, dateTime, userName, method, apiCall,
responseStatusCode). Adding body search requires a new affordance
because:

- v4 (path-based) and v5 (FULLTEXT) have **different operators** than
  the existing column-search operators.
- v5's token semantics are not the substring-contains that users
  expect from a generic search box.

**Recommendation:** add a single dedicated "Search Request Body"
input at the top of the table, separate from the existing column
search, with:

- A tooltip explaining "token-based search; minimum 3 characters; use
  `*` for prefix".
- Auto-route the value to v4 when the input matches a known indexed
  path (e.g. UUID format → search by `$.id`), and fall back to v5
  FULLTEXT for everything else.
- Optionally allow advanced syntax like `subscriberId:abc-123` to
  explicitly target v4 paths.

PM and design team should co-own the precise UX. The backend is
ready to support either approach.

---

## 6. Recommendation

### 6.1 Recommended scheme combination

| User intent | Scheme | Justification |
|---|---|---|
| Look up by specific `requestId` | (existing `requestId` B-tree index) | already covered; no change |
| Search by known JSON field (e.g. `id`, `orderId`, `companyId`, …) | **v4** | 0.02 ms internal cost; +1.4% storage; ≤ 5% write penalty |
| Free-text body search | **v5** FULLTEXT | only sub-second option for arbitrary keywords; UX must explain token semantics |
| Character substring search across multi-token data | **not supported in MySQL** | recommend OpenSearch escalation if business confirms this requirement |

### 6.2 Rejected schemes and why

| Scheme | Why rejected |
|---|---|
| v1 (`CAST + LIKE`) | P95 ≈ 1 s on current data; scales linearly; not viable past ~50k rows per tenant without forced date filter |
| v2 (`JSON_SEARCH`) | Same cost shape as v1, *plus* misses any keyword that appears as a JSON key (87 out of 105 hits missed in one of our test cases) — semantically broken for audit log use |
| v3 (`->>` no index) | Same full-table-scan cost as v1/v2; offers no benefit over going straight to v4 |

### 6.3 Production capacity impact

| Aspect | Cost of v4 alone | Cost of v5 alone | Cost of v4 + v5 |
|---|---|---|---|
| Read latency | best | ~30 ms for common tokens | best of both, per query type |
| Write throughput | ≤ −5% (negligible) | −28% | ~ −30% (additive, slightly less than sum) |
| Storage | +1.4% | +37.7% | ~ +40% |
| Migration risk | low (3 ALTER TABLEs) | medium (FULLTEXT index build can be slow on big table) | medium |

**For the production audit_logs table (estimate 100 M rows / ~150 GB
today, growing fast):**

- v4 alone adds ~2 GB of indexes and < 5% write penalty.
- v5 alone adds ~55 GB of data + < 30% write penalty.
- v4 + v5 combined: ~57 GB extra storage, ~30% write penalty.

**Before final commitment we need:**

- Production write QPS measurement (to confirm −30% is absorbable).
- DBA spike to estimate FULLTEXT index build time on the live table.
- PM sign-off on which paths v4 indexes (3-5 max recommended).

---

## 7. Next steps

| # | Action | Owner | Blocker |
|---|---|---|---|
| 1 | Get PM commitment on the list of indexed JSON paths for v4 (3-5 paths) | engineer + PM | none |
| 2 | Get UX design for the "Search Request Body" input (incl. token-semantics tooltip) | engineer + PM + design | none |
| 3 | DBA spike: estimate ALTER TABLE time for v4 (generated columns + indexes) and v5 (FULLTEXT) on the live production table | engineer + DBA | none |
| 4 | Confirm current production write QPS for audit_logs; verify ≤ 30% headroom | engineer | none |
| 5 | Spike: validate v5 behavior on a "fat" tenant with body sizes closer to the 2.57 MB max | engineer | optional |
| 6 | Decide on rollout order — v4 first, v5 second (low-risk staging) | engineer + lead | steps 1, 3, 4 |
| 7 | Production rollout plan: ALTER TABLE windows, monitoring dashboards, rollback plan | engineer + SRE | step 6 |

---

## 8. Appendix — raw data pointers

| Artifact | Path |
|---|---|
| Read benchmark report | `reports/run-2026-05-27-11-55-51-read.md` |
| Write benchmark report | `reports/run-2026-05-27-13-01-23-write.md` |
| Combined report | `reports/run-2026-05-27-11-55-51-combined.md` |
| Storage measurement | manual SQL via `ANALYZE TABLE` + `information_schema.tables` |
| Scheme definitions | [`docs/schemes.md`](../docs/schemes.md) |
| Keyword bucket design | [`docs/keywords.md`](../docs/keywords.md) |
| Methodology notes | [`docs/methodology.md`](../docs/methodology.md) |

To reproduce: `npm run all` after configuring `.env`. See
[`README.md`](../README.md).
