import time
import logging
from functools import wraps
import uuid

# 配置工程化日志格式
logging.basicConfig(
    level=logging.INFO, 
    format='%(asctime)s | %(levelname)-8s | [%(name)s] | %(message)s'
)
logger = logging.getLogger("OmniAgent.Middleware")

def observability_middleware(func):
    """可观测性中间件：监控请求生命周期、耗时分析与异常治理"""
    @wraps(func)
    async def wrapper(*args, **kwargs):
        trace_id = str(uuid.uuid4())[:8]
        logger.info(f"[Trace: {trace_id}] ➡️ 接收到用户请求...")
        
        start_time = time.time()
        try:
            result = await func(*args, **kwargs)
            elapsed = time.time() - start_time
            logger.info(f"[Trace: {trace_id}] ⬅️ 请求处理成功. 总耗时: {elapsed:.2f}s")
            return result
        except Exception as e:
            elapsed = time.time() - start_time
            logger.error(f"[Trace: {trace_id}] ❌ 请求异常中断! 耗时: {elapsed:.2f}s. 报错: {str(e)}")
            raise e
    return wrapper