from langchain_community.tools import DuckDuckGoSearchRun
from langchain_core.tools import tool

# 实例化基础搜索工具
ddg_search = DuckDuckGoSearchRun()

@tool
def web_search_tool(query: str) -> str:
    """
    当用户询问最新新闻、实时天气、当前股票价格或任何需要联网获取的最新信息时，调用此工具。
    参数 query 必须是简洁的搜索关键词。
    """
    try:
        print(f"\n[Tool Execution] 正在联网搜索: {query}")
        result = ddg_search.invoke(query)
        return f"搜索结果:\n{result}"
    except Exception as e:
        return f"搜索失败: {str(e)}"