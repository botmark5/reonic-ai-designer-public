# Engine container. Build from the REPO ROOT so data/ and the trained artifacts are included:
#   docker build -f engine/Dockerfile -t reonic-engine .
#   docker run -p 8000:8000 -e ANTHROPIC_API_KEY=... reonic-engine
# The image contains the Reonic data and models derived from it: push it ONLY to a private registry/host.
# Never bake the API key in: pass ANTHROPIC_API_KEY as an environment variable / host secret.
FROM python:3.11-slim

# LightGBM needs OpenMP
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY engine/requirements.txt engine/requirements.txt
RUN pip install --no-cache-dir -r engine/requirements.txt

COPY engine engine
COPY data data
# train at build time if no model was copied in (keeps container start fast)
RUN test -f engine/artifacts/design_model.joblib || python -m engine.train

ENV PORT=8000 ENGINE_CORS_ORIGINS=*
EXPOSE 8000
CMD ["sh", "-c", "uvicorn engine.api:app --host 0.0.0.0 --port ${PORT}"]
