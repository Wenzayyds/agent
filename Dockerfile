FROM python:3.11-slim

ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MSWEA_SILENT_STARTUP=1 \
    MSWEA_GLOBAL_CONFIG_DIR=/tmp/mini-swe-agent

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 agent \
    && mkdir -p /runs /workspace \
    && chown agent:agent /runs /workspace

WORKDIR /app
COPY . .
RUN python -m pip install --no-cache-dir .

USER agent
ENTRYPOINT ["python", "-m", "minisweagent.run.wz"]
CMD ["--help"]
