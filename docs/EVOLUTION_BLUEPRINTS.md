# Harnex V2+ Evolution Blueprints

> **Philosophy**: Keep V1.0 lean, verifiable, and rock-solid (`born small, grows itself`), and co-create V2+ capabilities openly with the community—and with Harnex's own self-evolved PRs.

---

## 1. Six Capability Blueprints (V1.0 Seed → V2+ Roadmap)

| # | Capability | V1.0 Minimal Core (Shipped Today) | V2+ Open Blueprint |
| :--- | :--- | :--- | :--- |
| **1** | **Memory** | Loads `memory/LongTermMEMORY.md` at startup; reflector appends concise verified lessons (`Cue / Lesson / Evidence`). | **Hierarchical & Vector Memory**: Short/mid/long-term tiers, automatic salience decay & compaction, and local semantic/graph retrieval (SQLite vector index). |
| **2** | **Hooks Ecosystem** | Rust L0 executes SHA-256-trusted `hooks/*.ts` inside the OS sandbox (`PreToolUse`, `PostToolUse`, `SessionStart`) + 1 seed example (`example_trim_output.ts`). | **Community Hook Registry**: Curated guard, PII-redaction, auto-format, and linter hooks with reproducible test fixtures and one-click SHA-256 verification. |
| **3** | **Skills Engine** | Scans `skills/*/SKILL.md` frontmatter + trigger lines; drafts and adopts skills from successful traces. | **Skill Deduplication & Lifecycle**: Cross-domain pattern mining, semantic conflict detection, automatic skill merging, and stale skill pruning. |
| **4** | **Multi-Subagent Orchestration** | `spawn_worker(profilePath, task)` isolation primitive + 1 read-only template (`sub_agents/example_helper.md`). | **Parallel Worker Swarms**: Specialized role packs (researcher, parser, verifier), DAG task scheduling, and live execution tree visualization in Command Deck. |
| **5** | **MCP Ops Console** | Built-in `@modelcontextprotocol/sdk` host reading `mcp/servers.json` + Playwright plug-and-play template (user-installed MCPs trusted by default). | **MCP Ops & Office Templates**: Graphical MCP catalog, heartbeat/reconnect diagnostics, OAuth helper flows, and ready-to-use local office/spreadsheet/browser bundles. |
| **6** | **Sandbox & Dynamic Views** | Rust L0 OS physical sandbox + on-demand CoW Shadow workspace + reserved `views/` slot & `sandbox_policies/`. | **Monotonic Policy Packs & `views/` Cards**: Domain-specific monotonic hardening packs, fine-grained Dry-Run Mock rule library, and sandboxed L2 interactive view cards. |

---

## 2. Command Deck UI Roadmap (F5–F7)

V1.0 ships **F0–F4** (Dual-Mode First-Run Crucible, Multi-Thread Runner with Pause/Steer & Side Chat, L0 Security & Trust Cards, Evolution Triage with Inline Diff Comments, Genome Deck & Provider/CC-Switch/Magpie Center).

Community feedback unlocks **F5–F7**:
- **F5 — Multi-Pane Workspace & Live Local Preview**: Free-drag split panes with an embedded preview pane for generated HTML/CSV/Markdown artifacts.
- **F6 — Graphical Ops Console & Automations**: Visual manager for MCP servers, Skills, Hooks, Sub-Agents, and scheduled recurring desktop automations.
- **F7 — Global Hotkey Overlay (`Alt+Space`), Remote Web Console & `views/` Host**: Instant desktop command palette, optional authenticated LAN Web console, and sandboxed L2 `views/` dynamic card rendering.

---

## 3. How to Vote & Submit Harnex Self-Evolved PRs

1. **Vote on Priorities**: Join GitHub Discussions under the **Blueprints** category to upvote which Blueprint (1–6) or UI milestone (F5–F7) ships next.
2. **Export Sanitized Genomes**: Use **Genome Deck → Export** (built-in regex + entropy secret scanner strips `memory/` and credentials) to share evolved `skills/`, `scripts/`, or `hooks/`.
3. **Submit Self-Evolved PRs**:
   - Include the `BlindJudgeResult` and `benchmarks/internal-eval/` score delta (`v0 -> v1`).
   - Never modify immutable L0 paths (`packages/protocol/`, `packages/interfaces/`, `src-tauri/`).
   - Provide deterministic unit/verification tests for any new hook, script, or skill template.
