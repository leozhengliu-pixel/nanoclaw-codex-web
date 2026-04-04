# NanoClaw MultiRuntime

An AI assistant host that follows the NanoClaw core operating model while replacing the Claude runtime boundary with Codex. The host keeps the same shape: channel registration, SQLite-backed message routing, per-group queueing, isolated group folders, scheduled tasks, and a main control channel.

---

## Why This Exists

This repository keeps the NanoClaw host semantics but swaps the runtime/auth boundary that would normally depend on Claude Agent SDK and OneCLI. The intentional divergence is limited to:

- `openai-codex` OAuth and device login
- project-owned `provider_auth` storage
- container-side `codex exec` execution
- OpenAI / OpenAI Codex model policy

## Quick Start

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
