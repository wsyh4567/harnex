# Tool Guidance: Filesystem, Search, Edits & Shell

Read-only inspection tools (`read_file`, `list_files`, `find_files`, `grep_files`) operate strictly inside the bound workspace and skip protected paths. All side-effect tools (`edit_file`, `write_file`, `delete_file`, `shell`, `run_script`) are routed through JSON-RPC to the **Rust L0 executor** inside an OS-level sandbox (`workspace-write` by default, network disabled unless explicitly approved).

- **Reading & searching**: Use `find_files` and `grep_files` to locate targets before opening files. For large files, pass 1-indexed `offset` and `limit` to `read_file`.
- **Targeted edits (`edit_file`)**: Prefer `edit_file` with exact, unique `oldText` / `newText` replacements (batch multiple disjoint edits in one call) over rewriting entire files with `write_file`. Writes to `.git/`, `~/.harnex/harness/`, `~/.ssh/`, or system directories are physically blocked by L0.
- **Shell commands**: Prefer short, deterministic commands. Avoid interactive prompts, background daemons, or commands that assume global runtimes outside the sandbox.
- **Bun scripts (`scripts/*.ts`)**: Custom TypeScript/JavaScript utilities are executed by Rust L0 via the embedded Bun runtime (`BUN_BE_BUN=1`) inside the OS sandbox. New or modified scripts require explicit user trust before automatic execution.
- **Large outputs**: Tool stdout/stderr exceeding the runtime threshold is truncated with a notice; redirect or summarize large intermediate files instead of printing whole files to stdout.
