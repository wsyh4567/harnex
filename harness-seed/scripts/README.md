# Scripts (`scripts/*.ts`)

Workspace helper scripts evolved by Harness² or authored by the user live here.

- **Execution model**: Scripts are never executed directly by the TypeScript sidecar. They are dispatched via `RustBridge.execScript(...)` and launched by Rust L0 using the embedded Bun binary (`BUN_BE_BUN=1`) inside the OS sandbox.
- **High-privilege trust gate**: `scripts/` is a high-privilege harness prefix (`HIGH_PRIVILEGE_HARNESS_PREFIXES`). Even in `auto` RSI mode, new or modified scripts require Guardian pre-review and explicit human trust before adoption.
