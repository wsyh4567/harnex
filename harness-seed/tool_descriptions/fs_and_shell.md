# Tool Guidance: Filesystem, Shell & Scripts

All side-effect tools (`execWriteFile`, `execDeleteFile`, `execShell`, `execScript`) are routed through JSON-RPC to the **Rust L0 executor** and run inside an OS-level sandbox (`workspace-write` by default, network disabled unless explicitly approved).

- **File writes**: Always use relative paths inside the active workspace. Writes to `.git/`, `~/.harnex/harness/`, `~/.ssh/`, or system directories are physically blocked by L0.
- **Shell commands**: Prefer short, deterministic commands. Avoid interactive prompts, background daemons, or commands that assume global runtimes outside the sandbox.
- **Bun scripts (`scripts/*.ts`)**: Custom TypeScript/JavaScript utilities are executed by Rust L0 via the embedded Bun runtime (`BUN_BE_BUN=1`) inside the OS sandbox. New or modified scripts require explicit user trust before automatic execution.
- **Large outputs**: Tool stdout/stderr exceeding the runtime threshold is truncated with a notice; redirect or summarize large intermediate files instead of printing whole files to stdout.
