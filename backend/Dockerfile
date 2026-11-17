# ORION backend image. Build from the repository root:  docker build -f backend/Dockerfile -t orion-backend .
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /srv/orion/backend
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ .
COPY frontend/index.html /srv/orion/frontend/index.html
COPY hardware/communication/sim_device.py /srv/orion/sim/sim_device.py
RUN useradd --system --uid 10001 orion && chown -R orion /srv/orion
USER orion
ENV ORION_FRONTEND_DIR=/srv/orion/frontend
EXPOSE 8000
# Apply migrations, then serve. Behind Caddy/HTTPS in production (see deployment/docker-compose.yml).
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*'"]
