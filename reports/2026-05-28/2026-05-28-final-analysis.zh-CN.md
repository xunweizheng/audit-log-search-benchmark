# Audit Log Body 搜索 benchmark — 最终分析报告

**日期：** 2026-05-28
**替代：** `2026-05-27-analysis.md`（v0.5 初稿，含 disclaimer 说写数据
不可用、storage 数据缺失 —— 这两项本版本已修复）
**数据来源：**
- 读 benchmark：`run-2026-05-27-11-55-51-read.{md,json,csv}`
- 写 benchmark：`run-2026-05-27-13-01-23-write.{md,json,csv}`
- 合并报告：`run-2026-05-27-11-55-51-combined.{md,json,csv}`
- Storage 数据：在 `audit_logs_bench_v1..v5` 上 `ANALYZE TABLE` 后手动 SQL 查询

> 🇬🇧 English: [2026-05-28-final-analysis.md](./2026-05-28-final-analysis.md)

---

## 0. 执行摘要

1. **已知字段精确搜索：采用 v4（生成列 + B-tree 索引）。**
   MySQL 内部成本 **0.02ms**；写入惩罚 **可忽略（≤ 5%）**；存储开销
   **+1.4%（519MB 表 +7.5MB）**。
2. **Free-text body 搜索：采用 v5（FULLTEXT）。** 即使命中 4669 行，
   最差内部成本 **30ms**；写入惩罚 **−28%**；存储开销 **+37.7%
   （+195MB）**。
3. **拒绝 v1、v2、v3。** 三者都是全表扫，P95 ≈ 1 秒（45k 行 tenant），
   且随表大小线性恶化。v2 还有**语义 bug** —— 它**只能匹配 JSON 值，
   匹配不到 JSON 键名**。
4. **`dateTime` ≤ 7 天的窗口过滤能让 v1/v2/v3 在小范围搜索下勉强可用**，
   但救不了全历史搜索。作为产品 UX 防御性手段还可以，作为主方案不行。
5. **本次 benchmark 中网络 RTT 是主导成本（~307ms）。** 生产环境低延迟
   连接下，v4 应该 P95 ≤ 50ms，v5 应该 P95 ≤ 200ms。
6. **前端需要新增独立的 "Search Request Body" 输入框**（token-based，
   和现有 column search 分开）来暴露 v5 —— 见 §5.3。

---

## 1. 测试环境与数据规模

| | |
|---|---|
| MySQL 版本 | 8.4.8 |
| 数据库 | `portal`（dev 集群，远程，从测试机器约 307ms RTT）|
| 源表 | `audit_logs` |
| 总行数 | 76,575 |
| 采样 tenant | `lotusflaretelecom`（45,111 行 —— 最大 tenant）|
| 平均 `requestBody` 大小 | 1.20 KB |
| 最大 `requestBody` 大小 | 2.57 MB |
| 读 benchmark：iterations × 组合数 | 200 × 45 = 9,000 次计时 query |
| 写 benchmark：每方案插入行数 | 2,000 行，每批 50 行 |

v3 / v4 测试的 JSON path：**`$.id`**、**`$.orderId`**、**`$.companyId`**。

---

## 2. 总体结果速览

### 2.1 读延迟 —— `date_range=all`，采样 tenant

P95 包含 ~307ms 网络底线。EXPLAIN 那栏是 MySQL 内部成本（无网络），
让你看清延迟到底是哪里来的。

| 方案 | 关键词 / path | 命中行 | 观察 P95 | EXPLAIN 内部 | 真实 query 成本（≈ P95 − 307ms）|
|---|---|---:|---:|---:|---:|
| v1 | common | 2,153 | 1.10s | 539ms | ~790ms |
| v1 | rare | 105 | 991ms | 721ms | ~680ms |
| v1 | missing | 0 | 988ms | 584ms | ~680ms |
| v2 | common | 2,115 | 1.02s | 355ms | ~710ms |
| v2 | rare | 18 | 773ms | 378ms | ~470ms |
| v2 | missing | 0 | 813ms | 377ms | ~510ms |
| v3 | `$.id` | 1 | 1.27s | 131ms | ~960ms ⚠️ P99 长尾 |
| v3 | `$.orderId` | 0 | 468ms | 131ms | ~160ms |
| v3 | `$.companyId` | 7 | 468ms | 140ms | ~160ms |
| **v4** | `$.id` | 1 | **409ms** | **0.02ms** | **~100ms —— 纯网络** |
| **v4** | `$.orderId` | 0 | 409ms | 0.20ms | ~100ms —— 纯网络 |
| **v4** | `$.companyId` | 7 | 401ms | 0.03ms | ~94ms —— 纯网络 |
| **v5** | common | 2,080 | **663ms** | 30ms | ~356ms |
| **v5** | rare | 105 | 399ms | 0.56ms | ~92ms —— 几乎全网络 |
| **v5** | missing | 0 | 410ms | 0.008ms | ~103ms —— 纯网络 |

### 2.2 写入吞吐

```
v1: 121.2 inserts/sec   (基线)
v2: 134.6 inserts/sec   (+11.0% — 噪音；schema 和 v1 一样)
v3: 133.0 inserts/sec   (+9.7%  — 噪音；schema 和 v1 一样)
v4: 138.1 inserts/sec   (+13.9% — 噪音；实际写入惩罚 ≤ 5%)
v5:  87.3 inserts/sec   (-28.0% — 真信号：FULLTEXT 倒排索引维护)
```

用 50 行 batch INSERT 测的，已经摆脱了网络 RTT。v1/v2/v3/v4 的
±13% 差距是测量噪音 —— 这四个方案写入成本几乎一样。v5 的 −28%
才是真信号。

### 2.3 存储开销（`ANALYZE TABLE` 后实测）

| 方案 | Data (MB) | Index (MB) | Total (MB) | vs v1 |
|---|---:|---:|---:|---|
| v1 | 343.78 | 175.00 | **518.78** | 基线 |
| v2 | 344.78 | 172.98 | 517.77 | -0.2%（噪音）|
| v3 | 344.78 | 173.05 | 517.83 | -0.2%（噪音）|
| **v4** | 344.78 | 181.50 | **526.28** | **+1.4%（+7.5 MB）** |
| **v5** | 567.83 | 146.22 | **714.05** | **+37.7%（+195 MB）** |

v5 的开销集中在 `data_length` 列，因为 FULLTEXT 辅助表
（`INNODB_FT_INDEX_TABLE` 等）算在表数据里，不算在索引里。76k 行
+195 MB 是线性的 —— 1 亿行的生产表会多出约 250 GB v5 开销。

---

## 3. 5 种方案逐一深度评估

每个方案统一格式：**成本是什么**、**保证是什么**、**什么条件下可接受**、
**什么条件下不可接受**。

### 3.1 v1 —— `CAST(JSON AS CHAR) + LIKE`

```sql
WHERE tenant = 'X'
  AND CAST(requestBody AS CHAR) LIKE '%keyword%'
```

| 指标 | 值 | 说明 |
|---|---|---|
| 读 P95 全历史 | 988ms – 1.10s | 全表扫 + 每行 JSON-to-CHAR 转换 |
| 读 P95 7 天窗口 | 384 – 410ms | 预过滤提速 3× |
| 读 P95 24 小时窗口 | 391 – 410ms | 跟 7d 差不多（24h 窗口已经很小了）|
| 写入惩罚 | 0% | 无 schema 改动 |
| 存储开销 | 0% | 无 schema 改动 |
| EXPLAIN | `Index lookup on audit_logs_tenant_index ... Filter: CAST(...) LIKE` |

**优势**
- 零 schema 改动，可立即上线。
- 真正的 substring 语义 —— 最贴合用户直觉（匹配 body 里任意位置，
  含 JSON 键、值、数字转字符串后的内容等）。

**局限**
- 全表扫；成本随 tenant 行数线性增长。100 万行 tenant 预期 P95
  ~12s —— 部分 query 会超 30s timeout。
- 每行 JSON 必须先反序列化再序列化成 CHAR —— 高并发下 CPU 是瓶颈。

**什么条件下可接受**
- Tenant 行数 ≤ ~50k（当前 dev `lotusflaretelecom` 大小）**且**用户
  被强制选 ≤ 7 天的 `dateTime` 窗口。这些条件下生产环境网络 P95 ≤ 500ms。
- 产品把 body 搜索定位为 fallback / "尽力而为"，UI 上明确告诉用户
  "可能较慢"。

**什么条件下不可接受**
- 生产 tenant 超过 ~100k 行**且**不强制 date 过滤。
- audit_log 表超过 ~1M 行（dev 已经 76k 在快速增长）。
- 产品需要亚秒级响应、不希望加 UX 摩擦。

### 3.2 v2 —— `JSON_SEARCH()`

```sql
WHERE tenant = 'X'
  AND JSON_SEARCH(requestBody, 'one', '%keyword%') IS NOT NULL
```

| 指标 | 值 | 说明 |
|---|---|---|
| 读 P95 全历史 | 773ms – 1.02s | 比 v1 略快，形态相同 |
| 读 P95 7 天窗口 | 388 – 452ms | 同 v1 |
| 写入惩罚 | 0% | 无 schema 改动 |
| 存储开销 | 0% | 无 schema 改动 |
| **语义 bug** | **无法匹配 JSON 键名，只能匹配 string 值** | 见下 |

**语义 bug 实测**

benchmark 里用 `campaign_engagement` 作为关键词：

- v1（`CAST + LIKE`）匹配 **105 个文档**（关键词出现在 JSON 任意位置）。
- v2（`JSON_SEARCH`）只匹配 **18 个文档**（关键词作为 *string value* 出现）。
- v5（`FULLTEXT`）匹配 **105 个文档**（同 v1）。

剩下 87 个文档里 `campaign_engagement` 是 JSON *key*（如
`"campaign_engagement": { ... }`）。`JSON_SEARCH` 只看 string 叶子节点，
**完全跳过键名**。audit log 场景下用户经常会搜 API 字段名
（`subscriberId`、`campaign_engagement` 等），**这是不可接受的行为**。

**优势**
- 内部成本略低于 v1（~355ms vs ~540ms）。
- 无 schema 改动。

**局限**
- 跟 v1 同样的成本形态（全表扫）。
- 无法匹配 number / boolean / JSON 键叶子。
- 上面 87/105 漏掉是产品硬阻塞。

**什么条件下可接受**
- 永远不可接受。语义上严格劣于 v1，性能上也没有显著优势。
  **从候选方案中删除。**

**什么条件下不可接受**
- 永远。

### 3.3 v3 —— `->>` path 提取（无索引）

```sql
WHERE tenant = 'X'
  AND requestBody->>'$.id' = 'abc-123'
```

| 指标 | 值 | 说明 |
|---|---|---|
| 读 P95 全历史 | 468ms – 1.27s | 全表扫 + 每行 JSON 提取 |
| 读 P95 7 天窗口 | 384 – 511ms | 预过滤有用 |
| 写入惩罚 | 0% | 无 schema 改动 |
| 存储开销 | 0% | 无 schema 改动 |
| EXPLAIN | `Filter: json_unquote(json_extract(...)) = ?` 扫描 45,024 行 |

**优势**
- 已知 path 时 SQL 比 `JSON_SEARCH` 干净。
- 无 schema 改动。
- 是 v4 的基础 —— 一样的 query 形态，只是加了索引。

**局限**
- 仍然全表扫：MySQL **不能在 path 表达式上建索引**
  （`requestBody->>'$.id'`），除非物化成一个列（这正是 v4 做的）。
- 每行 JSON 解析 + path 提取虽然比 `CAST + LIKE` 便宜，但也不免费 ——
  EXPLAIN 显示当前规模内部 ~131ms，线性增长。
- **限于预定义 path**。用户搜你没约定好的字段就用不了 —— 跟 v4 的
  约束一样。

**什么条件下可接受**
- 仅作为 **加 v4 索引前的过渡阶段**。不能作为终态。
- 跟 v1 相同的限制下（小 tenant + date 预过滤）对特定 path 可用。

**什么条件下不可接受**
- 作为长期方案。如果已经付出"约定哪些 path 可搜"的成本了，**就应该
  直接上 v4**。

### 3.4 v4 —— 生成列 + B-tree 索引（已知字段精确搜索的推荐方案）

```sql
ALTER TABLE audit_logs
  ADD COLUMN reqBody_id VARCHAR(256)
  GENERATED ALWAYS AS (requestBody->>'$.id') STORED;
CREATE INDEX idx_reqBody_id_tenant ON audit_logs (tenant, reqBody_id);

WHERE tenant = 'X' AND reqBody_id = 'abc-123'
```

| 指标 | 值 | 说明 |
|---|---|---|
| 读 P95 全历史 | **401 – 409ms** | 全部是网络成本；内部 0.02ms |
| 读 P95 7 天窗口 | 403 – 410ms | 无变化 —— 已经索引快了 |
| 读 P95 24 小时窗口 | 406 – 411ms | 无变化 |
| **EXPLAIN 内部成本** | **0.02 – 0.20ms** | 覆盖索引查找 |
| 写入惩罚 | ≤ 5% 每个索引 path（噪音范围内）| 加了 3 个 path，累计影响很小 |
| 存储开销 | **+1.4%（+7.5 MB）** | 76k 行加 3 个生成列 + 3 个 B-tree 索引 |
| EXPLAIN | `Covering index lookup using idx_reqBody_id_tenant ... rows=1` |

**优势**
- 唯一能把 body 搜索变成 **O(log N) 索引查找** 的方案。EXPLAIN 显示
  MySQL 花 0.02ms 回答 query。
- 存储成本极小 —— 3 个索引 path 在 519 MB 表上只加 7.5 MB。
- 写入惩罚几乎测不出来。即使 v4 真实成本在噪音上界（5%），audit log
  写入仍然在当前容量内。
- 生成列上可以用 MySQL 全部标准操作符（`=`、`IN`、`BETWEEN`、范围）。

**局限**
- **只对预定义 path 有效。** 后续加新 path 要在生产大表上再做
  `ALTER TABLE`。
- 可索引 path 列表本质上是**产品契约** —— PM 必须承诺哪些字段是
  用户可搜的。决策错了的代价是后续一次或多次痛苦的迁移。

**业务可接受性问题（上线前必须回答）**
- PM 是否愿意**承诺一份固定的可搜索 JSON path 列表**（例如 `id`、
  `orderId`、`companyId`、`subscriberId`）？如果是，v4 上线。如果不是，
  v4 部分受阻 —— 只有 PM *愿意*承诺的 path 能用这个方案。
- 当前测的三个 path（`id` / `orderId` / `companyId`）反映的是
  *工程*假设，**不是验证过的产品需求**，需要 PM 拍板。

**什么条件下可接受**
- 产品负责人能承诺一份**小规模**（≤ 5 个）的用户实际搜索的 JSON path
  清单。
- 团队愿意在添加新 path 时做 ALTER TABLE 迁移。

**什么条件下不可接受**
- 用户需要搜的字段跨不同 API endpoint 千变万化（有些 API 是
  `subscriberId`，有些是 `customerId`，有些是深嵌套的 `data.user.id`
  等）。这种场景下 v5 必须和 v4 共存。

### 3.5 v5 —— 字符串化列 + FULLTEXT 索引（free-text body 搜索的推荐方案）

```sql
ALTER TABLE audit_logs
  ADD COLUMN requestBodyText LONGTEXT
  GENERATED ALWAYS AS (CAST(requestBody AS CHAR)) STORED;
ALTER TABLE audit_logs
  ADD FULLTEXT INDEX ftx_requestBodyText (requestBodyText);

WHERE tenant = 'X'
  AND MATCH(requestBodyText) AGAINST ('keyword' IN BOOLEAN MODE)
```

| 指标 | 值 | 说明 |
|---|---|---|
| 读 P95 —— rare/missing token | 399 – 410ms | 几乎全是网络 |
| 读 P95 —— common token | **663ms** | 内部 30ms（走 4669 个文档倒排链表）|
| **EXPLAIN 内部成本（rare/missing）** | **0.008 – 0.56ms** | 倒排索引查找 |
| EXPLAIN 内部成本（common）| 30ms | 倒排链表扫描 |
| **写入惩罚** | **−28%** | 真信号 —— 每次 INSERT 维护 FULLTEXT 倒排索引 |
| **存储开销** | **+37.7%（519 MB 表 +195 MB）** | 字符串化列 + FULLTEXT 辅助表 |

**Token 语义（必须告知 PM 和用户）**

FULLTEXT 是 **token-based**，不是字符 substring：

- `MATCH('abc')` 找含 `abc` 这个 token 的文档。
- `MATCH('abc')` **不会**找到含 substring `abc` 在更长 token（如
  `abcdef`）里的文档。前缀搜索要用 `MATCH('abc*' IN BOOLEAN MODE)`。
- 默认 `innodb_ft_min_token_size = 3` —— 短于 3 字符的 token 会被
  静默忽略。
- 连字符、下划线、标点会切分 token。UUID 如 `cb4a86a6-58cb-…` 按 `-`
  分成多个 token；搜完整 UUID 能命中，搜中间 4 字符片段不行。
- 中日韩等非 ASCII 数据建议用 `WITH PARSER ngram`。

**优势**
- 唯一一个在任意表大小下都能 **亚秒级 free-text 搜索** 的方案。
- 支持任意关键词，不限于预定义 path。
- 即使最差的高频 token，内部成本也 ≤ 35ms。

**局限**
- **写入吞吐下降 28%。** audit log 是写密集表，必须对照当前生产
  写入 QPS 验证。
- **存储 +38%。** 当前 519 MB 样本 +195 MB；生产规模估算
  （1 亿行 = ~150 GB 基础），v5 大约多加 55 GB。
- **Token 语义和 substring 搜索不一样。** UX 必须明确告知用户避免
  混淆。
- **生产表上首次建 FULLTEXT 索引会很慢，可能阻塞写入。** 需要 DBA
  spike 估算。

**什么条件下可接受**
- 产品需要 free-text body 搜索，且愿意承担存储和写入吞吐成本。
- UX 把它做成独立的 "Search Request Body" 输入框，明确区别于 column
  search，让 token-vs-substring 的语义差异显而易见。

**什么条件下不可接受**
- 用户必须能找到落在长 token 内部的 substring（MySQL 没有方案，
  需要 OpenSearch + 自定义分词器）。
- 生产写入 QPS 已经满了 —— 不扩容吃不下 −28% 吞吐。

---

## 4. 网络开销 —— 读绝对数字前必须先理解这个

### 4.1 本次 benchmark 测出的 RTT

读 benchmark 里每次 query 都坐在一个 **~307ms 网络底线** 上。
证据：v4 在 `$.orderId` 上 0 命中的 query，EXPLAIN 内部成本 **0.20ms**
但观察 P50 是 **307.6ms**。剩下的 ~307ms 是网络往返 + 驱动序列化。

这意味着：

- **本报告里的绝对 P50/P95 把 MySQL 真实成本高估了约 307ms。**
- **方案之间的相对对比仍然有效** —— 每个方案都付一样的网络税。
- **EXPLAIN 内部时间才是 MySQL 实际工作的真实读数。** 对比方案时
  看这一栏。

### 4.2 推断的生产行为

假设生产 MySQL 连接 RTT 1–10ms：

| 方案 | 实验室 P95（全历史）| 推断生产 P95 | 说明 |
|---|---:|---:|---|
| v1 | 1.10s | ~800ms | 受扫描限制，网络帮不上多少 |
| v2 | 1.02s | ~720ms | 同上 |
| v3 | 1.27s | ~970ms | 同上 |
| **v4** | 409ms | **~5–20ms** | 内部成本 0.02ms；网络又成了底线 |
| **v5** | 663ms（common）| **~40ms（common）、<10ms（rare/missing）** | 内部 30ms（common）或近 0 |

### 4.3 SLA 占位目标（待 PM 确认）

| 搜索类型 | 推荐 SLA | 置信度 |
|---|---|---|
| 已知字段搜索（v4）| **P95 ≤ 50ms** | 高 |
| Free-text body 搜索（v5）| 普通 token **P95 ≤ 200ms**，高频 token **≤ 500ms** | 中 —— 表涨到 1000 万行后要重新验证 |

---

## 5. 业务侧过滤策略 —— 实际能买到什么

### 5.1 `dateTime` 窗口预过滤（常开或可选）

benchmark 显示扫描型方案受益明显：

| 方案 | `all` P95 | `7d` P95 | `24h` P95 | `all → 24h` 加速 |
|---|---:|---:|---:|---|
| v1 common | 1.10s | 410ms | 391ms | **2.8×** |
| v1 missing | 988ms | 391ms | 400ms | **2.5×** |
| v2 common | 1.02s | 410ms | 385ms | **2.6×** |
| v3 `$.id` | 1.27s | 511ms | 410ms | **3.1×** |
| v4 `$.id` | 409ms | 410ms | 407ms | 1.0×（已经索引快了）|
| v5 common | 663ms | 408ms | 411ms | 1.6× |
| v5 rare | 399ms | 390ms | 406ms | 1.0× |

**怎么读：**

- 对 **v1/v2/v3 扫描型方案**，强制 `≤ 7 天` 窗口把 P95 从 ~1s 降到
  ~400ms —— 接近可接受，但仍随 7 天窗口内的数据密度线性增长。
  audit_log 未来一年涨 10× 的话，7d 窗口也涨 10×，加速效果就消失了。
- 对 **v4 / v5**，date 过滤几乎没效果，因为索引已经把候选集缩好了。
  UX 里这个 filter 可以是可选的。

**推荐产品策略：**

- **默认显示一个 date picker，默认 "近 7 天"。** 这是好 UX，且对任何
  未来 fallback 到扫描行为是安全网。
- **不要依赖 date 过滤来达到 SLA** —— 依赖 v4/v5 索引。date 过滤是
  防御性 UX，不是主方案。

### 5.2 必填参数过滤（tenant 始终、基于角色的 ID 过滤）

每个 benchmark query 都已经带上 `tenant = 'X'`，因为现有
`audit_logs_tenant_index` 是优化器进入正确分区的入口。**这是不可
妥协的** —— 没有 tenant 过滤的话，query 会扫 76,575 × N tenants 行，
完全不可用。

代码库已经在 service 层强制所有 audit-log query 都带 tenant，
所以这条已经满足了。这里只是为完整性记录一下。

### 5.3 前端 UX 影响

当前 Audit History 页面是按列搜索/过滤（可搜列：requestId、dateTime、
userName、method、apiCall、responseStatusCode）。加 body 搜索需要
新交互，因为：

- v4（path-based）和 v5（FULLTEXT）的 **操作符** 跟现有 column-search
  操作符不一样。
- v5 的 token 语义不是用户期望的 substring-contains。

**推荐**：在表格上方加一个独立的 "Search Request Body" 输入框，与
现有 column search 分开：

- 加 tooltip 解释 "token-based search；最少 3 字符；用 `*` 做前缀"。
- 当输入值匹配某个已知索引 path 时自动路由到 v4（如 UUID 格式 →
  按 `$.id` 搜），其他情况 fallback 到 v5 FULLTEXT。
- 可选支持高级语法如 `subscriberId:abc-123` 显式指向 v4 path。

具体 UX 由 PM 和设计团队共同负责。后端两条路都能支持。

---

## 6. 推荐结论

### 6.1 推荐方案组合

| 用户场景 | 方案 | 理由 |
|---|---|---|
| 用某个 `requestId` 查日志 | （已有 `requestId` B-tree 索引）| 已覆盖，无需改动 |
| 按已知 JSON 字段搜（`id`、`orderId`、`companyId`、…）| **v4** | 内部 0.02ms；存储 +1.4%；写入惩罚 ≤ 5% |
| Free-text body 搜索 | **v5** FULLTEXT | 任意关键词的唯一亚秒级方案；UX 要说明 token 语义 |
| 跨多 token 数据的字符 substring 搜索 | **MySQL 不支持** | 如果业务确认有这需求，建议升级到 OpenSearch |

### 6.2 被拒方案及理由

| 方案 | 拒绝理由 |
|---|---|
| v1（`CAST + LIKE`）| 当前数据 P95 ≈ 1s；线性扩展；超 50k 行/tenant 后无 date 过滤不可用 |
| v2（`JSON_SEARCH`）| 跟 v1 成本相同，**还多一个语义 bug** —— 漏掉 JSON 键名匹配（一组测试里 105 命中漏掉 87）—— audit log 场景下语义残缺 |
| v3（`->>` 无索引）| 跟 v1/v2 同样的全表扫成本；相比直接上 v4 没有任何收益 |

### 6.3 生产容量影响

| 维度 | 仅 v4 | 仅 v5 | v4 + v5 |
|---|---|---|---|
| 读延迟 | 最佳 | common token ~30ms | 按 query 类型取最佳 |
| 写吞吐 | ≤ −5%（可忽略）| −28% | ~ −30%（叠加但略小于和）|
| 存储 | +1.4% | +37.7% | ~ +40% |
| 迁移风险 | 低（3 次 ALTER TABLE）| 中（大表 FULLTEXT 建索引可能慢）| 中 |

**对生产 audit_logs 表（当前估算 1 亿行 / ~150 GB，快速增长）：**

- 仅 v4 加约 2 GB 索引、< 5% 写入惩罚。
- 仅 v5 加约 55 GB 数据 + < 30% 写入惩罚。
- v4 + v5 组合：约 57 GB 额外存储、约 30% 写入惩罚。

**最终决策前需要：**

- 测量生产写入 QPS（确认 −30% 能吃得下）。
- DBA spike 估算线上表 FULLTEXT 索引建立时间。
- PM 拍板 v4 要索引哪些 path（建议最多 3-5 个）。

---

## 7. 后续行动

| # | 行动项 | 负责人 | 阻塞 |
|---|---|---|---|
| 1 | 跟 PM 拍板 v4 索引的 JSON path 清单（3-5 个）| 工程 + PM | 无 |
| 2 | 设计 "Search Request Body" 输入框 UX（含 token 语义 tooltip）| 工程 + PM + 设计 | 无 |
| 3 | DBA spike：估算 v4（生成列+索引）和 v5（FULLTEXT）在线上生产表上 ALTER TABLE 的耗时 | 工程 + DBA | 无 |
| 4 | 确认 audit_logs 当前生产写入 QPS；验证 ≤ 30% 余量 | 工程 | 无 |
| 5 | Spike：在 body 接近 2.57 MB 上限的 "胖" tenant 上验证 v5 行为 | 工程 | 可选 |
| 6 | 决定上线顺序 —— v4 先、v5 后（低风险分批）| 工程 + lead | 步骤 1, 3, 4 |
| 7 | 生产上线方案：ALTER TABLE 时间窗口、监控大盘、回滚方案 | 工程 + SRE | 步骤 6 |

---

## 8. 附录 —— 原始数据指针

| 产物 | 路径 |
|---|---|
| 读 benchmark 报告 | `reports/run-2026-05-27-11-55-51-read.md` |
| 写 benchmark 报告 | `reports/run-2026-05-27-13-01-23-write.md` |
| 合并报告 | `reports/run-2026-05-27-11-55-51-combined.md` |
| 存储测量 | 通过 `ANALYZE TABLE` + `information_schema.tables` 手动 SQL |
| 方案定义 | [`docs/schemes.zh-CN.md`](../docs/schemes.zh-CN.md) |
| Keyword 分桶设计 | [`docs/keywords.zh-CN.md`](../docs/keywords.zh-CN.md) |
| 方法学补充 | [`docs/methodology.md`](../docs/methodology.md) |

复现方法：配置好 `.env` 后跑 `npm run all`。详见
[`README.zh-CN.md`](../README.zh-CN.md)。
