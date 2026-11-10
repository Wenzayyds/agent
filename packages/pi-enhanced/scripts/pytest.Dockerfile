FROM python@sha256:65bd3d9f1d7fa268dd1909973ba7eb4bdf41f6dcf2cfbe76ba9528b170f3fd79
RUN python -m pip install --no-cache-dir --no-deps pytest==8.3.5 iniconfig==2.0.0 packaging==24.2 pluggy==1.5.0
ENV PYTHONDONTWRITEBYTECODE=1 PYTEST_DISABLE_PLUGIN_AUTOLOAD=1
USER 1000:1000
WORKDIR /workspace
