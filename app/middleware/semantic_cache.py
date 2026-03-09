import logging
import time
import os
from functools import wraps
from typing import Optional, Dict, Any, List, Tuple
from pathlib import Path

from langchain_community.vectorstores import FAISS
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_core.documents import Document

from app.core.config import CACHE_THRESHOLD

logger = logging.getLogger("OmniAgent.SemanticCache")

# 缓存目录配置
CACHE_DIR = Path("./cache")
VECTOR_CACHE_PATH = CACHE_DIR / "semantic_cache"


class SemanticCache:
    """
    语义缓存管理器
    
    特性：
    - 基于向量相似度的语义匹配
    - 支持持久化到磁盘
    - 自动缓存预热
    - 定期清理机制
    - 缓存统计
    """
    
    def __init__(
        self, 
        model_name: str = "all-MiniLM-L6-v2",
        threshold: float = 0.15,
        cache_path: Optional[Path] = None,
        enable_persistence: bool = True
    ):
        """
        初始化语义缓存
        
        Args:
            model_name: Embedding模型名称
            threshold: 相似度阈值，L2距离越小越相似
            cache_path: 缓存持久化路径
            enable_persistence: 是否启用持久化
        """
        self.threshold = threshold
        self.cache_path = cache_path or VECTOR_CACHE_PATH
        self.enable_persistence = enable_persistence
        
        # 统计信息
        self.hits = 0
        self.misses = 0
        self.total_search_time = 0.0
        
        try:
            # 初始化embedding模型（首次运行会自动下载）
            logger.info(f"正在加载 Embedding 模型: {model_name}")
            self.embeddings = HuggingFaceEmbeddings(
                model_name=model_name,
                model_kwargs={'device': 'cpu'},  # 可改为'cuda'使用GPU
                encode_kwargs={'normalize_embeddings': True}  # 归一化向量
            )
            logger.info("✅ Embedding 模型加载成功")
            
            # 加载或创建向量缓存
            self.vector_store = self._load_or_create_cache()
            
        except Exception as e:
            logger.error(f"初始化语义缓存失败: {e}", exc_info=True)
            raise
    
    def _load_or_create_cache(self) -> FAISS:
        """加载已有缓存或创建新缓存"""
        # 检查是否存在持久化缓存
        if self.enable_persistence and self.cache_path.exists():
            try:
                logger.info(f"正在加载已有向量缓存: {self.cache_path}")
                vector_store = FAISS.load_local(
                    str(self.cache_path), 
                    self.embeddings,
                    allow_dangerous_deserialization=True  # FAISS需要此参数
                )
                # 获取缓存大小
                cache_size = len(vector_store.index_to_docstore_id)
                logger.info(f"✅ 向量缓存加载成功，包含 {cache_size} 条记录")
                return vector_store
                
            except Exception as e:
                logger.warning(f"加载缓存失败，将创建新缓存: {e}")
        
        # 创建新的空缓存
        logger.info("创建新的向量缓存")
        vector_store = FAISS.from_texts(
            ["__INIT__"],  # 初始化占位符
            self.embeddings,
            metadatas=[{"response": "__INIT__", "created_at": time.time()}]
        )
        return vector_store
    
    def search(self, query: str, k: int = 1) -> Optional[Tuple[str, float]]:
        """
        搜索语义相似的缓存
        
        Args:
            query: 用户查询
            k: 返回最相似的k个结果
        
        Returns:
            (cached_response, score) 如果命中；否则None
        """
        if not query:
            return None
        
        try:
            search_start = time.time()
            
            # 执行向量相似度搜索
            docs_and_scores = self.vector_store.similarity_search_with_score(query, k=k)
            
            search_time = time.time() - search_start
            self.total_search_time += search_time
            
            if not docs_and_scores:
                self.misses += 1
                return None
            
            best_doc, score = docs_and_scores[0]
            
            # 检查是否为初始化占位符
            if best_doc.page_content == "__INIT__":
                self.misses += 1
                return None
            
            # 检查相似度是否满足阈值
            if score < self.threshold:
                self.hits += 1
                cached_response = best_doc.metadata.get("response", "")
                
                logger.info(
                    f"🎯 [Semantic Cache HIT] "
                    f"相似度: {score:.4f}, "
                    f"搜索耗时: {search_time:.3f}s"
                )
                logger.debug(f"原始Query: {best_doc.page_content}")
                logger.debug(f"当前Query: {query}")
                
                return cached_response, score
            else:
                self.misses += 1
                logger.debug(f"相似度 {score:.4f} 超过阈值 {self.threshold}，未命中")
                return None
                
        except Exception as e:
            logger.error(f"语义缓存搜索失败: {e}", exc_info=True)
            self.misses += 1
            return None
    
    def add(self, query: str, response: str):
        """
        添加新的查询-响应对到缓存
        
        Args:
            query: 用户查询
            response: 助手响应
        """
        try:
            # 创建文档
            doc = Document(
                page_content=query,
                metadata={
                    "response": response,
                    "created_at": time.time()
                }
            )
            
            # 添加到向量库
            self.vector_store.add_documents([doc])
            
            # 持久化到磁盘
            if self.enable_persistence:
                self._save_cache()
            
            logger.info(f"💾 [Semantic Cache] 新记录已添加并持久化")
            
        except Exception as e:
            logger.error(f"添加缓存记录失败: {e}", exc_info=True)
    
    def _save_cache(self):
        """保存缓存到磁盘"""
        try:
            # 确保目录存在
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            
            # 保存向量库
            self.vector_store.save_local(str(self.cache_path))
            logger.debug(f"缓存已保存到: {self.cache_path}")
            
        except Exception as e:
            logger.error(f"保存缓存失败: {e}", exc_info=True)
    
    def get_stats(self) -> Dict[str, Any]:
        """获取缓存统计信息"""
        total_requests = self.hits + self.misses
        hit_rate = (self.hits / total_requests * 100) if total_requests > 0 else 0
        avg_search_time = (self.total_search_time / total_requests) if total_requests > 0 else 0
        
        cache_size = len(self.vector_store.index_to_docstore_id) - 1  # 减去占位符
        
        return {
            "cache_size": cache_size,
            "hits": self.hits,
            "misses": self.misses,
            "hit_rate": f"{hit_rate:.2f}%",
            "total_requests": total_requests,
            "avg_search_time": f"{avg_search_time:.3f}s",
            "threshold": self.threshold
        }
    
    def clear(self):
        """清空缓存"""
        try:
            # 重新创建空缓存
            self.vector_store = FAISS.from_texts(
                ["__INIT__"],
                self.embeddings,
                metadatas=[{"response": "__INIT__", "created_at": time.time()}]
            )
            
            if self.enable_persistence:
                self._save_cache()
            
            # 重置统计
            self.hits = 0
            self.misses = 0
            self.total_search_time = 0.0
            
            logger.info("✅ 语义缓存已清空")
            
        except Exception as e:
            logger.error(f"清空缓存失败: {e}", exc_info=True)
    
    def warmup(self, qa_pairs: List[Tuple[str, str]]):
        """
        预热缓存
        
        Args:
            qa_pairs: [(query, response), ...] 列表
        """
        logger.info(f"开始缓存预热，共 {len(qa_pairs)} 条记录")
        
        for query, response in qa_pairs:
            self.add(query, response)
        
        logger.info("✅ 缓存预热完成")


# 全局语义缓存实例
try:
    _SEMANTIC_CACHE = SemanticCache(
        threshold=CACHE_THRESHOLD,
        enable_persistence=True
    )
    
    # 预热常见问题
    _SEMANTIC_CACHE.warmup([
        ("你好", "你好！我是 OmniAgent，有什么可以帮您？"),
        ("您好", "您好！我是 OmniAgent，有什么可以帮您？"),
        ("hi", "Hi! 我是 OmniAgent，有什么可以帮您？"),
        ("你是谁", "我是 OmniAgent，一个基于多智能体架构的AI助手，可以帮您进行网络搜索、文档检索等任务。"),
        ("你能做什么", "我可以帮您进行网络搜索获取最新信息，也可以从知识库中检索相关内容，还可以回答各种问题。"),
    ])
    
except Exception as e:
    logger.error(f"初始化全局语义缓存失败: {e}", exc_info=True)
    _SEMANTIC_CACHE = None


def semantic_cache_middleware(func):
    """
    语义缓存中间件：基于向量相似度的智能缓存
    
    特性：
    - 语义理解：即使用户问法不同，只要语义相似就能命中缓存
    - 持久化：缓存会保存到磁盘，重启后依然有效
    - 自动学习：每次新对话都会被加入缓存，不断优化
    
    Args:
        func: 被装饰的异步函数
    
    Returns:
        装饰后的函数
    """
    @wraps(func)
    async def wrapper(*args, **kwargs):
        # 检查缓存是否可用
        if _SEMANTIC_CACHE is None:
            logger.warning("语义缓存不可用，直接调用核心逻辑")
            return await func(*args, **kwargs)
        
        # 提取用户输入
        user_input = kwargs.get("user_input", "")
        if not user_input:
            return await func(*args, **kwargs)
        
        # 1. 搜索语义缓存
        cache_result = _SEMANTIC_CACHE.search(user_input)
        
        if cache_result:
            cached_response, score = cache_result
            # 命中缓存，直接返回
            return {
                "messages": [{
                    "content": f"⚡ (命中语义缓存，相似度: {score:.4f})\n\n{cached_response}"
                }]
            }
        
        # 2. 缓存未命中，调用核心逻辑
        logger.info(f"⏭️ [Semantic Cache MISS] 未找到相似问题，调用核心 Agent")
        result = await func(*args, **kwargs)
        
        # 3. 将新对话加入缓存
        try:
            if result and "messages" in result and len(result["messages"]) > 0:
                final_response = result["messages"][-1].content
                _SEMANTIC_CACHE.add(user_input, final_response)
        except Exception as e:
            logger.error(f"写入语义缓存失败: {e}", exc_info=True)
        
        return result
    
    return wrapper


def get_semantic_cache_stats() -> Optional[Dict[str, Any]]:
    """获取语义缓存统计信息"""
    if _SEMANTIC_CACHE:
        return _SEMANTIC_CACHE.get_stats()
    return None


def clear_semantic_cache():
    """清空语义缓存"""
    if _SEMANTIC_CACHE:
        _SEMANTIC_CACHE.clear()
