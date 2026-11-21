# First-Run Crucible (`examples/first-run-challenge/`)

Harnex provides an honest, zero-friction **Dual-Mode First-Run Experience** (`F0`):

## 1. Recorded Replay Mode (Default — No API Key Required)
When no LLM provider or API key is configured yet, Harnex plays `recorded_replay.json` (`isRecordedReplay: true`) with an explicit on-screen replay badge and disclaimer:
1. **`v0` Failure** on `dataset_a`: The factory minimal seed attempts to parse messy multi-encoding desktop billing CSVs (`GB18030`, `UTF-8 BOM`, accounting negative `(180.00)`), producing garbled vendor names and a broken total.
2. **Pause → Steer**: The user pauses mid-run and steers Harnex to decode `GB18030` properly and ignore `VOID` rows.
3. **Evolution Theater (Harness²)**: Dual-track Invariant + Domain editors propose `scripts/safe_gbk_parse.ts` and updated `tool_descriptions/fs_and_shell.md`.
4. **CoW Shadow Sandbox**: Probed safely on a Copy-on-Write shadow workspace (`7 -> 2` steps, `3 -> 0` errors).
5. **Blind Judge A/B**: Shuffled forward/reverse comparison confirms the evolved harness wins without position bias.
6. **Human Trust & `v1` Replay**: The user explicitly trusts the new high-privilege script and sees `dataset_a/verify.ts` pass at 100% accuracy.

## 2. Live Evolution Mode (Provider & Key Configured)
Once you configure a provider (manually or via CC Switch / Magpie import in `F4`), you can run `dataset_a` or `dataset_b` live:
- Harnex displays estimated runtime (typically 1–4 minutes depending on model speed) and estimated token cost before starting.
- Tip: Bind a fast/inexpensive model to **Solver** and a stronger reasoning model to **Improver / Judge** to observe the `v0 -> v1` Harness² capability lift first-hand.
- Grade live outputs deterministically with:
  ```bash
  bun run examples/first-run-challenge/dataset_a/verify.ts
  bun run examples/first-run-challenge/dataset_b/verify.ts
  ```
