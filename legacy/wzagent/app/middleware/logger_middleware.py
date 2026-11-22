import time
import logging
import json
from functools import wraps
from typing import Any, Dict, List, Optional
from collections import deque
from datetime import datetime
import uuid

# 配置结构化日志格式
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)-8s | [%(name)s] | %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger("OmniAgent.Middleware")


class PerformanceMetrics:
    """
    性能指标收集器
    
    收集和统计请求的性能数据：
    - 请求延迟（P50/P90/P95/P99）
    - 成功率
    - 错误率
    - Token使用量
    """
    
    def __init__(self, max_samples: int = 1000):
        """
        Args:
            max_samples: 保留的最大样本数（用于计算百分位数）
        """
        self.max_samples = max_samples
        self.latencies: deque = deque(maxlen=max_samples)
        
        # 计数器
        self.total_requests = 0
        self.successful_requests = 0
        self.failed_requests = 0
        
        # Token统计
        self.total_input_tokens = 0
        self.total_output_tokens = 0
        
        # 错误统计
        self.errors_by_type: Dict[str, int] = {}
    
    def record_request(
        self,
        latency: float,
        success: bool,
        error_type: Optional[str] = None,
        input_tokens: int = 0,
        output_tokens: int = 0
    ):
        """记录单次请求的指标"""
        self.total_requests += 1
        self.latencies.append(latency)
        
        if success:
            self.successful_requests += 1
        else:
            self.failed_requests += 1
            if error_type:
                self.errors_by_type[error_type] = self.errors_by_type.get(error_type, 0) + 1
        
        self.total_input_tokens += input_tokens
        self.total_output_tokens += output_tokens
    
    def get_percentile(self, p: float) -> float:
        """
        计算延迟的百分位数
        
        Args:
            p: 百分位 (0-100)
        
        Returns:
            延迟值（秒）
        """
        if not self.latencies:
            return 0.0
        
        sorted_latencies = sorted(self.latencies)
        index = int(len(sorted_latencies) * p / 100)
        index = min(index, len(sorted_latencies) - 1)
        return sorted_latencies[index]
    
    def get_stats(self) -> Dict[str, Any]:
        """获取完整的统计信息"""
        success_rate = (
            (self.successful_requests / self.total_requests * 100)
            if self.total_requests > 0 else 0
        )
        
        avg_latency = (
            sum(self.latencies) / len(self.latencies)
            if self.latencies else 0
        )
        
        return {
            "total_requests": self.total_requests,
            "successful_requests": self.successful_requests,
            "failed_requests": self.failed_requests,
            "success_rate": f"{success_rate:.2f}%",
            "latency": {
                "avg": f"{avg_latency:.3f}s",
                "p50": f"{self.get_percentile(50):.3f}s",
                "p90": f"{self.get_percentile(90):.3f}s",
                "p95": f"{self.get_percentile(95):.3f}s",
                "p99": f"{self.get_percentile(99):.3f}s",
            },
            "tokens": {
                "total_input": self.total_input_tokens,
                "total_output": self.total_output_tokens,
                "total": self.total_input_tokens + self.total_output_tokens,
                "avg_per_request": (
                    (self.total_input_tokens + self.total_output_tokens) / self.total_requests
                    if self.total_requests > 0 else 0
                )
            },
            "errors_by_type": self.errors_by_type
        }
    
    def reset(self):
        """重置所有统计"""
        self.latencies.clear()
        self.total_requests = 0
        self.successful_requests = 0
        self.failed_requests = 0
        self.total_input_tokens = 0
        self.total_output_tokens = 0
        self.errors_by_type.clear()


# 全局性能指标收集器
_METRICS = PerformanceMetrics(max_samples=1000)


class StructuredLogger:
    """结构化日志记录器"""
    
    @staticmethod
    def log_request_start(trace_id: str, user_input: str, metadata: Optional[Dict] = None):
        """记录请求开始"""
        log_data = {
            "event": "request_start",
            "trace_id": trace_id,
            "timestamp": datetime.utcnow().isoformat(),
            "user_input_preview": user_input[:100] if user_input else "",
            "user_input_length": len(user_input) if user_input else 0,
            "metadata": metadata or {}
        }
        logger.info(f"[{trace_id}] ➡️ 请求开始 | {json.dumps(log_data, ensure_ascii=False)}")
    
    @staticmethod
    def log_request_end(
        trace_id: str,
        latency: float,
        success: bool,
        response_length: int = 0,
        error: Optional[str] = None
    ):
        """记录请求结束"""
        log_data = {
            "event": "request_end",
            "trace_id": trace_id,
            "timestamp": datetime.utcnow().isoformat(),
            "latency": f"{latency:.3f}s",
            "success": success,
            "response_length": response_length,
            "error": error
        }
        
        if success:
            logger.info(f"[{trace_id}] ⬅️ 请求成功 | {json.dumps(log_data, ensure_ascii=False)}")
        else:
            logger.error(f"[{trace_id}] ❌ 请求失败 | {json.dumps(log_data, ensure_ascii=False)}")
    
    @staticmethod
    def log_performance_summary():
        """记录性能摘要"""
        stats = _METRICS.get_stats()
        logger.info(f"📊 性能统计摘要 | {json.dumps(stats, ensure_ascii=False, indent=2)}")


def observability_middleware(func):
    """
    可观测性中间件：提供全方位的监控和日志记录
    
    功能：
    - 结构化日志：JSON格式，便于日志分析系统解析
    - 请求追踪：为每个请求生成唯一trace_id
    - 性能监控：记录延迟、吞吐量、百分位数
    - 错误治理：分类统计各类错误
    - Token统计：跟踪模型调用的Token消耗
    
    Args:
        func: 被装饰的异步函数
    
    Returns:
        装饰后的函数
    """
    @wraps(func)
    async def wrapper(*args, **kwargs):
        # 生成追踪ID
        trace_id = str(uuid.uuid4())[:8]
        
        # 提取请求信息
        user_input = kwargs.get("user_input", "")
        metadata = {
            "args_count": len(args),
            "kwargs_keys": list(kwargs.keys())
        }
        
        # 记录请求开始
        StructuredLogger.log_request_start(trace_id, user_input, metadata)
        
        start_time = time.time()
        success = False
        error_msg = None
        error_type = None
        response_length = 0
        
        try:
            # 执行核心业务逻辑
            result = await func(*args, **kwargs)
            success = True
            
            # 计算响应长度
            if result and "messages" in result and len(result["messages"]) > 0:
                response_content = result["messages"][-1].content
                response_length = len(response_content) if response_content else 0
            
            return result
            
        except Exception as e:
            # 捕获异常
            success = False
            error_type = type(e).__name__
            error_msg = str(e)
            
            # 记录错误详情
            logger.error(
                f"[{trace_id}] 异常详情: {error_type} - {error_msg}",
                exc_info=True
            )
            
            # 重新抛出异常
            raise
            
        finally:
            # 计算耗时
            elapsed = time.time() - start_time
            
            # 记录请求结束
            StructuredLogger.log_request_end(
                trace_id=trace_id,
                latency=elapsed,
                success=success,
                response_length=response_length,
                error=error_msg
            )
            
            # 记录性能指标
            # TODO: 从LLM响应中提取实际的token数量
            _METRICS.record_request(
                latency=elapsed,
                success=success,
                error_type=error_type,
                input_tokens=len(user_input.split()) if user_input else 0,  # 粗略估计
                output_tokens=response_length // 4 if response_length > 0 else 0  # 粗略估计
            )
            
            # 每100个请求输出一次性能摘要
            if _METRICS.total_requests % 100 == 0:
                StructuredLogger.log_performance_summary()
    
    return wrapper


def get_performance_stats() -> Dict[str, Any]:
    """获取性能统计信息（供外部调用）"""
    return _METRICS.get_stats()


def reset_performance_stats():
    """重置性能统计（用于测试或定期清理）"""
    _METRICS.reset()
    logger.info("性能统计已重置")


def log_performance_summary():
    """手动触发性能摘要输出"""
    StructuredLogger.log_performance_summary()


# 高级日志工具函数
def log_tool_call(trace_id: str, tool_name: str, tool_input: Any):
    """记录工具调用"""
    log_data = {
        "event": "tool_call",
        "trace_id": trace_id,
        "tool_name": tool_name,
        "tool_input": str(tool_input)[:200],  # 限制长度
        "timestamp": datetime.utcnow().isoformat()
    }
    logger.info(f"[{trace_id}] 🔧 工具调用 | {json.dumps(log_data, ensure_ascii=False)}")


def log_cache_event(trace_id: str, cache_type: str, hit: bool, details: Optional[Dict] = None):
    """记录缓存事件"""
    log_data = {
        "event": "cache_event",
        "trace_id": trace_id,
        "cache_type": cache_type,
        "cache_hit": hit,
        "details": details or {},
        "timestamp": datetime.utcnow().isoformat()
    }
    logger.info(f"[{trace_id}] 💾 缓存事件 | {json.dumps(log_data, ensure_ascii=False)}")


def log_llm_call(
    trace_id: str,
    model: str,
    prompt_length: int,
    response_length: int,
    latency: float,
    tokens: Optional[Dict] = None
):
    """记录大模型调用"""
    log_data = {
        "event": "llm_call",
        "trace_id": trace_id,
        "model": model,
        "prompt_length": prompt_length,
        "response_length": response_length,
        "latency": f"{latency:.3f}s",
        "tokens": tokens or {},
        "timestamp": datetime.utcnow().isoformat()
    }
    logger.info(f"[{trace_id}] 🤖 LLM调用 | {json.dumps(log_data, ensure_ascii=False)}")
