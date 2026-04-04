FROM node:22-slim

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

RUN npm ci --include=dev --verbose \
  && npm install -g ${CODEX_NPM_PACKAGE} --verbose

COPY tsconfig.json eslint.config.js .prettierrc.json .npmrc ./
COPY src ./src
COPY setup ./setup
COPY tests ./tests
COPY config-examples ./config-examples
COPY docs ./docs
COPY groups ./groups
COPY scripts ./scripts
COPY launchd ./launchd
COPY systemd ./systemd
COPY container ./container
COPY setup.sh README.md .env.example .gitignore ./

RUN mkdir -p /workspace /sessions /ipc /memory/global /memory/group /app/test-bin
RUN chmod +x /app/container/test-bin/fake-codex

CMD ["sleep", "infinity"]
