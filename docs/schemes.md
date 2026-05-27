# The 5 schemes under test — deep dive

> 🇨🇳 [中文版 / Chinese version](./schemes.zh-CN.md)
>
> Companion docs: [`keywords.md`](./keywords.md) (why the read benchmark uses
> three keyword buckets), [`methodology.md`](./methodology.md) (broader
> measurement design).
>
> 👋 **New to this project?** Read this document first. It's the conceptual
> foundation everything else builds on. The READMEs only give you a one-line
> summary; the trade-offs that drive the recommendation live here.

All five schemes are tested on identical data, in the same MySQL instance,
against the same set of keywords. The only thing that varies is the table
schema and the query SQL — so any difference in latency or write throughput
can be attributed to the scheme itself, not to noise.

## Quick comparison

| Scheme | Schema change? | Index on body? | Best for | Worst for |
|---|---|---|---|---|
| **v1** CAST + LIKE | none | none | "I just want it to work" baseline | latency at any scale |
| **v2** JSON_SEARCH | none | none | "looks like JSON" baseline | usually slower than v1 |
| **v3** `->>` path extract | none | none | known path, no time to add index | latency, same as v1/v2 |
| **v4** Generated col + B-tree | add column + index | yes (B-tree) | known paths, exact match | unknown / free-text queries |
| **v5** Stringified + FULLTEXT | add column + FULLTEXT | yes (FULLTEXT) | free-text body search at scale | write throughput, substring matching |

---

## v1 — `CAST(JSON AS CHAR) + LIKE` (baseline)

The literal "stringify the whole JSON and substring-match it" approach.
Zero schema change, zero index. Closest to the *contains* semantics users
typically expect, but forces a full table scan with per-row JSON
serialization.

### SQL example

```sql
SELECT id
FROM audit_logs_bench_v1
WHERE tenant = 'tenant_X'
  AND CAST(requestBody AS CHAR) LIKE '%abc-123%';
```

### Pros
- Zero schema change, works out of the box.
- True substring matching — easy for users to reason about.

### Cons
- Always a full table scan; cost grows linearly with row count and body size.
- CPU-heavy: every row's JSON must be deserialized then serialized to CHAR.

### Use it as
The baseline that everything else is measured against.

---

## v2 — `JSON_SEARCH()`

Use MySQL's native `JSON_SEARCH(col, 'one', '%kw%')` function to look for
a string value inside the JSON document.

### SQL example

```sql
SELECT id
FROM audit_logs_bench_v2
WHERE tenant = 'tenant_X'
  AND JSON_SEARCH(requestBody, 'one', '%abc-123%') IS NOT NULL;
```

### Pros
- Slightly nicer than v1 because it does not need to stringify the whole row
  into a CHAR buffer first.
- Returns the path where the match occurred (useful for debugging).

### Cons
- Still a full table scan — no index can help.
- Can only match **string** leaves; numbers and booleans are invisible.
- Often *slower* than v1 because it walks every key/value pair in the JSON tree.

### Use it as
A "nicer-looking" baseline. Rarely meaningfully faster than v1.

---

## v3 — `->>` path extract (no index)

When the search key sits at a known JSON path (for example
`requestBody.subscriberId`), extract it with the `->>` operator and
compare directly. No index — yet.

### SQL example

```sql
SELECT id
FROM audit_logs_bench_v3
WHERE tenant = 'tenant_X'
  AND requestBody->>'$.id' = 'abc-123';
```

### Pros
- Cleaner SQL than `JSON_SEARCH` for the common "I know the exact field" case.
- Foundation for v4 — once you know the path, you can add an index for it.

### Cons
- Still a full table scan in this v3 form (no index on a path expression).
- Only works if the user / API has agreed on a fixed path.

### Use it as
The "I know which field I want, but I haven't added an index yet" baseline,
so v4's index benefit is measured against the same query shape.

---

## v4 — Generated column + B-tree index

Materialize a known JSON path into a STORED generated column and add a
B-tree index on `(tenant, generated_column)`. This is the only scheme
that turns body search into an **O(log N) index lookup** instead of a
full scan.

### SQL example

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

### Pros
- The fastest possible read; typical P95 should be 1 ms or less.
- Reuses all of MySQL's existing operators (`=`, `IN`, `BETWEEN`, etc.)
  on the generated column.

### Cons
- Only works for **paths you predefine**. If users want to search by a
  field you didn't index, this scheme can't help them.
- Adds a generated column + a secondary index to a hot table —
  measurable write-throughput penalty (see write benchmark).
- Each new path needs another column + index, and an `ALTER TABLE` on
  a 30M+ row table is not free.

### Use it as
The answer when you have a small set of high-value paths (e.g.
`subscriberId`, `orderId`, `companyId`) that users actually search by.

---

## v5 — Stringified column + FULLTEXT index

Add a generated column that contains the JSON serialized as text, then
create a `FULLTEXT` index on it. This is the only scheme that gives
sub-second **free-text** body search at scale, but it changes the
search semantics (token-based, not substring) and writes are noticeably
heavier.

### SQL example

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

### Important semantic differences from v1

- FULLTEXT is **token-based**. With the default parser, a UUID like
  `abc-123-def` is split on `-` into tokens. `MATCH ... AGAINST ('abc')`
  finds the document; `AGAINST ('bc-12')` does not.
- The default `innodb_ft_min_token_size` is 3, so 1–2 character keywords
  are silently ignored.
- For prefix search use `AGAINST ('abc*' IN BOOLEAN MODE)`.
- For non-ASCII data (CJK), consider `WITH PARSER ngram`.

### Pros
- Real index → orders of magnitude faster than v1/v2/v3 for free-text search.
- Works for arbitrary keywords, not just predefined paths.

### Cons
- Token semantics ≠ substring semantics; the UX needs to explain this.
- ~2× storage cost (original JSON column + stringified column + index).
- Insert throughput drops because FULLTEXT must tokenize and update the
  inverted index on every write.
- Building the FULLTEXT index on a big table takes a long time and can
  block writes during the build.

### Use it as
The realistic in-MySQL option for free-text body search. If even this
scheme can't meet the SLA, that's the trigger to escalate to OpenSearch.

---

## How they map to user-facing search behavior

| User intent | Recommended scheme |
|---|---|
| "Find the audit log with this specific request ID" | already covered by existing `requestId` index — no scheme needed |
| "Find all logs where `body.subscriberId = X`" | **v4** with `$.subscriberId` indexed |
| "Find logs that contain the string `abc` anywhere in the body" | **v5** with FULLTEXT (with caveats about token boundaries) |
| "Find logs that contain the substring `bc-12` anywhere in the body" | **v1 only** truly satisfies this — v5 will miss because the substring crosses a token boundary |

## Anti-patterns to avoid

- Indexing every JSON path "just in case" — every generated column adds
  storage and a write-throughput penalty. Only index paths that have
  evidence of being searched.
- Combining v4 and v5 on the same table without measuring — the
  combined write penalty can exceed the sum of the individual penalties
  because both index maintenance paths run on every INSERT.
- Skipping v1 — even though it's the slowest, you need its number as a
  baseline. Without it, you cannot say "v4 is 1000× faster", only
  "v4 is fast in absolute terms".
