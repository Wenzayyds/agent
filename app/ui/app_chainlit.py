import chainlit as cl
from langchain_core.messages import HumanMessage
from app.agent.graph import agent_app
from app.middleware.logger_middleware import observability_middleware
from app.middleware.semantic_cache import semantic_cache_middleware

# 挂载中间件 (从下往上依次包裹)
@observability_middleware
@semantic_cache_middleware
async def invoke_agent_service(user_input: str, history: list):
    """业务核心入口"""
    history.append(HumanMessage(content=user_input))
    return await agent_app.ainvoke(
        {"messages": history},
        config={"configurable": {"thread_id": "chainlit_session"}}
    )

@cl.on_chat_start
async def on_chat_start():
    await cl.Message(content="你好！OmniAgent (工程化版) 已启动。\n已加载特性：✅路由分发 ✅向量语义缓存 ✅全局监控日志").send()
    cl.user_session.set("messages", [])

@cl.on_message
async def on_message(message: cl.Message):
    history = cl.user_session.get("messages", [])
    msg = cl.Message(content="处理中...")
    await msg.send()
    
    try:
        final_state = await invoke_agent_service(user_input=message.content, history=history)
        
        # 提取回复内容 (兼容缓存返回的字典格式和 LangGraph 返回的 Message 对象格式)
        final_node = final_state["messages"][-1]
        final_response = final_node["content"] if isinstance(final_node, dict) else final_node.content
             
        msg.content = final_response
        await msg.update()
        
        # 仅在非缓存命中时更新历史上下文
        if not isinstance(final_node, dict):
             cl.user_session.set("messages", final_state["messages"])
             
    except Exception as e:
        msg.content = f"抱歉，系统出现错误：{str(e)}"
        await msg.update()