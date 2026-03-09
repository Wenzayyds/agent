import chainlit as cl
from langchain_core.messages import HumanMessage, AIMessage
from app.agent.graph import agent_app
from app.middleware.logger_middleware import observability_middleware
from app.middleware.semantic_cache import semantic_cache_middleware

# 挂载中间件 (从下往上依次包裹)
@observability_middleware
@semantic_cache_middleware
async def invoke_agent_service(user_input: str, history: list):
    """业务核心入口 - 流式版本"""
    history.append(HumanMessage(content=user_input))
    
    # 使用 astream 获取流式输出
    async for event in agent_app.astream(
        {"messages": history},
        config={"configurable": {"thread_id": "chainlit_session"}},
        stream_mode="values"
    ):
        # 获取最后一条消息
        if "messages" in event and len(event["messages"]) > 0:
            last_message = event["messages"][-1]
            # 只返回 AI 消息的内容
            if isinstance(last_message, AIMessage):
                yield last_message.content

@cl.on_chat_start
async def on_chat_start():
    await cl.Message(content="你好！OmniAgent (工程化版) 已启动。\n已加载特性：✅路由分发 ✅向量语义缓存 ✅全局监控日志").send()
    cl.user_session.set("messages", [])

@cl.on_message
async def on_message(message: cl.Message):
    history = cl.user_session.get("messages", [])
    msg = cl.Message(content="")
    await msg.send()
    
    full_response = ""
    
    try:
        # 流式接收回复
        async for token in invoke_agent_service(user_input=message.content, history=history):
            if token:
                full_response = token  # 累积完整响应
                # 计算新增的内容
                new_content = token[len(msg.content):]
                if new_content:
                    await msg.stream_token(new_content)
        
        # 更新历史上下文
        history.append(HumanMessage(content=message.content))
        history.append(AIMessage(content=full_response))
        cl.user_session.set("messages", history)
             
    except Exception as e:
        await msg.stream_token(f"\n抱歉，系统出现错误：{str(e)}")