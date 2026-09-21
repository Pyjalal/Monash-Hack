FROM node:20-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/extension/package.json apps/extension/package.json
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
