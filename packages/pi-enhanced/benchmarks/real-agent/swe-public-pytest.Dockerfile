FROM python@sha256:1d52838af602b4b5a831beb13a0e4d073280665ea7be7f69ce2382f29c5a613f AS historical
RUN python -m pip install --no-cache-dir --no-deps setuptools==65.7.0 pytest==7.4.4 iniconfig==2.0.0 packaging==24.2 pluggy==0.13.1 attrs==22.2.0 atomicwrites==1.4.1 py==1.11.0 more-itertools==8.14.0 toml==0.10.2 wcwidth==0.2.13 importlib-metadata==4.13.0 zipp==3.20.2 typing-extensions==4.12.2 exceptiongroup==1.2.2 tomli==2.2.1 urllib3==1.26.20 certifi==2024.8.30 idna==3.10 chardet==5.2.0 charset-normalizer==3.4.0 six==1.17.0 pytest-mock==3.14.0
ENV PYTHONDONTWRITEBYTECODE=1 PYTEST_DISABLE_PLUGIN_AUTOLOAD=1
USER 1000:1000
WORKDIR /workspace
FROM python@sha256:65bd3d9f1d7fa268dd1909973ba7eb4bdf41f6dcf2cfbe76ba9528b170f3fd79 AS scientific
RUN python -m pip install --no-cache-dir --no-deps pytest==8.3.5 iniconfig==2.0.0 packaging==24.2 pluggy==1.5.0 numpy==1.26.4 pyerfa==2.0.1.5 PyYAML==6.0.2
ENV PYTHONDONTWRITEBYTECODE=1 PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=1
USER 1000:1000
WORKDIR /workspace
