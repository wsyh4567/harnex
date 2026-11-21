# Skills (`skills/*/SKILL.md`)

Harnex starts with zero pre-loaded skills (`born small, grows itself`) and discovers skills from `skills/<skill-name>/SKILL.md` at startup.

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
