import asyncio
import logging
import time
from functools import wraps
from typing import Callable, Optional, Tuple, Type, List
from enum import Enum

logger = logging.getLogger("OmniAgent.Retry")


class RetryStrategy(Enum):
    """重试策略枚举"""
    FIXED = "fixed"              # 固定间隔
    EXPONENTIAL = "exponential"  # 指数退避
    LINEAR = "linear"            # 线性增长


class ErrorClassifier:
    """
    错误分类器
    
    将错误分为：
    - 可重试错误：如网络超时、服务端5xx错误
    - 不可重试错误：如参数错误、认证失败
    """
    
    # 可重试的异常类型（示例）
    RETRYABLE_EXCEPTIONS = (
        ConnectionError,
        TimeoutError,
        OSError,
    )
    
    # 可重试的异常名称关键词
    RETRYABLE_KEYWORDS = [
        "timeout",
        "connection",
        "network",
        "temporary",
        "unavailable",
        "overload",
        "rate limit",
        "503",
        "504",
        "429"
    ]
    
    # 不可重试的异常名称关键词
    NON_RETRYABLE_KEYWORDS = [
        "authentication",
        "authorization",
        "invalid",
        "forbidden",
        "not found",
        "400",
        "401",
        "403",
        "404"
    ]
    
    @classmethod
    def is_retryable(cls, exception: Exception) -> bool:
        """
        判断异常是否可重试
        
        Args:
            exception: 异常对象
        
        Returns:
            True if retryable, False otherwise
        """
        # 1. 检查异常类型
        if isinstance(exception, cls.RETRYABLE_EXCEPTIONS):
            return True
        
        # 2. 检查异常消息
        error_msg = str(exception).lower()
        
        # 优先检查不可重试关键词
        for keyword in cls.NON_RETRYABLE_KEYWORDS:
            if keyword in error_msg:
                return False
        
        # 检查可重试关键词
        for keyword in cls.RETRYABLE_KEYWORDS:
            if keyword in error_msg:
                return True
        
        # 默认不重试（保守策略）
        return False


class RetryPolicy:
    """
    重试策略配置
    
    支持多种重试策略和灵活配置
    """
    
    def __init__(
        self,
        max_attempts: int = 3,
        strategy: RetryStrategy = RetryStrategy.EXPONENTIAL,
        initial_delay: float = 1.0,
        max_delay: float = 60.0,
        exponential_base: float = 2.0,
        jitter: bool = True
    ):
        """
        Args:
            max_attempts: 最大重试次数
            strategy: 重试策略
            initial_delay: 初始延迟（秒）
            max_delay: 最大延迟（秒）
            exponential_base: 指数退避的基数
            jitter: 是否添加随机抖动（防止惊群）
        """
        self.max_attempts = max_attempts
        self.strategy = strategy
        self.initial_delay = initial_delay
        self.max_delay = max_delay
        self.exponential_base = exponential_base
        self.jitter = jitter
    
    def calculate_delay(self, attempt: int) -> float:
        """
        计算重试延迟
        
        Args:
            attempt: 当前是第几次重试（从1开始）
        
        Returns:
            延迟时间（秒）
        """
        if self.strategy == RetryStrategy.FIXED:
            delay = self.initial_delay
            
        elif self.strategy == RetryStrategy.EXPONENTIAL:
            # 指数退避: delay = initial * (base ^ attempt)
            delay = self.initial_delay * (self.exponential_base ** (attempt - 1))
            
        elif self.strategy == RetryStrategy.LINEAR:
            # 线性增长: delay = initial * attempt
            delay = self.initial_delay * attempt
            
        else:
            delay = self.initial_delay
        
        # 限制最大延迟
        delay = min(delay, self.max_delay)
        
        # 添加随机抖动（0-20%）
        if self.jitter:
            import random
            jitter_factor = random.uniform(0.8, 1.2)
            delay *= jitter_factor
        
        return delay


class RetryStats:
    """重试统计信息"""
    
    def __init__(self):
        self.total_calls = 0
        self.successful_calls = 0
        self.failed_calls = 0
        self.total_retries = 0
        self.retry_success = 0  # 重试后成功的次数
        self.retry_exhausted = 0  # 重试次数耗尽的次数
    
    def record_call(self, success: bool, retries: int):
        """记录一次调用"""
        self.total_calls += 1
        
        if success:
            self.successful_calls += 1
            if retries > 0:
                self.retry_success += 1
        else:
            self.failed_calls += 1
            self.retry_exhausted += 1
        
        self.total_retries += retries
    
    def get_stats(self) -> dict:
        """获取统计信息"""
        success_rate = (
            (self.successful_calls / self.total_calls * 100)
            if self.total_calls > 0 else 0
        )
        
        avg_retries = (
            self.total_retries / self.total_calls
            if self.total_calls > 0 else 0
        )
        
        return {
            "total_calls": self.total_calls,
            "successful_calls": self.successful_calls,
            "failed_calls": self.failed_calls,
            "success_rate": f"{success_rate:.2f}%",
            "total_retries": self.total_retries,
            "avg_retries_per_call": f"{avg_retries:.2f}",
            "retry_success": self.retry_success,
            "retry_exhausted": self.retry_exhausted
        }


# 全局重试统计
_RETRY_STATS = RetryStats()


def retry_middleware(
    max_attempts: int = 3,
    strategy: RetryStrategy = RetryStrategy.EXPONENTIAL,
    initial_delay: float = 1.0,
    max_delay: float = 60.0,
    retryable_exceptions: Optional[Tuple[Type[Exception], ...]] = None,
    on_retry: Optional[Callable] = None
):
    """
    重试中间件装饰器
    
    功能：
    - 自动重试失败的请求
    - 支持多种重试策略（固定、指数退避、线性）
    - 智能错误分类（区分可重试和不可重试错误）
    - 防止惊群（添加随机抖动）
    - 统计重试效果
    
    Args:
        max_attempts: 最大尝试次数（包括首次）
        strategy: 重试策略
        initial_delay: 初始延迟（秒）
        max_delay: 最大延迟（秒）
        retryable_exceptions: 可重试的异常类型元组
        on_retry: 重试时的回调函数
    
    Returns:
        装饰器函数
    
    Example:
        @retry_middleware(max_attempts=3, strategy=RetryStrategy.EXPONENTIAL)
        async def call_api():
            ...
    """
    
    def decorator(func):
        @wraps(func)
        async def wrapper(*args, **kwargs):
            policy = RetryPolicy(
                max_attempts=max_attempts,
                strategy=strategy,
                initial_delay=initial_delay,
                max_delay=max_delay
            )
            
            last_exception = None
            retries = 0
            
            for attempt in range(1, max_attempts + 1):
                try:
                    # 尝试执行函数
                    result = await func(*args, **kwargs)
                    
                    # 成功
                    if attempt > 1:
                        logger.info(f"✅ 第 {attempt} 次尝试成功（重试 {retries} 次后）")
                    
                    _RETRY_STATS.record_call(success=True, retries=retries)
                    return result
                    
                except Exception as e:
                    last_exception = e
                    
                    # 检查是否可重试
                    should_retry = ErrorClassifier.is_retryable(e)
                    
                    # 如果指定了可重试异常类型，也要检查
                    if retryable_exceptions and isinstance(e, retryable_exceptions):
                        should_retry = True
                    
                    # 是否还有重试机会
                    has_more_attempts = attempt < max_attempts
                    
                    if should_retry and has_more_attempts:
                        retries += 1
                        delay = policy.calculate_delay(attempt)
                        
                        logger.warning(
                            f"⚠️ 第 {attempt} 次尝试失败: {type(e).__name__}: {str(e)[:100]}"
                        )
                        logger.info(
                            f"🔄 将在 {delay:.2f}秒 后进行第 {attempt + 1} 次尝试..."
                        )
                        
                        # 调用重试回调
                        if on_retry:
                            try:
                                on_retry(attempt, delay, e)
                            except Exception as callback_error:
                                logger.error(f"重试回调函数出错: {callback_error}")
                        
                        # 等待后重试
                        await asyncio.sleep(delay)
                        
                    else:
                        # 不可重试或重试次数耗尽
                        if not should_retry:
                            logger.error(
                                f"❌ 错误不可重试: {type(e).__name__}: {str(e)[:100]}"
                            )
                        else:
                            logger.error(
                                f"❌ 已达最大重试次数 ({max_attempts})，放弃重试"
                            )
                        
                        _RETRY_STATS.record_call(success=False, retries=retries)
                        raise
            
            # 理论上不会到这里，但为了安全
            _RETRY_STATS.record_call(success=False, retries=retries)
            raise last_exception
        
        return wrapper
    return decorator


def get_retry_stats() -> dict:
    """获取重试统计信息"""
    return _RETRY_STATS.get_stats()


def reset_retry_stats():
    """重置重试统计"""
    global _RETRY_STATS
    _RETRY_STATS = RetryStats()
    logger.info("重试统计已重置")


# 预定义的重试策略
class RetryPresets:
    """预定义的常用重试策略"""
    
    # 快速重试（适合轻量级操作）
    FAST = {
        "max_attempts": 3,
        "strategy": RetryStrategy.FIXED,
        "initial_delay": 0.5,
        "max_delay": 2.0
    }
    
    # 标准重试（适合一般API调用）
    STANDARD = {
        "max_attempts": 3,
        "strategy": RetryStrategy.EXPONENTIAL,
        "initial_delay": 1.0,
        "max_delay": 30.0
    }
    
    # 保守重试（适合重要但慢的操作）
    CONSERVATIVE = {
        "max_attempts": 5,
        "strategy": RetryStrategy.EXPONENTIAL,
        "initial_delay": 2.0,
        "max_delay": 60.0
    }
    
    # 激进重试（适合高度容错的场景）
    AGGRESSIVE = {
        "max_attempts": 10,
        "strategy": RetryStrategy.LINEAR,
        "initial_delay": 0.1,
        "max_delay": 10.0
    }


def with_retry(preset: str = "standard"):
    """
    使用预设策略的便捷装饰器
    
    Args:
        preset: 预设名称 (fast, standard, conservative, aggressive)
    
    Example:
        @with_retry("fast")
        async def quick_api_call():
            ...
    """
    preset_configs = {
        "fast": RetryPresets.FAST,
        "standard": RetryPresets.STANDARD,
        "conservative": RetryPresets.CONSERVATIVE,
        "aggressive": RetryPresets.AGGRESSIVE
    }
    
    config = preset_configs.get(preset.lower(), RetryPresets.STANDARD)
    return retry_middleware(**config)
