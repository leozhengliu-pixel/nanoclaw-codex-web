# NanoClaw Codex

This repository is initialized from [`leozhengliu-pixel/nanoclaw-codex`](https://github.com/leozhengliu-pixel/nanoclaw-codex) and reserved for the future web channel distribution. At this stage it is still a straight copy of the core and does not yet include the web-specific channel implementation.

A NanoClaw-compatible core for building self-hosted AI agents with OpenAI Codex. It keeps the NanoClaw host operating model while replacing the Claude runtime boundary with Codex, giving developers and integrators a containerized agent runtime, SQLite-backed message routing, per-group queues, scheduled tasks, and project-owned Codex authentication. It is intended for channel forks, internal tooling, and custom deployments rather than as a complete end-user distribution.

---

## Why This Exists

This repository keeps the NanoClaw host semantics but swaps the runtime/auth boundary that would normally depend on Claude Agent SDK and OneCLI. The intentional divergence is limited to:

- `openai-codex` OAuth and device login
- project-owned `provider_auth` storage
- container-side `codex exec` execution
- OpenAI / OpenAI Codex model policy

The built-in channels are intentionally limited to `local-dev` and `main-local`. Real user-facing entrypoints such as Web, Slack, Telegram, or Feishu should ship as separate forks or repositories on top of this core.

Keywords: NanoClaw, Codex, OpenAI Codex, self-hosted AI agent, AI agent framework, containerized agent runtime, SQLite message router, scheduled automation, multi-channel chatbot core.

## Core Development / Integration Quick Start

```bash
npm install
npm run setup -- --step verify
npm run build:image
npm run dev -- serve
```

Then in another terminal:

```bash
npm run dev -- send --channel main-local --external-id main-local:control --message "/auth-login openai-codex"
npm run dev -- send --channel local-dev --external-id local-dev:default --message "@Andy hello"
```

This quick start validates the core locally. It is not the same thing as deploying a complete end-user product.

## Philosophy

**Small enough to understand.** One process, a small number of source files, SQLite, filesystem IPC.

**Secure by isolation.** Agents run in containers and only see what is explicitly mounted.

**Forks over core bloat.** Core stays channel-agnostic. Future Slack, Telegram, Web, or Feishu support should live in separate forks.

**Runtime is replaceable, host semantics are not.** This repository keeps the NanoClaw host model and changes only the runtime/auth pieces required for Codex.

## What It Supports

- Built-in development channels: `local-dev` and `main-local`
- Main-channel group administration
- Per-group queueing and message-driven execution
- Scheduled tasks
- Container execution with Codex
- Project-owned OpenAI Codex login flow

## Search-Friendly Overview

If you are looking for a self-hosted AI agent core, Codex-powered chatbot backend, OpenAI Codex orchestration layer, or a NanoClaw fork for Web/Slack/Telegram/Feishu integrations, this repository is the core layer those channel-specific distributions should build on.

## Image Release

The published GHCR image is the core agent runtime image:

- `ghcr.io/leozhengliu-pixel/nanoclaw-codex-agent`

It is meant to be launched by a host process that implements the NanoClaw core control plane. It is not a standalone end-user entrypoint and is not intended to be used as `docker run ...` for a complete product experience.

Previous image name:

- `ghcr.io/leozhengliu-pixel/nanoclaw-multiruntime-agent` (deprecated)

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
- `local-dev` and `main-local` are development conveniences, not the long-term channel story.
- This repository is a core release. Real production channels should live in separate channel forks or sibling repositories.
- This repository was renamed from `nanoclaw-multiruntime`. Update `git remote` and GHCR pull paths to `nanoclaw-codex`.
