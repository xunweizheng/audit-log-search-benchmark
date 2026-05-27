# 5 种待测方案 — 深度解析

> 🇬🇧 [English version](./schemes.md)
>
> 👋 **第一次接触这个项目？** 请先读这篇。它是整套 benchmark 的概念基础，
> README 里只给一行简介，真正决定推荐结论的所有 trade-off 都在这里。

5 个方案在**同一份数据、同一个 MySQL 实例、同一组 keyword** 上跑。唯一变化
的是表结构和查询 SQL —— 任何延迟和写入吞吐的差异，都归因于方案本身，
而不是噪音。

## 速查对比

| 方案 | 需要改表？ | body 上有索引？ | 适合 | 不适合 |
|---|---|---|---|---|
| **v1** CAST + LIKE | 不需要 | 没有 | "先让它能跑"的基线 | 任何规模下的延迟 |
| **v2** JSON_SEARCH | 不需要 | 没有 | "看起来更 JSON"的基线 | 通常比 v1 还慢 |
| **v3** `->>` path 提取 | 不需要 | 没有 | 已知 path、暂时不加索引 | 延迟（同 v1/v2）|
| **v4** 生成列 + B-tree | 加列 + 索引 | 有（B-tree） | 已知 path 的精确匹配 | 未知 / free-text 查询 |
| **v5** 字符串化 + FULLTEXT | 加列 + FULLTEXT | 有（FULLTEXT） | 规模下的 free-text body 搜索 | 写吞吐、严格 substring |

---

## v1 — `CAST(JSON AS CHAR) + LIKE`（基线）

最朴素的"把整个 JSON 转成字符串再做 substring 匹配"。零 schema 改动、
零索引。最贴合用户期望的 *contains* 语义，但每次都是全表扫 + 每行 JSON
序列化。

### SQL 示例

```sql
SELECT id
FROM audit_logs_bench_v1
WHERE tenant = 'tenant_X'
  AND CAST(requestBody AS CHAR) LIKE '%abc-123%';
```

### 优点
- 零 schema 改动，开箱即用。
- 真正的 substring 匹配，用户直觉一致。

### 缺点
- 永远全表扫，成本随行数和 body 大小线性增长。
- 非常吃 CPU：每一行的 JSON 都要先反序列化再序列化成 CHAR。

### 用作
基线，让其他方案有个比较对象。

---

## v2 — `JSON_SEARCH()`

用 MySQL 原生 `JSON_SEARCH(col, 'one', '%kw%')` 在 JSON 文档里找某个
字符串值。

### SQL 示例

```sql
SELECT id
FROM audit_logs_bench_v2
WHERE tenant = 'tenant_X'
  AND JSON_SEARCH(requestBody, 'one', '%abc-123%') IS NOT NULL;
```

### 优点
- 比 v1 稍优雅一点，不用先把整行 stringify 成 CHAR。
- 能返回命中的 path，对 debug 有用。

### 缺点
- 还是全表扫，没有任何索引能帮上忙。
- **只能匹配字符串值**，对 number / boolean 无效。
- 实际上通常**比 v1 还慢**，因为要遍历 JSON 树的每个键值对。

### 用作
另一种基线。极少能比 v1 显著更快。

---

## v3 — `->>` path 提取（无索引）

当搜索目标在已知 JSON path 上时（例如 `requestBody.subscriberId`），
用 `->>` 操作符提取后直接比较。**暂时不加索引**。

### SQL 示例

```sql
SELECT id
FROM audit_logs_bench_v3
WHERE tenant = 'tenant_X'
  AND requestBody->>'$.id' = 'abc-123';
```

### 优点
- 对"我明确知道要查哪个字段"的场景，SQL 比 `JSON_SEARCH` 干净。
- 是 v4 的基础——一旦确定 path，下一步就能给它加索引。

### 缺点
- 在 v3 这个形态下仍然是全表扫（path 表达式上没有索引）。
- 仅当前端/API 与后端约定了固定 path 才能用。

### 用作
"我知道要哪个字段、但还没加索引"的基线，让 v4 的索引收益能用同样的查询
形态对比。

---

## v4 — 生成列 + B-tree 索引

把已知 JSON path 用 STORED 生成列**物化**出来，再在
`(tenant, generated_column)` 上加 B-tree 索引。这是唯一能把 body 搜索
变成 **O(log N) 索引查找**（而不是全表扫）的方案。

### SQL 示例

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

### 优点
- 极快，P95 通常在 1ms 以内。
- 生成列上可以用 MySQL 全部操作符（`=`、`IN`、`BETWEEN` 等）。

### 缺点
- 只对**事先预定义的 path** 有效。如果用户想搜你没建索引的字段，这个
  方案帮不上忙。
- 给热表加了生成列 + secondary index，**写入吞吐会下降**（看 write
  benchmark）。
- 每多一个 path 就要多一列 + 多一个索引；在 3000 万行的表上
  `ALTER TABLE` 绝不便宜。

### 用作
如果有少量高价值字段（如 `subscriberId`、`orderId`、`companyId`）是
用户实际搜的，这是最快的答案。

---

## v5 — 字符串化列 + FULLTEXT 索引

加一个生成列把整个 JSON 序列化成 text，然后在它上面建 `FULLTEXT` 索引。
这是规模下唯一能做到**亚秒级 free-text body 搜索**的 in-MySQL 方案，
但搜索语义会变（token-based，不是 substring），写入也更重。

### SQL 示例

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

### 和 v1 语义的关键差异

- FULLTEXT 是 **token-based** 分词搜索。默认分词器会把 UUID 形如
  `abc-123-def` 按 `-` 拆成多个 token。`MATCH ... AGAINST ('abc')` 命中，
  `AGAINST ('bc-12')` 不命中。
- 默认 `innodb_ft_min_token_size = 3`，所以 1-2 个字符的关键词**会被
  静默忽略**。
- 想做前缀搜索要用 `AGAINST ('abc*' IN BOOLEAN MODE)`。
- 中日韩等非 ASCII 数据建议用 `WITH PARSER ngram`。

### 优点
- 真正走索引，free-text 搜索比 v1/v2/v3 快几个数量级。
- 任意关键词都能搜，不限于预定义 path。

### 缺点
- token 语义 ≠ substring 语义，UX 上要明确告诉用户。
- 存储开销约 2 倍（原 JSON 列 + 字符串化列 + 索引）。
- 写入吞吐下降明显，因为每次 INSERT 都要做分词 + 更新倒排索引。
- 大表上建 FULLTEXT 索引耗时很长，建索引期间可能阻塞写入。

### 用作
MySQL 体系内做 free-text body 搜索的现实选择。如果连这个方案都达不到
SLA，就是升级到 OpenSearch 的明确信号。

---

## 用户场景到方案的映射

| 用户想做的事 | 推荐方案 |
|---|---|
| "用某个 request ID 找日志" | 已有的 `requestId` 索引就够，不需要任何新方案 |
| "找所有 `body.subscriberId = X` 的日志" | **v4**，在 `$.subscriberId` 上加索引 |
| "找 body 里任意位置含 `abc` 的日志" | **v5** FULLTEXT（注意 token 边界） |
| "找 body 里含子串 `bc-12` 的日志" | **只有 v1 能真正满足**——v5 会因为子串横跨 token 边界而漏掉 |

## 避坑指南

- **不要"以防万一"给每个 JSON path 都建索引** —— 每多一个生成列就多一份
  存储和写吞吐损失。只给真有证据被搜过的 path 建索引。
- **不要不测就同时上 v4 和 v5** —— 合在一起的写损失可能超过单独之和，
  因为每次 INSERT 两条索引维护路径都要走。
- **不要跳过 v1** —— 哪怕它最慢，你也需要它的数字做基线。没有它，
  你只能说"v4 在绝对值上挺快"，没法说"v4 比 v1 快 1000 倍"。
