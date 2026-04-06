# Deployment

This document describes how to run the `nanoclaw-codex-web` browser channel distribution. The runtime is still the same NanoClaw-compatible Codex core, but browser access now goes through a trusted-proxy web gateway instead of only `local-dev` / `main-local`.

- `launchd/com.nanoclaw-codex.plist` provides a macOS service template.
- `systemd/nanoclaw-codex.service` provides a Linux service template.
- `container/Dockerfile` builds the core agent runtime image and installs the official `@openai/codex` CLI inside that image.
- `container/build.sh` builds the runner image with either `docker` or `podman`.
- `container/skills/` provides baseline in-container operator skills that are mounted read-only at runtime.
- `setup.sh` and `setup/index.ts` provide bootstrap, status, and verify checks.
- `scripts/start-host.sh` starts the long-running host process with the production `serve` command.
- `ui/` builds the static browser chat UI that the web gateway serves.

Replace `{{PROJECT_ROOT}}` and `{{NODE_PATH}}` before installation.

## Core Agent Container Path

Set these environment variables before starting the host:

- `NANOCLAW_CONTAINER_EXECUTOR=engine`
- `NANOCLAW_CONTAINER_ENGINE_BINARY=docker` or `podman`
- `NANOCLAW_CONTAINER_IMAGE=nanoclaw-codex-agent:latest`
- `NANOCLAW_AGENT_RUNNER_MODE=codex`
- `NANOCLAW_DEFAULT_TIMEZONE=<iana timezone>`
- `NANOCLAW_CONTAINER_SKILLS_PATH=<host path to container skills>`

At runtime the host will:

1. `run` a detached agent container from `NANOCLAW_CONTAINER_IMAGE`
2. bind-mount the group workspace, session directory, IPC directory, memory files, and any allowlisted extra mounts
3. bind-mount `container/skills` into `/opt/nanoclaw/skills` inside the agent container
4. generate isolated Codex auth material from project-owned `provider_auth`
5. `exec` the agent-runner inside that container
6. stream events back through the IPC directory
7. `rm -f` the container when the task completes or is cancelled

The published GHCR artifact is this agent image. It is intended for a NanoClaw-compatible host or channel fork to launch, not as a standalone product container for end users.

Current image:

- `ghcr.io/leozhengliu-pixel/nanoclaw-codex-agent`

## Web Gateway Configuration

The web gateway is host-side and should usually bind to loopback only:

- `NANOCLAW_WEB_ENABLED=true`
- `NANOCLAW_WEB_BIND=127.0.0.1`
- `NANOCLAW_WEB_PORT=4318`
- `NANOCLAW_WEB_PUBLIC_BASE_URL=https://chat.example.com`
- `NANOCLAW_WEB_ALLOWED_ORIGINS=https://chat.example.com`
- `NANOCLAW_WEB_TRUSTED_PROXIES=127.0.0.1`
- `NANOCLAW_WEB_AUTH_MODE=trusted-proxy`
- `NANOCLAW_WEB_AUTH_TRUSTED_PROXY_USER_HEADER=x-forwarded-user`
- `NANOCLAW_WEB_AUTH_TRUSTED_PROXY_REQUIRED_HEADERS=x-forwarded-proto,x-forwarded-host`
- `NANOCLAW_WEB_AUTH_TRUSTED_PROXY_ALLOW_USERS=you@example.com`

The browser route is intentionally strict:

- non-trusted proxy IPs are rejected
- missing auth headers are rejected
- disallowed `Origin` values are rejected
- rate limits apply to connect, history, and send requests
- `dev-token` mode is for explicit loopback-only development, not production

## Reverse Proxy Shape

Recommended deployment:

1. Browser connects to `https://chat.example.com`
2. Reverse proxy authenticates the user with OAuth/OIDC
3. Proxy injects `x-forwarded-user` and required headers
4. Proxy forwards HTTP and WebSocket traffic to `127.0.0.1:4318`
5. `nanoclaw-codex-web` maps that identity to a stable `web:<user>` channel JID
6. The message then enters the normal orchestrator, queue, transcript, and Codex runtime path

## What Is Not Included

- No official Slack, Telegram, or Feishu channel
- No full browser control plane
- No anonymous public browser chat
- No hostile multi-tenant support

This repository is still scoped to a single trusted operator boundary. If you need mixed-trust or adversarial-user isolation, split trust boundaries with separate hosts and separate credentials.

## Rename Note

This repository was renamed from `nanoclaw-multiruntime` to `nanoclaw-codex`. GitHub redirects old repository URLs, but users should update their `git remote` settings and GHCR pull addresses to the new name.

## Verification

Run these commands after configuration changes:

```bash
bash setup.sh
npm run dev -- status
npm run dev -- verify
```

Use `npm run test:container` to run the real container e2e path with the bundled fake Codex binary.
