# Skills (`skills/*/SKILL.md`)

Harnex ships with 3 lean, pure-Markdown universal starter skills (`workspace-triage`, `safe-data-ops`, `verify-before-done`) loaded strictly on demand so day-1 tasks work smoothly without bloating always-on prompts. Domain-specific skills grow organically through Harness² evolution and unused skills can be pruned by the Harness Gardener.

## Contract
1. Directory & file path: `skills/<name>/SKILL.md` (lowercase alphanumeric, `-`, `_`).
2. Required YAML frontmatter at the top of `SKILL.md`:
   ```yaml
   ---
   name: <skill-name>
   description: One-line summary of when and why to use this skill.
   ---
   ```
   - `name:` must match the directory name `<skill-name>`.
   - Missing `description:` or mismatched `name:` causes the skill to be ignored at load.
3. **Trigger line**: Always reference the skill by name in always-on text (`systemprompt.md` or `tool_descriptions/`), e.g.:
   `- When <condition>, read and follow skills/<name>/SKILL.md.`
