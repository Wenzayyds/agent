import os
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.getenv("OPENAI_API_KEY")
API_BASE = os.getenv("OPENAI_API_BASE", "https://api.openai.com/v1")
MODEL_NAME = os.getenv("MODEL_NAME", "gpt-3.5-turbo")
# 语义缓存的相似度阈值 (0~1，越接近0越相似，这里使用L2距离的近似概念)
CACHE_THRESHOLD = 0.15