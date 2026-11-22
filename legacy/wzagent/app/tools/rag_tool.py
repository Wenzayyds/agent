from langchain_core.tools import tool
from langchain_community.vectorstores import FAISS
from langchain_huggingface import HuggingFaceEmbeddings
from langchain_core.documents import Document
import os

# 初始化嵌入模型
_embeddings = HuggingFaceEmbeddings(model_name="all-MiniLM-L6-v2")

# 向量存储路径
VECTOR_STORE_PATH = "data/vector_store"

# 全局向量存储实例
_vector_store = None

def get_vector_store():
    """获取或初始化向量存储"""
    global _vector_store
    if _vector_store is None:
        # 尝试加载已存在的向量存储
        if os.path.exists(VECTOR_STORE_PATH) and os.listdir(VECTOR_STORE_PATH):
            try:
                _vector_store = FAISS.load_local(
                    VECTOR_STORE_PATH, 
                    _embeddings,
                    allow_dangerous_deserialization=True
                )
                print(f"[RAG] 已加载现有向量存储: {VECTOR_STORE_PATH}")
            except Exception as e:
                print(f"[RAG] 加载向量存储失败: {e}，将创建新的存储")
                _vector_store = None
        
        # 如果加载失败或不存在，创建空的向量存储
        if _vector_store is None:
            # 创建一个包含初始化文档的向量存储
            init_doc = Document(
                page_content="OmniAgent 是一个基于 LangGraph 的智能体系统，支持工具调用和 RAG 检索增强生成。",
                metadata={"source": "init", "title": "OmniAgent 介绍"}
            )
            _vector_store = FAISS.from_documents([init_doc], _embeddings)
            _vector_store.save_local(VECTOR_STORE_PATH)
            print(f"[RAG] 已创建新的向量存储: {VECTOR_STORE_PATH}")
    
    return _vector_store


def add_documents_to_store(documents: list[Document]):
    """
    向向量存储中添加文档
    
    Args:
        documents: Document 对象列表，每个包含 page_content 和 metadata
    """
    store = get_vector_store()
    store.add_documents(documents)
    store.save_local(VECTOR_STORE_PATH)
    print(f"[RAG] 已添加 {len(documents)} 个文档到向量存储")


def load_documents_from_directory(directory: str):
    """
    从目录加载文档文件（支持 .txt, .md 文件）
    
    Args:
        directory: 文档目录路径
    """
    if not os.path.exists(directory):
        print(f"[RAG] 目录不存在: {directory}")
        return
    
    documents = []
    for filename in os.listdir(directory):
        filepath = os.path.join(directory, filename)
        if os.path.isfile(filepath):
            try:
                with open(filepath, 'r', encoding='utf-8') as f:
                    content = f.read()
                    doc = Document(
                        page_content=content,
                        metadata={"source": filename, "title": os.path.splitext(filename)[0]}
                    )
                    documents.append(doc)
                    print(f"[RAG] 已加载文档: {filename}")
            except Exception as e:
                print(f"[RAG] 加载文档失败 {filename}: {e}")
    
    if documents:
        add_documents_to_store(documents)
        print(f"[RAG] 成功加载 {len(documents)} 个文档")
    else:
        print(f"[RAG] 目录中未找到可加载的文档")


@tool
def vector_search_tool(query: str) -> str:
    """
    当用户询问关于私有知识库、特定文档内容、或者Agent架构细节时，调用此工具。
    工具会从向量数据库中检索最相关的文档片段。
    
    Args:
        query: 用户的查询问题
        
    Returns:
        检索到的文档内容，格式化为字符串
    """
    print(f"\n[Tool Execution] 正在向量数据库中检索: {query}")
    
    try:
        store = get_vector_store()
        
        # 执行相似度搜索，返回最相关的3个文档
        docs = store.similarity_search(query, k=3)
        
        if not docs or (len(docs) == 1 and docs[0].metadata.get("source") == "init"):
            return "知识库中未找到相关内容。请确保已上传文档到 data/docs 目录。"
        
        # 格式化检索结果
        results = []
        for i, doc in enumerate(docs, 1):
            source = doc.metadata.get("source", "未知来源")
            title = doc.metadata.get("title", "")
            content = doc.page_content[:500]  # 限制每个片段长度
            if len(doc.page_content) > 500:
                content += "..."
            
            results.append(f"[{i}] 来源: {source} {f'({title})' if title else ''}\n{content}\n")
        
        return f"检索到的文档片段:\n\n" + "\n".join(results)
        
    except Exception as e:
        return f"向量检索失败: {str(e)}"


# 初始化时尝试加载 data/docs 目录中的文档
def initialize_knowledge_base():
    """初始化知识库，加载 data/docs 目录中的文档"""
    docs_dir = "data/docs"
    if os.path.exists(docs_dir):
        load_documents_from_directory(docs_dir)
    else:
        print(f"[RAG] 文档目录不存在: {docs_dir}，跳过自动加载")


# 模块加载时自动初始化
initialize_knowledge_base()
