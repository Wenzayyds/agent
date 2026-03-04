import logging
import time
from functools import wraps
from langchain_community.vectorstores import FAISS
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_core.documents import Document
from app.core.config import CACHE_THRESHOLD

logger = logging.getLogger("OmniAgent.SemanticCache")

# 1. 初始化本地轻量级 Embedding 模型 (首次运行会自动下载)
embeddings = HuggingFaceEmbeddings(model_name="all-MiniLM-L6-v2")

# 2. 初始化一个空的 FAISS 向量库作为内存缓存池
# 存入的 Document: page_content 是用户的 Query，metadata 存大模型的回答
vector_cache = FAISS.from_texts(["初始化缓存空间"], embeddings, metadatas=[{"response": "init"}])

def semantic_cache_middleware(func):
    """基于向量检索的语义缓存中间件"""
    @wraps(func)
    async def wrapper(*args, **kwargs):
        user_input = kwargs.get("user_input", "")
        if not user_input:
            return await func(*args, **kwargs)

        # 1. 向量相似度检索 (寻找距离最近的 Top 1)
        search_start = time.time()
        # similarity_search_with_score 返回的结果，分数越低代表越相似 (L2距离)
        docs_and_scores = vector_cache.similarity_search_with_score(user_input, k=1)
        search_time = time.time() - search_start
        
        if docs_and_scores:
            best_doc, score = docs_and_scores[0]
            # 如果向量距离小于我们设定的阈值，视为语义相同，直接命中！
            if score < CACHE_THRESHOLD and best_doc.page_content != "初始化缓存空间":
                logger.info(f"🎯 [Cache Hit] 命中语义缓存! 耗时: {search_time:.3f}s, 相似度得分: {score:.3f}")
                logger.info(f"🎯 匹配到的历史 Query: {best_doc.page_content}")
                
                cached_response = best_doc.metadata.get("response")
                # 伪装成 LangGraph 的输出格式返回
                return {"messages": [{"content": f"⚡ (命中语义缓存)\n\n{cached_response}"}]}
        
        # 2. 缓存未命中，调用核心业务逻辑
        logger.info(f"⏭️ [Cache Miss] 缓存未命中(或无足够相似问题)，放行至核心 Agent...")
        result = await func(*args, **kwargs)
        
        # 3. 将大模型的最新回答异步写入向量缓存池
        try:
            final_response = result["messages"][-1].content
            # 将新的 Query 向量化，并把回答存入 metadata
            new_doc = Document(page_content=user_input, metadata={"response": final_response})
            vector_cache.add_documents([new_doc])
            logger.info(f"💾 [Cache Write] 新对话已向量化并写入缓存池.")
        except Exception as e:
            logger.error(f"写入缓存失败: {e}")
            
        return result
    return wrapper