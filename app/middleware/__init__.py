"""
OmniAgent 中间件模块

提供完整的请求处理中间件链：
- 缓存：降低大模型调用成本
- 日志：可观测性和性能监控
- 限流：保护系统资源
- 重试：提升系统可靠性

使用示例：
    from app.middleware import (
        simple_cache_middleware,
        semantic_cache_middleware,
        observability_middleware,
        rate_limit_middleware,
        retry_middleware
    )
    
    # 组合使用多个中间件
    @observability_middleware
    @rate_limit_middleware
    @semantic_cache_middleware
    async def my_agent_function(user_input, **kwargs):
        ...
"""

# ============================================================================
# 缓存中间件
# ============================================================================
from .cache_middleware import (
    simple_cache_middleware,
    LRUCache,
    get_cache_stats,
    clear_cache,
    cleanup_expired_cache
)

from .semantic_cache import (
    semantic_cache_middleware,
    SemanticCache,
    get_semantic_cache_stats,
    clear_semantic_cache
)

# ============================================================================
# 日志和监控中间件
# ============================================================================
from .logger_middleware import (
    observability_middleware,
    PerformanceMetrics,
    StructuredLogger,
    get_performance_stats,
    reset_performance_stats,
    log_performance_summary,
    log_tool_call,
    log_cache_event,
    log_llm_call
)

# ============================================================================
# 限流中间件
# ============================================================================
from .rate_limiter import (
    rate_limit_middleware,
    RateLimiter,
    RateLimitError,
    TokenBucket,
    SlidingWindowCounter,
    get_rate_limit_stats,
    configure_rate_limiter
)

# ============================================================================
# 重试中间件
# ============================================================================
from .retry_middleware import (
    retry_middleware,
    with_retry,
    RetryStrategy,
    RetryPolicy,
    RetryPresets,
    ErrorClassifier,
    get_retry_stats,
    reset_retry_stats
)


# ============================================================================
# 统一的中间件管理器
# ============================================================================
class MiddlewareManager:
    """
    中间件管理器
    
    提供统一的接口来管理所有中间件的配置和统计
    """
    
    @staticmethod
    def get_all_stats():
        """获取所有中间件的统计信息"""
        return {
            "cache": get_cache_stats(),
            "semantic_cache": get_semantic_cache_stats(),
            "performance": get_performance_stats(),
            "rate_limiter": get_rate_limit_stats(),
            "retry": get_retry_stats()
        }
    
    @staticmethod
    def reset_all_stats():
        """重置所有统计信息"""
        reset_performance_stats()
        reset_retry_stats()
        # Note: 缓存和限流器的统计不重置，因为它们涉及实际数据
    
    @staticmethod
    def clear_all_caches():
        """清空所有缓存"""
        clear_cache()
        clear_semantic_cache()
    
    @staticmethod
    def cleanup():
        """执行清理操作"""
        cleanup_expired_cache()


# ============================================================================
# 预定义的中间件组合
# ============================================================================
def standard_middleware_stack(func):
    """
    标准中间件栈
    
    适用于大多数生产场景的中间件组合：
    1. 日志监控（最外层，记录所有请求）
    2. 限流保护
    3. 语义缓存（智能缓存）
    4. 重试机制（最内层，靠近业务逻辑）
    
    使用示例：
        @standard_middleware_stack
        async def my_agent(user_input):
            ...
    """
    from functools import wraps
    
    @wraps(func)
    @observability_middleware
    @rate_limit_middleware
    @semantic_cache_middleware
    @retry_middleware(max_attempts=3, strategy=RetryStrategy.EXPONENTIAL)
    async def wrapper(*args, **kwargs):
        return await func(*args, **kwargs)
    
    return wrapper


def lightweight_middleware_stack(func):
    """
    轻量级中间件栈
    
    适用于开发环境或对性能要求高的场景：
    1. 日志监控
    2. 简单缓存
    
    使用示例：
        @lightweight_middleware_stack
        async def my_agent(user_input):
            ...
    """
    from functools import wraps
    
    @wraps(func)
    @observability_middleware
    @simple_cache_middleware
    async def wrapper(*args, **kwargs):
        return await func(*args, **kwargs)
    
    return wrapper


def high_availability_middleware_stack(func):
    """
    高可用中间件栈
    
    适用于对可靠性要求极高的场景：
    1. 日志监控
    2. 限流保护
    3. 语义缓存
    4. 激进重试策略
    
    使用示例：
        @high_availability_middleware_stack
        async def critical_agent(user_input):
            ...
    """
    from functools import wraps
    
    @wraps(func)
    @observability_middleware
    @rate_limit_middleware
    @semantic_cache_middleware
    @with_retry("aggressive")
    async def wrapper(*args, **kwargs):
        return await func(*args, **kwargs)
    
    return wrapper


# ============================================================================
# 导出所有公共接口
# ============================================================================
__all__ = [
    # 缓存中间件
    "simple_cache_middleware",
    "semantic_cache_middleware",
    "LRUCache",
    "SemanticCache",
    "get_cache_stats",
    "get_semantic_cache_stats",
    "clear_cache",
    "clear_semantic_cache",
    "cleanup_expired_cache",
    
    # 日志监控中间件
    "observability_middleware",
    "PerformanceMetrics",
    "StructuredLogger",
    "get_performance_stats",
    "reset_performance_stats",
    "log_performance_summary",
    "log_tool_call",
    "log_cache_event",
    "log_llm_call",
    
    # 限流中间件
    "rate_limit_middleware",
    "RateLimiter",
    "RateLimitError",
    "TokenBucket",
    "SlidingWindowCounter",
    "get_rate_limit_stats",
    "configure_rate_limiter",
    
    # 重试中间件
    "retry_middleware",
    "with_retry",
    "RetryStrategy",
    "RetryPolicy",
    "RetryPresets",
    "ErrorClassifier",
    "get_retry_stats",
    "reset_retry_stats",
    
    # 中间件管理
    "MiddlewareManager",
    
    # 预定义中间件栈
    "standard_middleware_stack",
    "lightweight_middleware_stack",
    "high_availability_middleware_stack",
]
