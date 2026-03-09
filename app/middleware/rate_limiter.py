import time
import logging
from functools import wraps
from collections import defaultdict, deque
from threading import Lock
from typing import Dict, Optional, Tuple

logger = logging.getLogger("OmniAgent.RateLimiter")


class TokenBucket:
    """
    令牌桶算法实现
    
    原理：
    - 桶以固定速率生成令牌
    - 请求必须消耗令牌才能通过
    - 桶有最大容量，多余令牌会溢出
    - 适合处理突发流量
    """
    
    def __init__(self, capacity: int, refill_rate: float):
        """
        Args:
            capacity: 桶的容量（最大令牌数）
            refill_rate: 令牌生成速率（令牌/秒）
        """
        self.capacity = capacity
        self.refill_rate = refill_rate
        self.tokens = float(capacity)
        self.last_refill = time.time()
        self.lock = Lock()
    
    def _refill(self):
        """补充令牌"""
        now = time.time()
        elapsed = now - self.last_refill
        
        # 计算应该补充的令牌数
        new_tokens = elapsed * self.refill_rate
        self.tokens = min(self.capacity, self.tokens + new_tokens)
        self.last_refill = now
    
    def consume(self, tokens: int = 1) -> bool:
        """
        尝试消耗令牌
        
        Args:
            tokens: 需要消耗的令牌数
        
        Returns:
            True if successful, False if rate limited
        """
        with self.lock:
            self._refill()
            
            if self.tokens >= tokens:
                self.tokens -= tokens
                return True
            return False
    
    def get_wait_time(self, tokens: int = 1) -> float:
        """
        获取需要等待多久才能获取足够的令牌
        
        Args:
            tokens: 需要的令牌数
        
        Returns:
            等待时间（秒）
        """
        with self.lock:
            self._refill()
            
            if self.tokens >= tokens:
                return 0.0
            
            # 计算需要等待多久
            needed_tokens = tokens - self.tokens
            wait_time = needed_tokens / self.refill_rate
            return wait_time


class SlidingWindowCounter:
    """
    滑动窗口计数器
    
    原理：
    - 记录固定时间窗口内的请求数
    - 窗口随时间滑动
    - 超过阈值则限流
    - 适合精确控制时间窗口内的请求数
    """
    
    def __init__(self, window_size: int, max_requests: int):
        """
        Args:
            window_size: 时间窗口大小（秒）
            max_requests: 窗口内最大请求数
        """
        self.window_size = window_size
        self.max_requests = max_requests
        self.requests: deque = deque()
        self.lock = Lock()
    
    def _cleanup_old_requests(self):
        """清理窗口外的旧请求"""
        now = time.time()
        cutoff = now - self.window_size
        
        while self.requests and self.requests[0] < cutoff:
            self.requests.popleft()
    
    def allow_request(self) -> Tuple[bool, int]:
        """
        检查是否允许请求
        
        Returns:
            (是否允许, 当前窗口内的请求数)
        """
        with self.lock:
            self._cleanup_old_requests()
            
            current_count = len(self.requests)
            
            if current_count < self.max_requests:
                self.requests.append(time.time())
                return True, current_count + 1
            
            return False, current_count
    
    def get_retry_after(self) -> float:
        """
        获取多久后可以重试
        
        Returns:
            重试等待时间（秒）
        """
        with self.lock:
            self._cleanup_old_requests()
            
            if len(self.requests) < self.max_requests:
                return 0.0
            
            # 返回最早的请求过期所需时间
            oldest_request = self.requests[0]
            retry_after = (oldest_request + self.window_size) - time.time()
            return max(0.0, retry_after)


class RateLimiter:
    """
    综合限流器
    
    支持：
    - 全局限流：控制系统总体QPS
    - 用户级限流：控制单个用户的请求频率
    - 灵活策略：支持令牌桶和滑动窗口两种算法
    """
    
    def __init__(
        self,
        global_rate: Optional[int] = None,  # 全局QPS限制
        user_rate: Optional[int] = None,     # 单用户QPS限制
        window_size: int = 60,                # 时间窗口（秒）
        algorithm: str = "token_bucket"       # 算法：token_bucket 或 sliding_window
    ):
        """
        Args:
            global_rate: 全局每秒请求数限制（None表示不限制）
            user_rate: 单用户每秒请求数限制（None表示不限制）
            window_size: 滑动窗口大小（仅滑动窗口算法使用）
            algorithm: 限流算法（token_bucket 或 sliding_window）
        """
        self.global_rate = global_rate
        self.user_rate = user_rate
        self.window_size = window_size
        self.algorithm = algorithm
        
        # 全局限流器
        if global_rate:
            if algorithm == "token_bucket":
                self.global_limiter = TokenBucket(
                    capacity=global_rate * 2,  # 允许2倍突发
                    refill_rate=global_rate
                )
            else:
                self.global_limiter = SlidingWindowCounter(
                    window_size=window_size,
                    max_requests=global_rate * window_size
                )
        else:
            self.global_limiter = None
        
        # 用户级限流器（字典）
        self.user_limiters: Dict = defaultdict(self._create_user_limiter)
        self.user_limiters_lock = Lock()
        
        # 统计
        self.total_requests = 0
        self.limited_requests = 0
    
    def _create_user_limiter(self):
        """创建用户级限流器"""
        if not self.user_rate:
            return None
        
        if self.algorithm == "token_bucket":
            return TokenBucket(
                capacity=self.user_rate * 2,
                refill_rate=self.user_rate
            )
        else:
            return SlidingWindowCounter(
                window_size=self.window_size,
                max_requests=self.user_rate * self.window_size
            )
    
    def check_rate_limit(self, user_id: Optional[str] = None) -> Tuple[bool, Optional[str]]:
        """
        检查是否超出限流
        
        Args:
            user_id: 用户标识（用于用户级限流）
        
        Returns:
            (是否允许请求, 错误消息)
        """
        self.total_requests += 1
        
        # 1. 检查全局限流
        if self.global_limiter:
            if self.algorithm == "token_bucket":
                if not self.global_limiter.consume():
                    wait_time = self.global_limiter.get_wait_time()
                    self.limited_requests += 1
                    logger.warning(f"🚫 触发全局限流，建议等待 {wait_time:.2f}秒")
                    return False, f"系统繁忙，请在 {wait_time:.1f} 秒后重试"
            else:
                allowed, count = self.global_limiter.allow_request()
                if not allowed:
                    retry_after = self.global_limiter.get_retry_after()
                    self.limited_requests += 1
                    logger.warning(f"🚫 触发全局限流，当前窗口请求数: {count}")
                    return False, f"系统繁忙，请在 {retry_after:.1f} 秒后重试"
        
        # 2. 检查用户级限流
        if user_id and self.user_rate:
            with self.user_limiters_lock:
                user_limiter = self.user_limiters[user_id]
            
            if user_limiter:
                if self.algorithm == "token_bucket":
                    if not user_limiter.consume():
                        wait_time = user_limiter.get_wait_time()
                        self.limited_requests += 1
                        logger.warning(f"🚫 用户 {user_id} 触发限流，建议等待 {wait_time:.2f}秒")
                        return False, f"您的请求过于频繁，请在 {wait_time:.1f} 秒后重试"
                else:
                    allowed, count = user_limiter.allow_request()
                    if not allowed:
                        retry_after = user_limiter.get_retry_after()
                        self.limited_requests += 1
                        logger.warning(f"🚫 用户 {user_id} 触发限流")
                        return False, f"您的请求过于频繁，请在 {retry_after:.1f} 秒后重试"
        
        return True, None
    
    def get_stats(self) -> Dict:
        """获取限流统计"""
        limit_rate = (
            (self.limited_requests / self.total_requests * 100)
            if self.total_requests > 0 else 0
        )
        
        return {
            "total_requests": self.total_requests,
            "limited_requests": self.limited_requests,
            "limit_rate": f"{limit_rate:.2f}%",
            "algorithm": self.algorithm,
            "global_rate": self.global_rate,
            "user_rate": self.user_rate
        }


# 全局限流器实例
# 示例配置：全局10 QPS，单用户2 QPS
_GLOBAL_RATE_LIMITER = RateLimiter(
    global_rate=10,      # 全局每秒10个请求
    user_rate=2,         # 单用户每秒2个请求
    window_size=60,      # 60秒窗口
    algorithm="token_bucket"  # 使用令牌桶算法
)


class RateLimitError(Exception):
    """限流异常"""
    pass


def rate_limit_middleware(func):
    """
    限流中间件：保护系统免受过载
    
    功能：
    - 防止系统过载
    - 公平分配资源
    - 防止恶意攻刷
    - 保护下游服务
    
    Args:
        func: 被装饰的异步函数
    
    Returns:
        装饰后的函数
    """
    @wraps(func)
    async def wrapper(*args, **kwargs):
        # 尝试从kwargs中提取用户ID
        user_id = kwargs.get("user_id") or kwargs.get("session_id")
        
        # 检查限流
        allowed, error_msg = _GLOBAL_RATE_LIMITER.check_rate_limit(user_id)
        
        if not allowed:
            logger.warning(f"请求被限流: {error_msg}")
            raise RateLimitError(error_msg)
        
        # 限流通过，执行请求
        return await func(*args, **kwargs)
    
    return wrapper


def get_rate_limit_stats() -> Dict:
    """获取限流统计信息"""
    return _GLOBAL_RATE_LIMITER.get_stats()


def configure_rate_limiter(
    global_rate: Optional[int] = None,
    user_rate: Optional[int] = None,
    window_size: int = 60,
    algorithm: str = "token_bucket"
):
    """
    动态配置限流器
    
    Args:
        global_rate: 全局QPS限制
        user_rate: 单用户QPS限制
        window_size: 时间窗口
        algorithm: 算法类型
    """
    global _GLOBAL_RATE_LIMITER
    _GLOBAL_RATE_LIMITER = RateLimiter(
        global_rate=global_rate,
        user_rate=user_rate,
        window_size=window_size,
        algorithm=algorithm
    )
    logger.info(f"限流器配置已更新: 全局={global_rate}, 用户={user_rate}, 算法={algorithm}")
