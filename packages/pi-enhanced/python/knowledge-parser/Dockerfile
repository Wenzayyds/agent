FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN python -m pip install --no-cache-dir --disable-pip-version-check -r requirements.txt

COPY parse_document.py .
ENV PYTHONDONTWRITEBYTECODE=1 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
USER 65534:65534
ENTRYPOINT ["python", "/app/parse_document.py"]
