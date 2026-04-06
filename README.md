# NanoClaw Codex Web

This repository is the **web channel distribution** built on top of [`leozhengliu-pixel/nanoclaw-codex`](https://github.com/leozhengliu-pixel/nanoclaw-codex). It keeps the NanoClaw-compatible Codex core and adds a browser chat surface that runs through the same queue, transcript, session, scheduler, and tool IPC pipeline as every other channel.

The v1 scope is intentionally narrow:

- Web chat only
- Single operator
- Trusted proxy auth by default
- No anonymous public chat
- No full browser control plane

---

## Why This Exists

This repository keeps the NanoClaw host semantics from `nanoclaw-codex` and adds a browser-facing channel. The intentional divergence from the upstream core stays limited to:

- web gateway and `web:*` channel routing
- trusted-proxy browser authentication and allowlist checks
- static browser chat UI
- `openai-codex` OAuth and device login
- project-owned `provider_auth` storage
- container-side `codex exec` execution
- OpenAI / OpenAI Codex model policy

The built-in channels are now:

- `web`
- `local-dev`
- `main-local`

Keywords: NanoClaw, Codex, OpenAI Codex, self-hosted AI agent, web chat channel, trusted proxy auth, browser chat gateway, SQLite message router, scheduled automation, multi-channel chatbot core.

## Web Channel Quick Start

```bash
npm install
npm run build:web
npm run setup -- --step verify
npm run build:image
npm run dev -- serve
```

Configure trusted proxy web settings in `.env`:

```bash
cp .env.example .env
```

At minimum set:

```bash
NANOCLAW_WEB_PUBLIC_BASE_URL=https://chat.example.com
NANOCLAW_WEB_ALLOWED_ORIGINS=https://chat.example.com
NANOCLAW_WEB_TRUSTED_PROXIES=127.0.0.1
NANOCLAW_WEB_AUTH_MODE=trusted-proxy
NANOCLAW_WEB_AUTH_TRUSTED_PROXY_USER_HEADER=x-forwarded-user
```

For local validation, you can still use the dev channels in another terminal:

```bash
npm run dev -- send --channel main-local --external-id main-local:control --message "/auth-login openai-codex"
npm run dev -- send --channel local-dev --external-id local-dev:default --message "@Andy hello"
```

Then put a trusted reverse proxy in front of the host and browse to your configured public URL.

## Philosophy

**Small enough to understand.** One process, a small number of source files, SQLite, filesystem IPC.

**Secure by isolation.** Agents run in containers and only see what is explicitly mounted.

**Forks over core bloat.** Core stays channel-agnostic. Web lives here; future Slack, Telegram, or Feishu support should still live in separate forks.

**Runtime is replaceable, host semantics are not.** This repository keeps the NanoClaw host model and changes only the runtime/auth pieces required for Codex.

## What It Supports

- Trusted-proxy web gateway with browser chat
- Built-in development channels: `local-dev` and `main-local`
- Main-channel group administration
- Per-group queueing and message-driven execution
- Scheduled tasks
- Container execution with Codex
- Project-owned OpenAI Codex login flow
- Browser transcript history, typing, reply context, and session reuse

## Search-Friendly Overview

If you are looking for a self-hosted AI agent web channel, Codex-powered browser chat backend, trusted-proxy AI chat gateway, or a NanoClaw fork for web-based chat access, this repository is the dedicated web distribution.

## Runtime Image

The published GHCR image is the core agent runtime image:

- `ghcr.io/leozhengliu-pixel/nanoclaw-codex-agent`

It is still the agent runtime image, not a standalone browser product container. The web distribution adds a host-side web gateway and static UI on top of the same core/agent split.

Previous image name:

- `ghcr.io/leozhengliu-pixel/nanoclaw-multiruntime-agent` (deprecated)

## Security Model

- Single trusted operator boundary
- Reverse proxy is the only browser ingress
- Trusted proxy headers are required by default
- `allowedOrigins` is enforced
- No host-header origin fallback
- No anonymous browser mode in production
- Web chat does not expose main/control-plane privileges

## Usage

Talk to the dev channel with the trigger word:

```text
@Andy hello
```

From the main channel, manage groups and auth:

```text
/list-groups
/auth-status
/auth-login openai-codex
/set-model <groupId> openai/gpt-5-mini
```

CLI:

```bash
npm run dev -- serve
npm run dev -- auth login --provider openai-codex
npm run dev -- auth login --provider openai-codex --method device
npm run dev -- auth status
npm run dev -- auth logout --provider openai-codex
npm run dev -- dev:web
```

## Requirements

- Node.js 20+
- Docker Desktop, Docker, or Podman
- `codex` CLI available on the host

## Architecture

```text
Channels --> SQLite --> Message loop / GroupQueue --> Container (Codex) --> Response
```

Key files:
- `src/orchestrator.ts` - host orchestrator and state wiring
- `src/db.ts` - chats/messages/router state/sessions/tasks/provider auth
- `src/group-queue.ts` - per-group queue and concurrency control
- `src/task-scheduler.ts` - scheduler loop
- `src/ipc.ts` - IPC watcher and task processing
- `src/router.ts` - message formatting and outbound routing
- `src/container-runtime.ts` - container runtime helpers
- `src/runner/container-runner.ts` - container runner and IPC bridge
- `src/auth/openai-codex-auth-service.ts` - Codex OAuth and device login

## Development

```bash
npm run typecheck
npm test
```

Real container validation:

```bash
npm run build:image
npm run test:container
```

## Notes

- The host does not import or reuse `~/.codex/auth.json`.
- Codex login is owned by this project and stored in project data.
- `local-dev` and `main-local` remain development conveniences.
- The production browser path is intended to run behind a trusted reverse proxy with OAuth/OIDC.
- This repository was initialized from `nanoclaw-codex` and stays aligned with that core where possible.
