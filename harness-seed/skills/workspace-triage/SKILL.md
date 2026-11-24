---
name: workspace-triage
description: Map unfamiliar workspaces and locate relevant files before editing.
---

# Workspace Triage

When entering an unfamiliar folder or codebase:
1. Start with `list_files` or `find_files` (with a focused `pattern`) instead of reading random files.
2. Locate key entrypoints or specs with `grep_files` before opening large files.
3. For files longer than ~200 lines, use `read_file` with `offset` and `limit` so context stays focused.
4. Summarize discovered paths concisely before making edits.
