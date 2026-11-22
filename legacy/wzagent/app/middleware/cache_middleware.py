import logging
import time
from functools import wraps
from collections import OrderedDict
from threading import Lock
from typing import Optional, Dict, Tuple, Any

logger = logging.getLogger("OmniAgent.Cache")

class CacheEntry:
    """缓存条目，支持TTL（生存时间）"""
    def __init__(self, value: Any, ttl: Optional[float] = None):
        self.value = value
        self.created_at = time.time()
        self.ttl = ttl
        self.hit_count = 0
    
    def is_expired(self) -> bool:
        """检查缓存是否过期"""
        if self.ttl is None:
            return False
        return (time.time() - self.created_at) > self.ttl
    
    def get_age(self) -> float:
        """获取缓存年龄（秒）"""
        return time.time() - self.created_at


class LRUCache:
    """
    带TTL和统计功能的LRU缓存
    
    特性：
    - LRU淘汰策略
    - TTL过期机制
    - 线程安全
    - 缓存统计（命中率、大小）
    """
    def __init__(self, max_size: int = 100, default_ttl: Optional[float] = 3600):
        self.max_size = max_size
        self.default_ttl = default_ttl
        self.cache: OrderedDict[str, CacheEntry] = OrderedDict()
        self.lock = Lock()
        
        # 统计信息
        self.hits = 0
        self.misses = 0
        self.evictions = 0
    
    def get(self, key: str) -> Optional[Any]:
        """获取缓存值"""
        with self.lock:
            if key not in self.cache:
                self.misses += 1
                return None
            
            entry = self.cache[key]
            
            # 检查是否过期
            if entry.is_expired():
                logger.debug(f"缓存已过期: {key}, 年龄: {entry.get_age():.2f}s")
                del self.cache[key]
                self.misses += 1
                return None
            
            # 命中，移动到末尾（最近使用）
            self.cache.move_to_end(key)
            entry.hit_count += 1
            self.hits += 1
            
            logger.debug(f"缓存命中: {key}, 命中次数: {entry.hit_count}")
            return entry.value
    
    def set(self, key: str, value: Any, ttl: Optional[float] = None):
        """设置缓存值"""
        with self.lock:
            # 如果key已存在，先删除
            if key in self.cache:
                del self.cache[key]
            
            # 如果缓存已满，删除最旧的项
            while len(self.cache) >= self.max_size:
                oldest_key = next(iter(self.cache))
                del self.cache[oldest_key]
                self.evictions += 1
                logger.debug(f"缓存已满，淘汰最旧条目: {oldest_key}")
            
            # 添加新条目
            entry = CacheEntry(value, ttl or self.default_ttl)
            self.cache[key] = entry
            logger.debug(f"写入缓存: {key}, TTL: {entry.ttl}s")
    
    def clear(self):
        """清空缓存"""
        with self.lock:
            self.cache.clear()
            logger.info("缓存已清空")
    
    def get_stats(self) -> Dict[str, Any]:
        """获取缓存统计信息"""
        with self.lock:
            total_requests = self.hits + self.misses
            hit_rate = (self.hits / total_requests * 100) if total_requests > 0 else 0
            
            return {
                "size": len(self.cache),
                "max_size": self.max_size,
                "hits": self.hits,
                "misses": self.misses,
                "hit_rate": f"{hit_rate:.2f}%",
                "evictions": self.evictions,
                "total_requests": total_requests
            }
    
    def cleanup_expired(self):
        """清理过期的缓存条目"""
        with self.lock:
            expired_keys = [
                key for key, entry in self.cache.items() 
                if entry.is_expired()
            ]
            for key in expired_keys:
                del self.cache[key]
            
            if expired_keys:
                logger.info(f"清理了 {len(expired_keys)} 个过期缓存条目")


# 全局缓存实例
_GLOBAL_CACHE = LRUCache(max_size=100, default_ttl=3600)  # 默认1小时TTL

# 预置一些常见问题的缓存
_GLOBAL_CACHE.set("你好", "你好！我是 OmniAgent，有什么可以帮您？", ttl=None)  # 永不过期
_GLOBAL_CACHE.set("你是谁", "我是 OmniAgent，一个基于多智能体架构的AI助手。", ttl=None)


def simple_cache_middleware(func):
    """
    简单缓存中间件：基于LRU策略的内存缓存，支持TTL过期。
    
    用于快速响应重复问题，降低大模型调用成本。
    生产环境可替换为 Redis 或其他分布式缓存。
    
    参数:
        func: 被装饰的异步函数
    
    返回:
        装饰后的函数
    """
    @wraps(func)
    async def wrapper(*args, **kwargs):
        # 从 kwargs 中提取用户输入
        user_input = kwargs.get("user_input", "")
        
        if not user_input:
            # 没有用户输入，直接调用原函数
            return await func(*args, **kwargs)
        
        # 1. 尝试从缓存获取
        cached_result = _GLOBAL_CACHE.get(user_input)
        if cached_result is not None:
            logger.info(f"🎯 [Simple Cache] 缓存命中！Query: {user_input[:50]}...")
            # 返回缓存的响应（格式与Agent返回一致）
            return {"messages": [{"content": cached_result}]}
        
        # 2. 缓存未命中，调用原函数
        logger.info(f"⏭️ [Simple Cache] 缓存未命中，调用核心逻辑. Query: {user_input[:50]}...")
        result = await func(*args, **kwargs)
        
        # 3. 将结果写入缓存
        try:
            if result and "messages" in result and len(result["messages"]) > 0:
                final_response = result["messages"][-1].content
                # 默认缓存1小时
                _GLOBAL_CACHE.set(user_input, final_response, ttl=3600)
                logger.info(f"💾 [Simple Cache] 结果已写入缓存")
        except Exception as e:
            logger.error(f"写入缓存失败: {e}", exc_info=True)
        
        return result
    
    return wrapper


def get_cache_stats() -> Dict[str, Any]:
    """获取缓存统计信息（用于监控和调试）"""
    return _GLOBAL_CACHE.get_stats()


def clear_cache():
    """清空缓存（用于管理）"""
    _GLOBAL_CACHE.clear()


def cleanup_expired_cache():
    """清理过期缓存（建议定期调用）"""
    _GLOBAL_CACHE.cleanup_expired()
