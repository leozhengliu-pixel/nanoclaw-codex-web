# NanoClaw MultiRuntime Specification

A personal Codex assistant host with NanoClaw-style multi-channel routing, persistent per-group context, scheduled tasks, and container-isolated execution.

## Architecture

```text
Channels --> SQLite --> Message loop --> GroupQueue --> Container (Codex) --> Response
```

### Host

- Channels self-register at startup
- Messages are stored before execution
- Registered groups are the unit of routing and isolation
- Main group acts as the control plane
- Scheduler and message handling share the same group execution semantics

### Execution

- Each group runs in its own isolated container context
- Group folders remain the writable per-group workspace
- Global memory remains shared read-only outside the main group
- Codex runs inside the container via `codex exec`

### Auth

- OpenAI Codex login is owned by the project
- OAuth callback login is the default path
- Device login is available when explicitly requested
- Credentials are stored in project-owned `provider_auth`
- The host does not import `~/.codex/auth.json`

## Channel System

The core keeps the NanoClaw channel contract:

- `connect()`
- `sendMessage()`
- `isConnected()`
- `ownsJid()`
- `disconnect()`
- optional `setTyping()`
- optional `syncGroups()`

This repo currently includes `local-dev` and `main-local` as development channels only.

## Folder Structure

- `groups/global/CLAUDE.md` shared memory
- `groups/main/CLAUDE.md` main control memory
- `groups/<group>/CLAUDE.md` per-group memory
- `data/` runtime state
- `store/messages.db` host database

## Commands

Main channel commands include:

- `/register-group`
- `/list-groups`
- `/remote-status`
- `/auth-status`
- `/auth-login openai-codex`
- `/auth-logout openai-codex`
- `/set-model`
- `/get-model`

## Intentional Divergences

Compared with upstream NanoClaw core, the intentional divergences are:

- Codex runtime in place of Claude Agent SDK
- OpenAI Codex auth in place of OneCLI/Claude auth
- project-owned provider auth storage
