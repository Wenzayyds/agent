FROM python:3.10-slim
WORKDIR /app
COPY requirements.txt .
# 安装依赖，为了加速可以加上清华源
RUN pip install --no-cache-dir -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
COPY . .
EXPOSE 8000
CMD ["chainlit", "run", "app/ui/app_chainlit.py", "-h", "0.0.0.0", "-p", "8000"]