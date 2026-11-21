// Derived from google-research/harness2, Copyright 2026 Google LLC, Apache-2.0
export type ModeToken = "agg" | "seq";
type Kind = "rollout" | "session";
interface Entry { kind: Kind; label: string; usd: number; attempts: number }

export const expectedRollouts = (k: number) => 4 * k;
export const expectedSessions = (k: number) => 3 * k;

export class Ledger {
  private readonly entries: Entry[] = [];
  constructor(readonly mode: ModeToken, readonly taskId: string, readonly k: number) {
    if (!Number.isSafeInteger(k) || k < 1) throw new Error(`Invalid budget k: ${k}`);
  }

  rollout(label: string, usd = 0): void { this.entries.push({ kind: "rollout", label, usd, attempts: 1 }); }
  session(label: string, usd = 0, attempts = 1): void { this.entries.push({ kind: "session", label, usd, attempts }); }
  labels(kind: Kind): string[] { return this.entries.filter(entry => entry.kind === kind).map(entry => entry.label); }
  get R(): number { return this.labels("rollout").length; }
  get P(): number { return this.labels("session").length; }

  assertIdentity(): void {
    const rollouts = this.labels("rollout");
    const sessions = this.labels("session");
    const duplicates = [rollouts, sessions].flatMap(labels => labels.filter((label, i) => labels.indexOf(label) !== i));
    if (this.R !== expectedRollouts(this.k) || this.P !== expectedSessions(this.k) || duplicates.length) {
      throw new Error(`${this.mode}-${this.k} ${this.taskId}: R=${this.R} (expected ${expectedRollouts(this.k)}), P=${this.P} (expected ${expectedSessions(this.k)})${duplicates.length ? `; duplicate labels: ${duplicates.join(", ")}` : ""}`);
    }
  }

  toJSON() {
    const usd = (kind?: Kind) => Number(this.entries.filter(entry => !kind || kind === entry.kind).reduce((sum, entry) => sum + entry.usd, 0).toFixed(6));
    return { mode: this.mode, task_id: this.taskId, k: this.k, R: this.R, expected_R: expectedRollouts(this.k), P: this.P,
      expected_P: expectedSessions(this.k), session_attempts: this.entries.filter(e => e.kind === "session").reduce((sum, e) => sum + e.attempts, 0),
      usd: usd(), rollout_usd: usd("rollout"), session_usd: usd("session"), rollouts: this.labels("rollout"), sessions: this.labels("session") };
  }
}
