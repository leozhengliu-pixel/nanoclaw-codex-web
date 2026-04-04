# NanoClaw MultiRuntime Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|---|---|---|
| Main group | Trusted | Private control channel |
| Non-main groups | Untrusted | Other users may be malicious |
| Container agents | Sandboxed | Isolated execution environment |
| Incoming messages | User input | Potential prompt injection |

## Security Boundaries

### 1. Container Isolation

Agents execute in containers. Only mounted directories are visible. The host retains control over lifecycle, routing, and persistence.

### 2. Mount Security

Additional mounts are validated against an allowlist stored outside the project root. Blocked patterns prevent accidental exposure of secrets like `.ssh`, cloud credentials, or private keys.

### 3. Session Isolation

Each group has isolated state and workspace. Groups do not share session history or writable folders.

### 4. IPC Authorization

Task and message operations are authorized against group identity. Main-group style control actions are treated separately from normal group execution.

### 5. Credential Isolation

This fork differs from upstream NanoClaw here:

- credentials are stored in project-owned `provider_auth`
- the host prepares isolated container auth material for Codex
- the host does not reuse `~/.codex/auth.json`

The design goal is still the same: credentials should be managed by the host boundary, not by arbitrary agent code running in the group workspace.
