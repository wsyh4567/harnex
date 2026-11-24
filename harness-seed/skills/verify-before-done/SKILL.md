---
name: verify-before-done
description: Prefer minimal targeted edits and verify results with real checks before concluding.
---

# Verify Before Done

When modifying code, configs, or documents:
1. Prefer `edit_file` with small unique `oldText` anchors (batched in one call per file) instead of rewriting entire files via `write_file`.
2. After edits, run the narrowest relevant check (typecheck, test, or file inspection) via `shell` or `read_file`.
3. Report exact modified file paths and concrete verification outputs; never claim success without observing it.
