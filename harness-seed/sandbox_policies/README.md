# Sandbox Policies (`sandbox_policies/`)

## Monotonic Hardening Rule
Policies placed in `sandbox_policies/` can **only monotonically harden** the runtime sandbox (e.g., denying extra sensitive globs, shortening command timeouts, or forcing `read-only` mode for specific domains).

They **cannot** weaken, disable, or override the immutable **Rust L0 OS Sandbox** baseline:
- `workspace-write` boundary enforcement
- Physical write blocks on `.git/`, `~/.harnex/harness/`, `~/.ssh/`, `trust.json`, and system paths
- Default network isolation
- `BUN_BE_BUN=1` sandboxed script/hook execution
