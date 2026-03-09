# OmniAgent 中间件系统

完善的企业级中间件系统，为 AI Agent 提供缓存、日志、限流、重试等核心能力。

## 📚 目录

- [功能概览](#功能概览)
- [快速开始](#快速开始)
- [中间件详解](#中间件详解)
- [配置说明](#配置说明)
- [使用示例](#使用示例)
- [最佳实践](#最佳实践)

---

## 🎯 功能概览

### 1️⃣ 缓存中间件

| 中间件 | 功能 | 适用场景 |
|--------|------|----------|
| **simple_cache_middleware** | LRU缓存 + TTL过期 | 快速缓存重复问题 |
| **semantic_cache_middleware** | 向量语义缓存 | 理解相似问题的语义 |

### 2️⃣ 日志监控中间件

| 中间件 | 功能 | 适用场景 |
|--------|------|----------|
| **observability_middleware** | 结构化日志 + 性能统计 | 生产环境监控 |

### 3️⃣ 限流中间件

| 中间件 | 功能 | 适用场景 |
|--------|------|----------|
| **rate_limit_middleware** | 令牌桶/滑动窗口限流 | 保护系统资源 |

### 4️⃣ 重试中间件

| 中间件 | 功能 | 适用场景 |
|--------|------|----------|
| **retry_middleware** | 智能重试 + 指数退避 | 提升系统稳定性 |

---

## 🚀 快速开始

### 方式一：使用预定义中间件栈（推荐）

```python
from app.middleware import standard_middleware_stack

@standard_middleware_stack
async def my_agent(user_input: str, **kwargs):
    # 你的业务逻辑
    result = await some_llm_call(user_input)
    return {"messages": [{"content": result}]}
```

### 方式二：手动组合中间件

```python
from app.middleware import (
    observability_middleware,
    semantic_cache_middleware,
    rate_limit_middleware
)

@observability_middleware
@rate_limit_middleware
@semantic_cache_middleware
async def my_agent(user_input: str, **kwargs):
    # 你的业务逻辑
    ...
```

### 方式三：选择不同的中间件栈

```python
from app.middleware import (
    lightweight_middleware_stack,      # 轻量级（开发环境）
    standard_middleware_stack,          # 标准（生产环境）
    high_availability_middleware_stack  # 高可用（关键业务）
)

# 开发环境
@lightweight_middleware_stack
async def dev_agent(user_input: str):
    ...

# 生产环境
@standard_middleware_stack
async def prod_agent(user_input: str):
    ...

# 关键业务
@high_availability_middleware_stack
async def critical_agent(user_input: str):
    ...
```

---

## 📖 中间件详解

### 1. 简单缓存中间件

**特性：**
- ✅ LRU 淘汰策略
- ✅ TTL 过期机制
- ✅ 线程安全
- ✅ 缓存统计

**使用示例：**

```python
from app.middleware import simple_cache_middleware, get_cache_stats

@simple_cache_middleware
async def my_function(user_input: str, **kwargs):
    return {"messages": [{"content": f"Response to: {user_input}"}]}

# 获取缓存统计
stats = get_cache_stats()
print(stats)
# {
#   "size": 45,
#   "max_size": 100,
#   "hits": 120,
#   "misses": 45,
#   "hit_rate": "72.73%",
#   "evictions": 0
# }
```

**配置参数：**

```python
# 在 .env 文件中配置
CACHE_MAX_SIZE=100        # 最大缓存条目数
CACHE_DEFAULT_TTL=3600    # 默认过期时间（秒）
```

---

### 2. 语义缓存中间件

**特性：**
- ✅ 基于向量相似度的语义匹配
- ✅ 自动持久化到磁盘
- ✅ 缓存预热
- ✅ 相似度可配置

**工作原理：**

```
用户问："Python怎么读文件？"
系统缓存了："如何用Python读取文件？"

→ 计算语义相似度
→ 相似度 0.08 < 阈值 0.15
→ 缓存命中！直接返回
```

**使用示例：**

```python
from app.middleware import semantic_cache_middleware, get_semantic_cache_stats

@semantic_cache_middleware
async def my_agent(user_input: str, **kwargs):
    # 即使问法不同，语义相似也能命中缓存
    ...

# 获取统计
stats = get_semantic_cache_stats()
print(stats)
# {
#   "cache_size": 156,
#   "hits": 89,
#   "misses": 234,
#   "hit_rate": "27.55%",
#   "avg_search_time": "0.023s"
# }
```

**配置参数：**

```python
CACHE_THRESHOLD=0.15                      # 相似度阈值
SEMANTIC_CACHE_MODEL=all-MiniLM-L6-v2    # Embedding模型
SEMANTIC_CACHE_PERSISTENCE=true           # 是否持久化
```

---

### 3. 日志监控中间件

**特性：**
- ✅ 结构化日志（JSON格式）
- ✅ 请求追踪（Trace ID）
- ✅ 性能监控（P50/P90/P95/P99）
- ✅ Token 统计

**使用示例：**

```python
from app.middleware import observability_middleware, get_performance_stats

@observability_middleware
async def my_agent(user_input: str, **kwargs):
    ...

# 获取性能统计
stats = get_performance_stats()
print(stats)
# {
#   "total_requests": 1000,
#   "successful_requests": 980,
#   "success_rate": "98.00%",
#   "latency": {
#     "avg": "2.345s",
#     "p50": "1.890s",
#     "p90": "3.456s",
#     "p95": "4.123s",
#     "p99": "6.789s"
#   },
#   "tokens": {
#     "total": 1234567,
#     "avg_per_request": 1234.56
#   }
# }
```

**日志输出示例：**

```json
{
  "event": "request_start",
  "trace_id": "a1b2c3d4",
  "timestamp": "2026-03-04T12:00:00.000Z",
  "user_input_preview": "你好，请帮我...",
  "user_input_length": 50
}

{
  "event": "request_end",
  "trace_id": "a1b2c3d4",
  "latency": "2.345s",
  "success": true,
  "response_length": 256
}
```

---

### 4. 限流中间件

**特性：**
- ✅ 令牌桶算法（处理突发流量）
- ✅ 滑动窗口算法（精确控制）
- ✅ 全局限流 + 用户级限流
- ✅ 限流统计

**使用示例：**

```python
from app.middleware import rate_limit_middleware, RateLimitError

@rate_limit_middleware
async def my_agent(user_input: str, user_id: str = None, **kwargs):
    ...

# 处理限流异常
try:
    result = await my_agent("你好", user_id="user123")
except RateLimitError as e:
    print(f"请求被限流: {e}")
    # 输出: "您的请求过于频繁，请在 2.5 秒后重试"
```

**配置参数：**

```python
RATE_LIMIT_ENABLED=true
RATE_LIMIT_ALGORITHM=token_bucket    # token_bucket 或 sliding_window
GLOBAL_RATE_LIMIT=10                 # 全局每秒10个请求
USER_RATE_LIMIT=2                    # 单用户每秒2个请求
```

---

### 5. 重试中间件

**特性：**
- ✅ 智能错误分类（可重试/不可重试）
- ✅ 多种重试策略（固定/指数退避/线性）
- ✅ 防止惊群（随机抖动）
- ✅ 重试统计

**使用示例：**

```python
from app.middleware import retry_middleware, with_retry, RetryStrategy

# 方式1：自定义重试策略
@retry_middleware(
    max_attempts=5,
    strategy=RetryStrategy.EXPONENTIAL,
    initial_delay=1.0,
    max_delay=60.0
)
async def unstable_api_call():
    ...

# 方式2：使用预设策略
@with_retry("aggressive")  # fast, standard, conservative, aggressive
async def critical_operation():
    ...
```

**重试策略对比：**

| 策略 | 延迟计算 | 适用场景 |
|------|----------|----------|
| **FIXED** | 固定延迟 | 快速重试 |
| **EXPONENTIAL** | 1s → 2s → 4s → 8s | 一般场景（推荐） |
| **LINEAR** | 1s → 2s → 3s → 4s | 轻量级操作 |

**错误分类示例：**

```python
# ✅ 可重试错误
- TimeoutError
- ConnectionError  
- 503 Service Unavailable
- 429 Too Many Requests

# ❌ 不可重试错误
- 400 Bad Request
- 401 Unauthorized
- 404 Not Found
- ValueError (参数错误)
```

---

## ⚙️ 配置说明

### 环境变量配置

在 `.env` 文件中添加以下配置：

```bash
# ==================== LLM 配置 ====================
DASHSCOPE_API_KEY=your_api_key_here
MODEL_NAME=qwen-max

# ==================== 缓存配置 ====================
# 简单缓存
CACHE_MAX_SIZE=100
CACHE_DEFAULT_TTL=3600

# 语义缓存
CACHE_THRESHOLD=0.15
SEMANTIC_CACHE_ENABLED=true
SEMANTIC_CACHE_MODEL=all-MiniLM-L6-v2
SEMANTIC_CACHE_PERSISTENCE=true

# ==================== 日志配置 ====================
LOG_LEVEL=INFO
LOG_FORMAT=structured
PERFORMANCE_METRICS_ENABLED=true

# ==================== 限流配置 ====================
RATE_LIMIT_ENABLED=true
RATE_LIMIT_ALGORITHM=token_bucket
GLOBAL_RATE_LIMIT=10
USER_RATE_LIMIT=2
RATE_LIMIT_WINDOW=60

# ==================== 重试配置 ====================
RETRY_ENABLED=true
RETRY_MAX_ATTEMPTS=3
RETRY_STRATEGY=exponential
RETRY_INITIAL_DELAY=1.0
RETRY_MAX_DELAY=60.0

# ==================== 应用配置 ====================
APP_ENV=production
MIDDLEWARE_STACK=standard
```

---

## 💡 使用示例

### 示例1：完整的 Agent 实现

```python
from app.middleware import standard_middleware_stack
from langchain_community.chat_models.tongyi import ChatTongyi

@standard_middleware_stack
async def intelligent_agent(user_input: str, session_id: str = None, **kwargs):
    """
    一个完整的智能 Agent
    
    自动包含：
    - 日志监控
    - 限流保护
    - 语义缓存
    - 自动重试
    """
    llm = ChatTongyi(model="qwen-max")
    response = await llm.ainvoke(user_input)
    
    return {
        "messages": [{
            "content": response.content
        }]
    }

# 使用
result = await intelligent_agent(
    user_input="Python如何读取文件？",
    session_id="user_123"
)
```

### 示例2：监控和统计

```python
from app.middleware import MiddlewareManager

# 获取所有中间件的统计信息
all_stats = MiddlewareManager.get_all_stats()
print(all_stats)

# 清空所有缓存
MiddlewareManager.clear_all_caches()

# 清理过期缓存
MiddlewareManager.cleanup()
```

### 示例3：动态配置限流

```python
from app.middleware import configure_rate_limiter

# 动态调整限流参数（适用于流量变化场景）
configure_rate_limiter(
    global_rate=20,      # 提高到每秒20个请求
    user_rate=5,         # 提高到每用户每秒5个请求
    algorithm="sliding_window"
)
```

---

## 🏆 最佳实践

### 1. 中间件顺序很重要

```python
# ✅ 推荐顺序（从外到内）
@observability_middleware      # 1. 最外层：记录所有请求
@rate_limit_middleware         # 2. 限流：尽早拒绝过载请求
@semantic_cache_middleware     # 3. 缓存：避免不必要的计算
@retry_middleware              # 4. 最内层：重试失败的操作
async def my_agent():
    ...

# ❌ 不推荐
@retry_middleware              # 重试在外层会导致缓存失效
@semantic_cache_middleware
async def bad_agent():
    ...
```

### 2. 根据场景选择中间件栈

```python
# 开发环境：快速迭代
@lightweight_middleware_stack

# 生产环境：平衡性能和可靠性
@standard_middleware_stack

# 关键业务：最大化可靠性
@high_availability_middleware_stack
```

### 3. 监控和告警

```python
import logging
from app.middleware import get_performance_stats, get_rate_limit_stats

# 定期检查系统健康状态
def health_check():
    perf = get_performance_stats()
    rate = get_rate_limit_stats()
    
    # 检查成功率
    if float(perf['success_rate'].rstrip('%')) < 95:
        logging.warning(f"成功率过低: {perf['success_rate']}")
    
    # 检查限流率
    if float(rate['limit_rate'].rstrip('%')) > 10:
        logging.warning(f"限流率过高: {rate['limit_rate']}")
```

### 4. 缓存策略选择

```python
# 场景1：问题重复度高 → 简单缓存
@simple_cache_middleware

# 场景2：问题表达多样 → 语义缓存
@semantic_cache_middleware

# 场景3：两者结合（推荐）
@simple_cache_middleware       # 精确匹配，速度快
@semantic_cache_middleware     # 语义匹配，覆盖广
async def best_cached_agent():
    ...
```

### 5. 错误处理

```python
from app.middleware import RateLimitError, retry_middleware

@retry_middleware(max_attempts=3)
async def robust_agent(user_input: str):
    try:
        result = await process(user_input)
        return result
    except RateLimitError:
        # 限流错误不应重试
        raise
    except ValueError:
        # 参数错误不应重试
        raise
    except Exception as e:
        # 其他错误会被重试中间件自动处理
        raise
```

---

## 📊 性能参考

### 缓存性能

| 操作 | 简单缓存 | 语义缓存 |
|------|----------|----------|
| 写入 | ~0.001s | ~0.020s |
| 命中 | ~0.001s | ~0.023s |
| 未命中 | ~0.001s | ~0.023s |

### 内存占用

- 简单缓存：~100KB (100条记录)
- 语义缓存：~50MB (1000条记录，含向量索引)

---

## 🔧 故障排除

### 问题1：语义缓存无法加载

**原因：** Embedding 模型未下载

**解决：**
```bash
# 手动下载模型
python -c "from langchain_huggingface import HuggingFaceEmbeddings; HuggingFaceEmbeddings(model_name='all-MiniLM-L6-v2')"
```

### 问题2：限流过于严格

**解决：** 调整 `.env` 配置
```bash
GLOBAL_RATE_LIMIT=20  # 提高全局QPS
USER_RATE_LIMIT=5     # 提高用户QPS
```

### 问题3：重试次数过多

**解决：** 检查错误类型，添加到不可重试列表
```python
from app.middleware.retry_middleware import ErrorClassifier

# 自定义不可重试关键词
ErrorClassifier.NON_RETRYABLE_KEYWORDS.append("your_custom_error")
```

---

## 📚 更多资源

- [LangChain 文档](https://python.langchain.com/)
- [FAISS 向量检索](https://github.com/facebookresearch/faiss)
- [限流算法详解](https://en.wikipedia.org/wiki/Rate_limiting)

---

**版本：** v1.0.0  
**最后更新：** 2026-03-04
