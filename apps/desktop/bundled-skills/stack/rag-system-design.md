---
name: rag-system-design
description: 设计 RAG（检索增强生成）系统时，**调用此技能**遵守 chunking / embedding / retrieval / re-ranking 的最佳实践，避免回答不准、上下文爆炸、检索召回低等常见坑。
---

# RAG（Retrieval Augmented Generation）系统设计

## 适用场景

- 私有文档问答（公司 wiki / 客服知识库）
- 代码库搜索 / 解释
- 多文档总结
- 法律 / 医疗 / 金融领域问答（需要溯源）

## RAG 核心流程

```
索引阶段（Index）：
  Documents → Chunking → Embedding → Vector DB

查询阶段（Query）：
  User Question → Embedding → Top-K Retrieval → 
  → [可选] Re-ranking → Build Prompt → LLM → Answer
```

## 8 条铁律

### 1. Chunking（切片）— 最影响效果

切片质量决定召回上限。

#### 切片策略

| 策略 | 适用 |
|---|---|
| **固定长度**（800 字符 + 100 重叠） | 通用文档 |
| **按语义段落** | 结构化文档（markdown） |
| **按代码结构**（函数 / 类） | 代码库 |
| **按句子边界** | 短文档 |
| **递归切分**（先按章节，超长再切句子） | 长 PDF / 书籍 |

经验值：
- chunk 大小 500-1500 字符（英文 token 约 800-2000）
- overlap 10-20%（保留上下文）
- 中文按字符或用专门 tokenizer

```python
from langchain.text_splitter import RecursiveCharacterTextSplitter

splitter = RecursiveCharacterTextSplitter(
  chunk_size=1000,
  chunk_overlap=200,
  separators=["\n\n", "\n", "。", "！", "？", ".", "!", "?", " "],
)
chunks = splitter.split_text(document)
```

#### 关键：保留元数据

```python
chunk = {
  "text": "...",
  "source": "doc-123.pdf",
  "page": 5,
  "section": "合同条款",
  "doc_title": "...",
  "created_at": "2026-01-01",
}
```

检索后能引用、过滤、排序。

### 2. Embedding 模型选型

| 模型 | 维度 | 成本 | 质量 |
|---|---|---|---|
| OpenAI text-embedding-3-small | 1536 | $0.02/1M | 中高 |
| OpenAI text-embedding-3-large | 3072 | $0.13/1M | 高 |
| BGE-large-zh-v1.5（中文） | 1024 | 自托管免费 | 中文最佳 |
| Jina Embeddings v3 | 1024 | 中等 | 多语言强 |
| voyage-large-2 | 1024 | 中等 | 代码专长 |

**经验**：
- 中文 → BGE 或 jina-zh / multilingual-e5
- 英文 → OpenAI 3-small 性价比最高
- 代码 → voyage-code-2

#### Embedding 一致性

**index 和 query 必须用同一个模型**。换模型 → 重建整个索引。

### 3. Vector DB 选型

| 工具 | 适用 |
|---|---|
| **PostgreSQL + pgvector** | 已有 PG，规模 < 1M chunk |
| **Qdrant** | 自托管，规模 < 100M |
| **Pinecone** | 托管，省心，规模任意 |
| **Weaviate** | 自托管 + 强大过滤 |
| **Chroma** | 本地 / 开发首选 |
| **Milvus** | 大规模（> 100M） |
| **Elasticsearch dense_vector** | 已有 ES |

**默认选择**：
- 个人 / Demo → Chroma
- 公司中等规模 → pgvector / Qdrant
- 海量 → Pinecone / Milvus

### 4. 检索 — Top-K + 阈值

```python
results = vector_db.search(
  query_embedding,
  top_k=10,            # 拉 10 条候选
  score_threshold=0.7, # 太低的不要
  filter={"source": {"$in": ["doc-1", "doc-2"]}},  # 元数据过滤
)
```

**Top-K 经验值**：
- 拉 10-20 条 → re-rank 后取前 3-5 条
- 太少：可能漏关键信息
- 太多：噪声 + token 浪费 + LLM 注意力分散

### 5. Hybrid Search（向量 + 关键词）

向量擅长"语义相似"，BM25 擅长"精确匹配"。结合两者：

```
向量召回 50 条 + BM25 召回 50 条 → 取 union → re-rank
```

特别有用的场景：
- 用户问 "GET /api/users 怎么用" → BM25 精准匹配字符串 + 向量找语义相关
- 专有名词、产品名、代码片段

```python
# Weaviate / Qdrant 自带 hybrid
results = qdrant.query_points(
  collection_name="docs",
  query=query_vec,
  using="vector",
  with_payload=True,
  prefetch=[
    Prefetch(query=NearestQuery(nearest=query_vec), using="vector", limit=20),
    Prefetch(query=keywords, using="text", limit=20),
  ],
  query_filter=...,
)
```

### 6. Re-ranking（精细排序）

向量检索拉的 top-10 不一定按相关度排序。用 re-ranker 重排：

```python
# Cohere Rerank
import cohere
co = cohere.Client(...)

reranked = co.rerank(
  query=question,
  documents=[c["text"] for c in chunks],
  top_n=3,
  model="rerank-multilingual-v3.0",
)

best_chunks = [chunks[r.index] for r in reranked.results]
```

或用本地 Cross-Encoder 模型（BAAI/bge-reranker-large）。

Re-rank 通常能提升 10-30% 准确率。

### 7. 构建 Prompt — 引用 + 防幻觉

```
你是文档问答助手。**只能根据下面提供的资料回答**。
如果资料不足以回答，说"我不确定，请查阅原文档"。
**禁止编造**资料里没有的信息。

## 资料

[1] 来源: contract-2026.pdf, 第 5 页
合同金额为 100 万元人民币...

[2] 来源: amendment.pdf, 第 2 页
合同补充条款...

## 问题
{{user_question}}

## 输出格式
回答：[基于资料的回答]
引用：[1, 2]（标注用了哪些资料编号）
```

**关键防幻觉技巧**：
- 显式写"只能根据资料"
- 资料编号 + 要求引用
- 不知道就说不知道
- 让 LLM 输出引用，应用层验证

### 8. Evaluation（评估）

不评估你不知道改 prompt 是变好还是变差。

#### 经典三指标

1. **Faithfulness**（忠实性）：回答中的事实都来自检索资料？
2. **Answer Relevance**：回答和问题相关？
3. **Context Relevance**：检索的资料和问题相关？

工具：
- **RAGAS**：自动化评估
- **TruLens**：实时监控
- **LangSmith / Phoenix**：trace + eval

#### 自建测试集

```yaml
- question: "合同金额是多少？"
  expected_answer: "100 万元"
  expected_sources: ["contract-2026.pdf"]
  
- question: "如果违约怎么办？"
  expected_answer: "..."
  expected_sources: ["contract-2026.pdf"]
```

每改一处（chunk size、embedding 模型、prompt）跑一遍，看分数。

## 高级模式

### 1. Multi-Query Retrieval

LLM 把用户问题改写成多个变体，多次检索取并集：

```
原问题："合同有效期？"
变体：
- "合同的起止日期是什么？"
- "合同什么时候到期？"
- "the expiration date of the contract"

→ 各检索一遍 → 合并去重
```

### 2. Hypothetical Document Embeddings（HyDE）

让 LLM 先编造一个"理想答案"，用这个答案的 embedding 去检索：

```
用户问：合同金额？
LLM 假想答案："本合同总金额为 X 元，分 Y 期支付..."
用假想答案的 embedding 检索 → 召回更准
```

### 3. Self-Querying

LLM 把自然语言查询拆成"语义搜索 + 结构化过滤"：

```
用户："2025 年签的高于 100 万的合同"
→ 拆成：
   semantic_query: "高金额合同"
   filter: {created_year: 2025, amount: {">=": 1000000}}
```

### 4. Graph RAG

文档抽实体 + 关系建图，跨文档关联：

```
合同 A —签订—→ 公司 X
合同 A —担保—→ 银行 Y
合同 B —签订—→ 公司 X

问：公司 X 签了哪些合同？→ 图遍历，比向量更准
```

工具：Neo4j + LangChain GraphRAG / LightRAG。

## 索引更新策略

文档变化的处理：

| 策略 | 触发 |
|---|---|
| **全量重建** | 每天 / 每周（数据稳定时） |
| **增量更新** | 文档新增 / 删除立即处理 |
| **元数据软删** | 删除时只标记 deleted=true，定期 vacuum |

避免索引中残留过期内容（用户问"最新策略"，召回旧文档）。

## 常见反模式

❌ **chunk 太大**（5000+ 字符）→ 检索不准 + 浪费 token
   ✅ 500-1500 字符 + 重叠

❌ **不带元数据**（只存 text）
   ✅ 存 source / page / section 等

❌ **直接把 top-10 全塞 LLM**（30K token）
   ✅ Re-rank 后取 3-5 条

❌ **不评估，凭感觉调**
   ✅ 测试集 + RAGAS

❌ **一种检索方式**（只向量 / 只关键词）
   ✅ Hybrid

❌ **回答没引用**
   ✅ 强制让 LLM 引用，应用层验证

❌ **不防幻觉**（system prompt 不写"只能用资料"）
   ✅ 显式约束 + 输出引用

## 工具栈推荐

| 层 | 工具 |
|---|---|
| 文档加载 | LlamaParse / Unstructured / pypdf |
| Chunking | LangChain TextSplitter / Llama-Index |
| Embedding | OpenAI / BGE / Jina |
| Vector DB | Pinecone / Qdrant / pgvector |
| Re-rank | Cohere / BGE Reranker |
| 框架 | LangChain / LlamaIndex / Haystack |
| 评估 | RAGAS / TruLens |
| 监控 | LangSmith / Phoenix |

## 与其他技能的关系

- LLM 调用 → llm-prompt-engineering
- 数据库（pgvector） → sql-query-optimization
- 缓存检索结果 → redis-caching-patterns
- 部署 → kubernetes-deployment（GPU 节点跑 reranker）
