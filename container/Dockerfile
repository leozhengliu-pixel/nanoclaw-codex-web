FROM node:22-slim AS builder

ARG CODEX_NPM_PACKAGE=@openai/codex
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN npm config set registry "${NPM_CONFIG_REGISTRY}" \
  && npm config set fetch-retries 5 \
  && npm config set fetch-retry-maxtimeout 120000 \
  && npm config set fetch-timeout 300000 \
  && npm config set fund false \
  && npm config set audit false

COPY package.json package-lock.json ./
COPY container/agent-runner/package.json ./container/agent-runner/package.json
RUN npm ci --include=dev --verbose \
  && npm install -g ${CODEX_NPM_PACKAGE} --verbose

COPY tsconfig.json tsconfig.runtime.json eslint.config.js .prettierrc.json .npmrc ./
COPY src ./src
COPY setup ./setup
COPY container/agent-runner ./container/agent-runner
RUN npm run build:runtime

FROM node:22-alpine AS runtime

ARG CODEX_NPM_PACKAGE=@openai/codex
ARG NPM_CONFIG_REGISTRY=https://registry.npmjs.org/

RUN apk add --no-cache ca-certificates

WORKDIR /app

RUN npm config set registry "${NPM_CONFIG_REGISTRY}" \
  && npm config set fetch-retries 5 \
  && npm config set fetch-retry-maxtimeout 120000 \
  && npm config set fetch-timeout 300000 \
  && npm config set fund false \
  && npm config set audit false

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --verbose \
  && npm install -g ${CODEX_NPM_PACKAGE} --verbose \
  && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY container/skills ./container/skills
COPY config-examples/mount-allowlist.json ./config-examples/mount-allowlist.json
COPY groups/global/CLAUDE.md ./groups/global/CLAUDE.md
COPY groups/main/CLAUDE.md ./groups/main/CLAUDE.md
COPY container/test-bin/fake-codex ./container/test-bin/fake-codex

RUN mkdir -p /workspace /sessions /ipc /memory/global /memory/group /app/test-bin \
  && chmod +x /app/container/test-bin/fake-codex

CMD ["sleep", "infinity"]
