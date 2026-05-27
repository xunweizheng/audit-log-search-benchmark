# Methodology notes

Extra context that doesn't belong in the README but is worth recording
so that anyone re-running the benchmark gets the same answers.

## Why we don't use sysbench / mysqlslap

Both are excellent tools but they assume you want to throw a fixed
workload at the database and watch QPS / throughput numbers. We don't
care about TPC-C-style benchmarks here — we care about the **latency
distribution of a single search query under each scheme**, with full
control over warmup, parameter sampling and which exact query the
benchmark issues. A Node.js script gives us that control with much
less ceremony.

## Why each query is timed in a single Node.js process with serial calls

Concurrency interacts with the buffer pool and the InnoDB lock manager,
which makes latency comparisons across schemes hard to interpret. By
issuing queries one at a time from a single connection, we isolate the
"how fast can this scheme answer one query" question and avoid
contaminating it with concurrency artifacts.

A separate concurrency-aware benchmark would be a reasonable follow-up
once a scheme is shortlisted, but it should answer a different question
("can scheme X serve N concurrent requests without falling over"), not
this one.

## Why warmup matters

The first query of a session against a cold buffer pool can be 10×–100×
slower than subsequent runs because pages have to be read from disk
into memory. We discard the first `WARMUP` runs precisely so that the
measured P50 / P95 / P99 reflect the steady-state performance — what
users will actually feel after the system has been running for a while.

## Why the keyword type matters

For schemes like v1 and v2 that always do a full table scan, the
latency depends on **both** the scan cost (constant for a given table)
**and** the result set size (variable). A keyword that matches 50% of
rows can be measurably slower to return than a keyword that matches 0
rows, even though both touch every row. Splitting the test into
common / rare / missing buckets exposes this.

For v4 (indexed equality), the result set size is the dominant factor;
a query that matches 1 row is much faster than one that matches 50k
rows, even though both use the same index. Sampling real path values
for v3 and v4 surfaces this realistically.

## Why we capture EXPLAIN ANALYZE

`EXPLAIN ANALYZE` confirms that the optimizer is making the choices we
expect. Common gotchas:

- v4 sometimes refuses the index if the optimizer's row estimate is
  off; an `EXPLAIN ANALYZE` snippet showing `Index lookup on ... using ...`
  is the proof that the index is in fact being used.
- v5 sometimes picks a different execution plan when combined with
  `dateTime` range conditions; the snippet reveals whether FULLTEXT
  is the driving access or just a filter.

The snippet is captured once per (scheme, keyword, date range) tuple
and embedded in the markdown report so the same evidence is available
to anyone reading the result.

## What we deliberately do NOT measure

- **Concurrency / contention.** Single-threaded only; see note above.
- **Cold-cache performance.** Warmup hides it on purpose.
- **Replica lag / read consistency.** All tests run against the primary.
- **OpenSearch / Elasticsearch.** Out of scope for this MySQL-only spike.
- **Query plan stability.** We run on a static data set; what we see
  may differ from production where the optimizer has to deal with
  changing statistics.

## How to add a new scheme

1. Add a new `Scheme` object in `src/lib/schemes.ts` with:
   - a unique `id` (e.g. `v6`)
   - the table name (use `benchTableName('v6')` for consistency)
   - the `supports` array (which keyword buckets it accepts)
   - a `buildQuery` function
   - optional `setupStatements` if it needs schema changes
2. Append it to the exported `schemes` array.
3. Run `npm run setup` again — the sibling table will be created and
   the setup statements applied.
4. `npm run bench:read` / `npm run bench:write` will automatically
   include the new scheme.

## How to add a new JSON path

Edit `JSON_PATHS` in `.env`, then rerun `npm run setup` (it's
idempotent — existing v4 columns are left in place; new ones are
added).
