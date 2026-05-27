# Keyword buckets — the design behind `common` / `rare` / `missing`

> 🇨🇳 [中文版 / Chinese version](./keywords.zh-CN.md)
>
> Related: [`schemes.md`](./schemes.md) (what each scheme actually does),
> [`methodology.md`](./methodology.md) (broader benchmark design).

## TL;DR

The read benchmark probes each scheme with **9 keywords per run**: 3 common,
3 rare, 3 missing. These are **not** chosen to represent realistic user
searches — they exist to **diagnose what kind of cost limits each scheme**.

Without this three-way split, a single keyword would give you one data point
and you couldn't tell whether a scheme is "scan-bound", "result-set-bound"
or "fully indexed".

---

## What each bucket is

| Bucket | What it is | How the auto-sampler picks it |
|---|---|---|
| **common** | A string that appears **frequently** in your audit logs | From the latest 500 `requestBody` rows, harvest all 4–80-char string values and keep those that appear ≥ 5 times. Take the top 3. |
| **rare** | A string that appears **only once or twice** | Same harvesting pass, but pick the ones with frequency 1 or 2. Take the top 3. |
| **missing** | A string **guaranteed not to exist** | 3 freshly generated UUIDs. |

You can see exactly what was picked in the benchmark log:

```
Sampling latest 500 requestBody rows to derive keywords...
Sampled keywords: 3 common, 3 rare, 3 missing
Keywords — common: ["lotusflaretelecom", "POST", "subscriber-12345"]
Keywords — rare:   ["uuid-xyz...", ...]
Keywords — missing:[random UUID, ...]
```

---

## Why split into three buckets

Because different schemes are sensitive to different things, and a single
keyword can't expose which one is the bottleneck. The three buckets
isolate three independent cost dimensions:

### 1. Scan-bound schemes (v1, v2)
For full-table-scan schemes, the scan cost is **constant** (you always touch
every row), but the **result-set size** still affects total latency (more
rows = more bytes returned to the client).

| keyword | what v1 does | dominant cost |
|---|---|---|
| common (matches 5000 rows) | scan 76K rows, return 5000 | scan + transfer |
| rare (matches 2 rows) | scan 76K rows, return 2 | scan |
| missing (matches 0 rows) | scan 76K rows, return 0 | scan only |

→ If all three latencies are similar, the bottleneck is **the scan itself**.
No amount of careful keyword choice will rescue this scheme.

### 2. Index-driven schemes (v4)
Index-driven cost is dominated by **how many rows actually match**, because
every match still needs an extra page read to fetch the full row.

| keyword | what v4 does | dominant cost |
|---|---|---|
| common (matches 5000 rows) | index probe + 5000 row fetches | result-set bound |
| rare (matches 2 rows) | index probe + 2 fetches | trivially fast |
| missing (matches 0 rows) | index probe, return immediately | fastest |

→ A big gap between `missing` and `common` is **proof the index is doing
its job** — the optimizer is using it to skip rows. If all three are
equally slow, the index is being ignored.

### 3. FULLTEXT schemes (v5)
FULLTEXT is similar to index-driven, with an extra factor: **token frequency**.
A common token has a long inverted-list, so the engine spends more time
walking matching document IDs even before fetching rows.

| keyword | what v5 does |
|---|---|
| common ("order"-class words) | long inverted list, lots of doc IDs to walk |
| rare token | short inverted list, near-instant |
| missing token | inverted-index lookup returns nothing, exits immediately |

→ The gap between `common` and `rare` shows whether FULLTEXT is genuinely
useful **on your data shape**, not just in the abstract.

---

## What you can actually conclude from the report

A few worked examples to read the data:

### Example A — v4 is uniformly fast

```
v4 | common  | P95 = 1.2ms
v4 | rare    | P95 = 0.8ms
v4 | missing | P95 = 0.6ms
```

Sub-millisecond across the board. Conclusion: **the B-tree index on the
generated column works perfectly**, regardless of how many rows match.
v4 is a strong recommendation.

### Example B — v4 fast for missing/rare, slow for common

```
v4 | common  | P95 = 2400ms
v4 | rare    | P95 = 0.8ms
v4 | missing | P95 = 0.6ms
```

A 1000× gap. The index itself is **fine** (see rare/missing), but a common
keyword matches so many rows that fetching them all becomes the bottleneck.
Conclusion: v4 is great for **low-cardinality precise searches** (subscriber
IDs, order IDs), but the product should not encourage users to search by
"order" or other common tokens.

### Example C — v1 is uniformly slow

```
v1 | common  | P95 = 2300ms
v1 | rare    | P95 = 2200ms
v1 | missing | P95 = 2200ms
```

All three nearly identical. Conclusion: **the bottleneck is the full table
scan**, not the result-set size. Two seconds is the floor; no keyword
choice can save v1. Confirms that v1 cannot be the answer.

### Example D — v5 FULLTEXT, common ≫ rare

```
v5 | common  | P95 = 180ms
v5 | rare    | P95 = 12ms
v5 | missing | P95 = 4ms
```

The index is alive (missing/rare are fast), but FULLTEXT's inverted-list
walk gets expensive for common tokens. Conclusion: v5 is usable, but UX
should warn users about searching very common words (or you should
configure stopwords).

---

## How the auto-sampler actually works (under the hood)

The function lives in `src/lib/keywords.ts::autoSampleKeywords`. Pseudocode:

```
sample_size = 500
rows = SELECT requestBody FROM audit_logs
       WHERE requestBody IS NOT NULL AND tenant = <sample tenant>
       ORDER BY id DESC LIMIT sample_size

freq = empty Map<string, count>
for each row:
    parse JSON, recursively visit every string leaf
    if 4 <= leaf.length <= 80:
        freq[leaf] += 1

sorted = freq sorted by count desc
common  = take top 3 strings with count >= 5
rare    = take top 3 strings with count in {1, 2}
missing = generate 3 random UUIDs
```

Two implementation notes:

1. **Why `ORDER BY id DESC` instead of `ORDER BY RAND()`** — the latter
   forces MySQL to put every row in the sort buffer, which blows up on
   tables with multi-MB JSON rows. Reading the latest N is cheap (index
   scan) and is also more representative because recent rows reflect
   current API usage patterns.
2. **Why 4–80 character window** — strings under 4 chars are too noisy
   (single letters, short tokens that won't match the FULLTEXT minimum
   token size of 3 anyway). Strings over 80 chars are usually long IDs or
   tokens that have low semantic value for a benchmark.

---

## Overriding the auto-sampler

If you want to test specific keywords (e.g. PM says "users actually search
by phone number"), edit `.env`:

```env
# Use JSON array form, or comma-separated.
KEYWORDS_COMMON=["13800138000","example@email.com"]
KEYWORDS_RARE=["specific-order-id-xxxx"]
KEYWORDS_MISSING=["definitely-not-in-any-row"]
```

When non-empty, the env value wins and auto-sampling is skipped for that
bucket. You can also override one bucket and leave the others to be
auto-sampled.

---

## One more thing — keyword buckets vs. JSON paths

Schemes v3 and v4 don't use keyword buckets at all; they use **JSON paths**
(`JSON_PATHS` in `.env`) and the benchmark samples a real value for each
path from the data. That's because v3/v4 only answer questions of the form
"is `requestBody.id = X`", not "does the body contain string Y anywhere".
The keyword/path split mirrors the fundamentally different search semantics
of the two scheme families.

See [`schemes.md`](./schemes.md) for the full breakdown of which scheme
serves which user intent.
