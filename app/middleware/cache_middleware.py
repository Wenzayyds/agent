import logging
from functools import wraps

logger = logging.getLogger("OmniAgent-Middleware")

# 模拟本地内存缓存 (生产环境可替换为 Redis)
_LOCAL_CACHE = {
    "你好": "你好！我是 OmniAgent，有什么可以帮您？"
}

def semantic_cache_middleware(func):
    """
    缓存中间件：在调用大模型前拦截请求，命中缓存则直接返回，实现降本增效。
    """
    @wraps(func)
    async def wrapper(*args, **kwargs):
        # 从 kwargs 中提取用户输入的消息
        # 这里假设我们传递参数的方式是 invoke_agent(user_input="...", history=[...])
        user_input = kwargs.get("user_input", "")
        
        # 1. 缓存拦截阶段 (前置处理)
        if user_input in _LOCAL_CACHE:
            logger.info(f"🎯 [Cache Middleware] 命中缓存，直接返回！Query: {user_input}")
            # 伪造一个与 Agent 返回格式相同的字典
            return {"messages": [{"content": _LOCAL_CACHE[user_input]}]}
        
        # 2. 缓存未命中，放行请求给核心 Agent
        logger.info(f"⏭️ [Cache Middleware] 缓存未命中，放行至大模型. Query: {user_input}")
        result = await func(*args, **kwargs)
        
        # 3. 结果写回缓存阶段 (后置处理)
        try:
            final_response = result["messages"][-1].content
            _LOCAL_CACHE[user_input] = final_response
            logger.info(f"💾 [Cache Middleware] 结果已写入缓存.")
        except Exception:
            pass
            
        return result
    return wrapper