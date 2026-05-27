# 关键词分桶设计 — `common` / `rare` / `missing` 是什么、为什么这么分

> 🇬🇧 [English version](./keywords.md)
>
> 相关：[`schemes.zh-CN.md`](./schemes.zh-CN.md)（5 个方案各自做什么）、
> [`methodology.md`](./methodology.md)（整体 benchmark 方法学）。

## TL;DR

读 benchmark 每次跑会用 **9 个关键词**：3 个 common、3 个 rare、3 个 missing。
它们**不是**用来代表"真实用户搜索场景"的，而是用来**诊断每个方案被什么
成本卡住**。

如果只用一个关键词，你只有一个数据点，**根本看不出来一个方案到底是被
"扫描"卡住、被"返回结果数"卡住、还是真的全程都快**。三桶分法就是为了
把这三种独立的成本来源分开。

---

## 每一桶是什么

| 分桶 | 是什么 | 自动采样怎么挑 |
|---|---|---|
| **common** | 在你的 audit log 里**频繁出现**的字符串 | 从最新 500 行 `requestBody` 里挖出所有 4–80 字符的字符串值，频次 ≥ 5 的取前 3 |
| **rare** | 在你的 audit log 里**只出现一两次**的字符串 | 同一次采样里频次 = 1 或 2 的取前 3 |
| **missing** | **保证完全不存在**的字符串 | 直接生成 3 个随机 UUID |

跑 benchmark 时日志会打印出实际挑到的字符串：

```
Sampling latest 500 requestBody rows to derive keywords...
Sampled keywords: 3 common, 3 rare, 3 missing
Keywords — common: ["lotusflaretelecom", "POST", "subscriber-12345"]
Keywords — rare:   ["uuid-xyz...", ...]
Keywords — missing:[random UUID, ...]
```

---

## 为什么要分三桶

因为不同方案对不同东西敏感，**单个关键词测不出来到底是什么在拖**。三桶
正好对应三种独立的成本维度：

### 1. 扫描型方案（v1、v2）
全表扫的方案，扫描成本是**固定的**（每次都得扫每一行），但**返回的行数**
还是会影响整体延迟（返回越多 = 网络传输越多）。

| 关键词 | v1 实际行为 | 主要成本 |
|---|---|---|
| common（命中 5000 行）| 扫 76K 行，返回 5000 行 | 扫描 + 传输 |
| rare（命中 2 行）| 扫 76K 行，返回 2 行 | 主要是扫描 |
| missing（命中 0 行）| 扫 76K 行，返回 0 行 | 纯扫描 |

→ 如果三者时间几乎一样，说明瓶颈就是**扫描本身**。再怎么挑关键词都救
不了这个方案。

### 2. 索引型方案（v4）
索引方案的成本主要看**命中多少行**——每命中一行，还要再去主表读一次
拿完整数据。

| 关键词 | v4 实际行为 | 主要成本 |
|---|---|---|
| common（命中 5000 行）| 索引定位 + 回表 5000 次 | 受结果集大小限制 |
| rare（命中 2 行）| 索引定位 + 回表 2 次 | 几乎瞬间 |
| missing（命中 0 行）| 索引一查没有直接返回 | 最快 |

→ `missing` 和 `common` 时间差距大，**证明索引在干活**——优化器在用它
跳过无关行。如果三者一样慢，说明索引根本没被使用。

### 3. FULLTEXT 方案（v5）
和索引型类似，但多了一个因素：**token 频率**。常见词的倒排链表很长，
引擎光走匹配的文档 ID 就要花不少时间，还没开始回表。

| 关键词 | v5 实际行为 |
|---|---|
| common（"order" 这种常见词）| 倒排链表很长，要扫一长串文档 ID |
| rare 罕见 token | 倒排链表短，几乎瞬间 |
| missing 不存在的 token | 倒排索引一查没有，立刻返回 |

→ `common` 和 `rare` 的差距能告诉你 FULLTEXT 在**你这份数据**上到底
有没有用——不是抽象意义上的"有索引就快"。

---

## 报告里到底能读出什么（举例）

下面四个具体例子，演示怎么读三组数据：

### 例 A — v4 全程都快

```
v4 | common  | P95 = 1.2ms
v4 | rare    | P95 = 0.8ms
v4 | missing | P95 = 0.6ms
```

全程亚毫秒级。结论：**生成列上的 B-tree 索引完美工作**，命中多少都
无关紧要。v4 强力推荐。

### 例 B — v4 对 missing/rare 快，对 common 慢

```
v4 | common  | P95 = 2400ms
v4 | rare    | P95 = 0.8ms
v4 | missing | P95 = 0.6ms
```

1000 倍差距。索引本身**没问题**（看 rare/missing），但 common 关键词
命中行太多导致回表读取爆炸。结论：v4 适合**低命中率精确搜索**
（subscriberId、orderId 这种），但产品不应该鼓励用户搜"order"这种
常见词。

### 例 C — v1 全程都慢

```
v1 | common  | P95 = 2300ms
v1 | rare    | P95 = 2200ms
v1 | missing | P95 = 2200ms
```

三者几乎一样。结论：瓶颈就是**全表扫描**，不是结果集大小。2 秒打底，
再怎么挑关键词也救不了 v1。

### 例 D — v5 FULLTEXT，common 远慢于 rare

```
v5 | common  | P95 = 180ms
v5 | rare    | P95 = 12ms
v5 | missing | P95 = 4ms
```

索引活着（missing/rare 都快），但 FULLTEXT 走倒排链表时遇到常见 token
就拖。结论：v5 能用，但 UX 上要警告用户搜常见词会慢（或者配置 stopwords）。

---

## 自动采样的实现细节

代码在 `src/lib/keywords.ts::autoSampleKeywords`。伪代码：

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

两个实现注意点：

1. **为什么用 `ORDER BY id DESC` 而不是 `ORDER BY RAND()`** —— 后者会
   让 MySQL 把每一行都塞进 sort buffer，对你这种 requestBody 最大
   2.57MB 的表会直接爆 `Out of sort memory`。按主键反向读最新 N 行
   走索引扫描，成本极低；而且最新的行也更能反映当前 API 的使用模式。
2. **为什么字符串长度限制 4–80** —— 太短（< 4）的字符串噪音太大
   （单字母、太短的 token，反正 FULLTEXT 默认最小 token 长度就是 3）；
   太长（> 80）的通常是长 ID/token，对 benchmark 没什么语义价值。

---

## 覆盖自动采样

如果你想测特定关键词（比如 PM 说"用户实际是搜手机号"），编辑 `.env`：

```env
# JSON 数组形式或逗号分隔都行
KEYWORDS_COMMON=["13800138000","example@email.com"]
KEYWORDS_RARE=["specific-order-id-xxxx"]
KEYWORDS_MISSING=["definitely-not-in-any-row"]
```

env 不为空时，对应那一桶就用你给的值，跳过自动采样。可以只覆盖一桶
让其他还是自动。

---

## 顺便说说 — 关键词桶 vs. JSON path

v3 / v4 这两个方案**完全不用关键词桶**，它们用的是 **JSON path**
（`.env` 里的 `JSON_PATHS`），benchmark 会从数据里采样每个 path 的真实
值。原因是 v3/v4 只能回答"`requestBody.id = X` 吗"这种问题，回答不了
"body 里任意位置含字符串 Y 吗"。关键词 vs path 的分割，正好反映了两类
方案根本不同的搜索语义。

完整的方案与用户场景映射见 [`schemes.zh-CN.md`](./schemes.zh-CN.md)。
