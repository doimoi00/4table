FROM python:3.11-slim
WORKDIR /app
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# CACHE_BUST: 매 배포마다 이 이하 레이어를 강제 재빌드
ARG CACHE_BUST=3
COPY server/ .
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}"]
