from typing import Annotated
from typing_extensions import TypedDict
from langchain_core.messages import BaseMessage
from langgraph.graph import StateGraph, START, END
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode, tools_condition
from langchain_community.chat_models.tongyi import ChatTongyi

from app.core.config import API_KEY, MODEL_NAME
from app.tools.search_tool import web_search_tool
from app.tools.rag_tool import vector_search_tool

class State(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]

tools = [web_search_tool, vector_search_tool]
tool_node = ToolNode(tools)

llm = ChatTongyi(
    model=MODEL_NAME, dashscope_api_key=API_KEY, temperature=0.2
)
llm_with_tools = llm.bind_tools(tools)

async def agent_node(state: State):
    return {"messages": [await llm_with_tools.ainvoke(state["messages"])]}

workflow = StateGraph(State)
workflow.add_node("agent", agent_node)
workflow.add_node("tools", tool_node)
workflow.add_edge(START, "agent")
workflow.add_conditional_edges("agent", tools_condition)
workflow.add_edge("tools", "agent")

agent_app = workflow.compile()