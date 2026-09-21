FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv tesseract-ocr tesseract-ocr-eng && rm -rf /var/lib/apt/lists/*
COPY tools/ocr-sidecar/requirements.txt /tmp/ocr-requirements.txt
RUN python3 -m venv /opt/ocr && /opt/ocr/bin/pip install --no-cache-dir -r /tmp/ocr-requirements.txt
ENV PATH="/opt/ocr/bin:$PATH"

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/site/package.json apps/site/package.json
COPY apps/extension/package.json apps/extension/package.json
COPY apps/extraction-dashboard/package.json apps/extraction-dashboard/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY tools/eval/package.json tools/eval/package.json

RUN npm ci

COPY . .
ARG VITE_AUTH_REQUIRED=true
ENV VITE_AUTH_REQUIRED=$VITE_AUTH_REQUIRED
RUN npm run build:dashboard

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001

EXPOSE 3001

CMD ["npm", "run", "start"]
