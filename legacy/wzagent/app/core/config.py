import os
from dotenv import load_dotenv

load_dotenv()

# ============================================================================
# LLM 配置
# ============================================================================
API_KEY = os.getenv("DASHSCOPE_API_KEY")
MODEL_NAME = os.getenv("MODEL_NAME", "qwen-max")

# ============================================================================
# 缓存配置
# ============================================================================
# 简单缓存配置
CACHE_MAX_SIZE = int(os.getenv("CACHE_MAX_SIZE", "100"))  # LRU缓存最大条目数
CACHE_DEFAULT_TTL = int(os.getenv("CACHE_DEFAULT_TTL", "3600"))  # 默认缓存过期时间（秒），1小时

# 语义缓存配置
CACHE_THRESHOLD = float(os.getenv("CACHE_THRESHOLD", "0.15"))  # 语义相似度阈值 (L2距离)
SEMANTIC_CACHE_ENABLED = os.getenv("SEMANTIC_CACHE_ENABLED", "true").lower() == "true"
SEMANTIC_CACHE_MODEL = os.getenv("SEMANTIC_CACHE_MODEL", "all-MiniLM-L6-v2")  # Embedding模型
SEMANTIC_CACHE_PERSISTENCE = os.getenv("SEMANTIC_CACHE_PERSISTENCE", "true").lower() == "true"

# ============================================================================
# 日志和监控配置
# ============================================================================
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")  # DEBUG, INFO, WARNING, ERROR
LOG_FORMAT = os.getenv("LOG_FORMAT", "structured")  # structured 或 simple
PERFORMANCE_METRICS_ENABLED = os.getenv("PERFORMANCE_METRICS_ENABLED", "true").lower() == "true"
PERFORMANCE_METRICS_SAMPLE_SIZE = int(os.getenv("PERFORMANCE_METRICS_SAMPLE_SIZE", "1000"))

# ============================================================================
# 限流配置
# ============================================================================
RATE_LIMIT_ENABLED = os.getenv("RATE_LIMIT_ENABLED", "true").lower() == "true"
RATE_LIMIT_ALGORITHM = os.getenv("RATE_LIMIT_ALGORITHM", "token_bucket")  # token_bucket 或 sliding_window

# 全局限流
GLOBAL_RATE_LIMIT = int(os.getenv("GLOBAL_RATE_LIMIT", "10"))  # 全局每秒请求数
GLOBAL_RATE_LIMIT_ENABLED = os.getenv("GLOBAL_RATE_LIMIT_ENABLED", "true").lower() == "true"

# 用户级限流
USER_RATE_LIMIT = int(os.getenv("USER_RATE_LIMIT", "2"))  # 单用户每秒请求数
USER_RATE_LIMIT_ENABLED = os.getenv("USER_RATE_LIMIT_ENABLED", "true").lower() == "true"

# 限流窗口大小
RATE_LIMIT_WINDOW = int(os.getenv("RATE_LIMIT_WINDOW", "60"))  # 滑动窗口大小（秒）

# ============================================================================
# 重试配置
# ============================================================================
RETRY_ENABLED = os.getenv("RETRY_ENABLED", "true").lower() == "true"
RETRY_MAX_ATTEMPTS = int(os.getenv("RETRY_MAX_ATTEMPTS", "3"))  # 最大重试次数
RETRY_STRATEGY = os.getenv("RETRY_STRATEGY", "exponential")  # fixed, exponential, linear
RETRY_INITIAL_DELAY = float(os.getenv("RETRY_INITIAL_DELAY", "1.0"))  # 初始延迟（秒）
RETRY_MAX_DELAY = float(os.getenv("RETRY_MAX_DELAY", "60.0"))  # 最大延迟（秒）
RETRY_EXPONENTIAL_BASE = float(os.getenv("RETRY_EXPONENTIAL_BASE", "2.0"))  # 指数退避基数
RETRY_JITTER = os.getenv("RETRY_JITTER", "true").lower() == "true"  # 是否添加随机抖动

# ============================================================================
# 中间件组合策略
# ============================================================================
MIDDLEWARE_STACK = os.getenv("MIDDLEWARE_STACK", "standard")  # standard, lightweight, high_availability

# ============================================================================
# 应用配置
# ============================================================================
APP_ENV = os.getenv("APP_ENV", "development")  # development, production, test
DEBUG_MODE = os.getenv("DEBUG_MODE", "false").lower() == "true"

# ============================================================================
# 配置验证
# ============================================================================
def validate_config():
    """验证配置的有效性"""
    errors = []
    
    # 验证API密钥
    if not API_KEY:
        errors.append("DASHSCOPE_API_KEY 未设置")
    
    # 验证缓存阈值
    if not 0 <= CACHE_THRESHOLD <= 2:
        errors.append(f"CACHE_THRESHOLD 应在 0-2 之间，当前值: {CACHE_THRESHOLD}")
    
    # 验证限流参数
    if GLOBAL_RATE_LIMIT <= 0:
        errors.append(f"GLOBAL_RATE_LIMIT 必须大于0，当前值: {GLOBAL_RATE_LIMIT}")
    
    if USER_RATE_LIMIT <= 0:
        errors.append(f"USER_RATE_LIMIT 必须大于0，当前值: {USER_RATE_LIMIT}")
    
    # 验证重试参数
    if RETRY_MAX_ATTEMPTS < 1:
        errors.append(f"RETRY_MAX_ATTEMPTS 必须至少为1，当前值: {RETRY_MAX_ATTEMPTS}")
    
    if RETRY_STRATEGY not in ["fixed", "exponential", "linear"]:
        errors.append(f"RETRY_STRATEGY 必须是 fixed/exponential/linear 之一，当前值: {RETRY_STRATEGY}")
    
    if errors:
        raise ValueError(f"配置验证失败:\n" + "\n".join(f"  - {e}" for e in errors))


def get_config_summary():
    """获取配置摘要（用于日志输出）"""
    return {
        "app": {
            "env": APP_ENV,
            "debug": DEBUG_MODE,
            "middleware_stack": MIDDLEWARE_STACK
        },
        "llm": {
            "model": MODEL_NAME,
            "api_key_set": bool(API_KEY)
        },
        "cache": {
            "simple_cache": {
                "max_size": CACHE_MAX_SIZE,
                "default_ttl": CACHE_DEFAULT_TTL
            },
            "semantic_cache": {
                "enabled": SEMANTIC_CACHE_ENABLED,
                "threshold": CACHE_THRESHOLD,
                "model": SEMANTIC_CACHE_MODEL,
                "persistence": SEMANTIC_CACHE_PERSISTENCE
            }
        },
        "rate_limit": {
            "enabled": RATE_LIMIT_ENABLED,
            "algorithm": RATE_LIMIT_ALGORITHM,
            "global": GLOBAL_RATE_LIMIT if GLOBAL_RATE_LIMIT_ENABLED else "disabled",
            "per_user": USER_RATE_LIMIT if USER_RATE_LIMIT_ENABLED else "disabled",
            "window": RATE_LIMIT_WINDOW
        },
        "retry": {
            "enabled": RETRY_ENABLED,
            "max_attempts": RETRY_MAX_ATTEMPTS,
            "strategy": RETRY_STRATEGY,
            "initial_delay": RETRY_INITIAL_DELAY,
            "max_delay": RETRY_MAX_DELAY
        },
        "logging": {
            "level": LOG_LEVEL,
            "format": LOG_FORMAT,
            "metrics_enabled": PERFORMANCE_METRICS_ENABLED
        }
    }


# 启动时验证配置
if __name__ != "__main__":
    try:
        validate_config()
    except ValueError as e:
        import logging
        logging.error(f"配置错误: {e}")
        # 在生产环境中，可能需要抛出异常而不是只记录日志
        if APP_ENV == "production":
            raise
