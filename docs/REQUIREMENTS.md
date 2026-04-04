# NanoClaw MultiRuntime Requirements

This repository keeps the NanoClaw host model while replacing the Claude-specific runtime boundary with Codex.

## Why This Exists

The goal is to preserve the small, channel-driven NanoClaw core:

- one host process
- SQLite-backed message routing
- per-group queueing
- container isolation
- group-scoped memory and sessions

The fork-specific requirement is that authentication and agent execution must work for users who bring their own OpenAI Codex subscription.

## Philosophy

### Small Enough to Understand

The host should remain inspectable and modifiable by one engineer with help from an AI coding assistant.

### Security Through Isolation

Agents run inside containers. The host controls mounts, queueing, and IPC. The security boundary is the container, not a permission dialog inside the same process.

### Built for Forks

The core stays small. Real channels should live in separate forks or channel-specific repos, matching the NanoClaw model.

### Minimal Necessary Divergence

The only durable divergence from NanoClaw core should be:

- Codex runtime integration
- OpenAI Codex auth/login flow
- project-owned provider auth storage

Everything else should stay as close to NanoClaw core behavior as possible.
