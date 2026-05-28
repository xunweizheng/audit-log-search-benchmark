# audit-log-search-benchmark

对 `audit_logs.requestBody` 这个 JSON 列，对比 5 种 MySQL 搜索方案的
性能。

这个仓库存在的目的，是让"Audit History 是否能支持按 request body
搜索 / 怎么支持"的结论建立在**可复现的真实数字**上，而不是拍脑袋。

> 🇬🇧 [English README](./README.md)
>
> 📘 **新人请先读 [`docs/schemes.zh-CN.md`](./docs/schemes.zh-CN.md)。**
> 里面讲清楚了每个方案具体在做什么，附 SQL 示例和取舍。下面这份 README
> 只给一行简介，方便快速回忆。

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
方案的写入吞吐。

---

## 为什么要做这个 benchmark

Portal 的 Audit History 页面目前 **不支持** 搜索 `requestBody` 列，
原因：

- `requestBody` 是 `JSON` 列，**没有可用索引**。
- 通用 `buildWhere` 只生成 `LIKE` / `=` / `!=`，对 JSON 列没意义。
- request body 可能很大，audit_logs 表本身增长快，朴素 `LIKE` 全表扫
  必然超过 30s 查询超时。

在决定引入更重的组件（OpenSearch、独立 indexing pipeline，或把
Audit Log 从 `portalBackend` 抽到独立 NestJS service）之前，我们想
先看清楚：**只用 MySQL 本身能做到什么程度**。

---

## 5 种方案速览

> 完整深度解析（含 SQL 示例、优缺点、避坑指南）：
> **[`docs/schemes.zh-CN.md`](./docs/schemes.zh-CN.md)**。

| 方案 | 一句话总结 | 改表？ | body 索引？ |
|---|---|---|---|
| **v1** | `CAST(JSON AS CHAR) + LIKE` — 基线，零改动 | 不需要 | 没有 |
| **v2** | `JSON_SEARCH()` — 原生 JSON 函数，无索引 | 不需要 | 没有 |
| **v3** | `->>` path 提取 — 已知 path，无索引 | 不需要 | 没有 |
| **v4** | 生成列 + B-tree — 已知 path + 索引（极快但只支持预定义 path） | 加列+索引 | 有（B-tree） |
| **v5** | 字符串化列 + FULLTEXT — 规模下的 free-text body 搜索（token 分词） | 加列+索引 | 有（FULLTEXT） |

`v1`、`v2`、`v3` 都是全表扫，作为基线存在。
`v4`、`v5` 才是候选的"真正解决方案"，关键的 trade-off 也在它俩身上。

---

## benchmark 怎么跑

5 个阶段，每个对应 `src/` 下一个 TypeScript 脚本：

1. **`inspect`** — 只读。打印 MySQL 版本、源表大小、`requestBody` 大小
   分布、tenant 排行和现有索引。
2. **`setup`** — 为每个方案建一张姐妹表（`audit_logs_bench_v1` …
   `audit_logs_bench_v5`），从源表复制全部数据，然后应用方案特定的
   schema 改动（v4 的生成列+索引、v5 的字符串化列+FULLTEXT 索引）。
   **幂等**——重复跑安全。
3. **`bench:read`** — 测每个方案的搜索快不快。对每个 方案 × keyword × 时间范围，跑 `WARMUP`
   次预热（丢弃）+ `ITERATIONS` 次测量。记录 P50 / P95 / P99，并对每
   个组合跑一次 `EXPLAIN ANALYZE` 收入报告。
4. **`bench:write`** — 测每个方案的写入代价多大。向每个姐妹表插入 `WRITE_ITERATIONS` 条合成数据，
   记录 inserts/sec。测试数据跑完会删除，保证 read benchmark 不受影响。
5. **`teardown`** — drop 所有姐妹表。默认 `KEEP_BENCH_TABLES=true` 时
   跳过，方便不重新 setup 再跑。

### 为什么用姐妹表？

我们**绝不修改源 `audit_logs` 表**。v4 / v5 需要 `ALTER TABLE`，
直接动源表会影响 dev 库上别人。姐妹表是干净的、可对比的、可随时
drop 的隔离区。

### 为什么是 P95 / P99 而不是平均数？

平均数会**掩盖尾延迟**。如果 99% 的请求是 100ms、1% 是 10s，平均还是
200ms 看着挺好，但用户体验已经崩了。P95 / P99 反映的是"最差体验的那
部分用户"实际感受——SLA 通常也是基于它写的。

---

## 快速开始

### 前置要求
- Node.js 18+（用 `tsx` 直接跑 TS）
- 一个 MySQL 8.x 实例，且**你有完整 DDL 权限**（`setup` 会
  `ALTER TABLE` 和 `CREATE INDEX`）
- 网络上能从你机器访问到这个 MySQL

### 步骤

```bash
git clone https://github.com/xunweizheng/audit-log-search-benchmark.git
cd audit-log-search-benchmark
npm install
cp .env.example .env
# 编辑 .env，填上 DB_HOST / DB_USER / DB_PASSWORD / DB_DATABASE

npm run inspect       # 1) 只读侦察
npm run setup         # 2) 建姐妹表 + 应用 schema 改动
npm run bench:read    # 3) 跑读延迟 benchmark
npm run bench:write   # 4) 跑写吞吐 benchmark
npm run teardown      # 5) （可选）清理姐妹表
# 或一键全跑：
npm run all
```

报告写到 `reports/run-<时间戳>-<phase>.{md,json,csv}`，`<phase>` 是
`read` / `write` / `combined` 之一：

- `npm run bench:read`  → `run-<时间戳>-read.{md,json,csv}`
- `npm run bench:write` → `run-<时间戳>-write.{md,json,csv}`
- `npm run all`         → 上述两份加上合并的
  `run-<时间戳>-combined.{md,json,csv}`，同时包含读和写的数据。

报告**有意提交进 git**，方便回看历史。

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
| `WRITE_BATCH_SIZE` | 每条 multi-row INSERT 的行数；越大越能摆脱网络瓶颈 | `50` |
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

百分比是相对 v1 基线的差异。对 audit_logs 这种写密集表，-48% 的写
性能下降很显著，采纳 v5 之前必须对照生产的写入 QPS 看看有没有余量。

---

## 仓库结构

```
audit-log-search-benchmark/
├── README.md                # 英文版
├── README.zh-CN.md          # 本文件
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
│       ├── num.ts           # mysql2 BIGINT / DECIMAL 的安全转换
│       ├── timer.ts         # hrtime + 分位数计算
│       ├── logger.ts        # 带时间戳的 console 输出
│       ├── keywords.ts      # 关键词自动采样
│       ├── schemes.ts       # 5 个方案的定义
│       └── report.ts        # markdown / json / csv 输出
├── reports/                 # benchmark 输出（入库）
└── docs/
    ├── schemes.md           # 🌟 5 方案深度解析（英文）—— 先读
    ├── schemes.zh-CN.md     # 🌟 5 方案深度解析（中文）
    ├── keywords.md          # 关键词分桶（common/rare/missing）的设计解读（英文）
    ├── keywords.zh-CN.md    # 同上，中文版
    └── methodology.md       # 方法学补充
```

---

## 常见问题

**`EXPLAIN ANALYZE` 报语法错。**
你在 MySQL 5.7。`EXPLAIN ANALYZE` 需要 8.0+。其他阶段照常跑，只是报告
里缺 EXPLAIN 片段。

**FULLTEXT 索引建很久。**
大表（几百万行起）正常现象。在另一个 session 里 `SHOW PROCESSLIST`
确认进度，如果可能就调大 `innodb_buffer_pool_size`。

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

---

## 延伸阅读

- **[`docs/schemes.zh-CN.md`](./docs/schemes.zh-CN.md)** — 5 方案
  深度解析，含 SQL 示例、优缺点、用户场景映射。**先读这个**。
- [`docs/keywords.zh-CN.md`](./docs/keywords.zh-CN.md) — 读 benchmark
  为什么要分三种关键词桶（common / rare / missing），以及怎么从每个
  方案在三桶上的表现读出它的性能特征。
- [`docs/methodology.md`](./docs/methodology.md) — 为什么不用 sysbench、
  为什么要预热、为什么测 P95、我们不测什么以及为什么不测。
