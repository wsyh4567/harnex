import type {
  GitCommitPatchResult,
  HarnessPatchOp,
} from "@harnex/protocol";
import { IMMUTABLE_L0_PATH_PATTERNS } from "@harnex/protocol";
import type { RustBridge } from "./rust_bridge.ts";

export type HarnessTree = Record<string, string>;

export interface HarnessStore {
  getHeadSha(): Promise<string>;
  readTreeAt(commitSha: string): Promise<HarnessTree>;
  validatePatch(operations: HarnessPatchOp[]): { ok: boolean; errors: string[] };
  commitPatch(
    baseCommitSha: string,
    operations: HarnessPatchOp[],
    message: string,
    domain?: string,
  ): Promise<GitCommitPatchResult>;
}

export class InMemoryHarnessStore implements HarnessStore {
  constructor(private readonly bridge: RustBridge) {}

  async getHeadSha(): Promise<string> {
    return this.bridge.gitHeadSha();
  }

  async readTreeAt(commitSha: string): Promise<HarnessTree> {
    return this.bridge.gitReadTree(commitSha);
  }

  validatePatch(operations: HarnessPatchOp[]): { ok: boolean; errors: string[] } {
    const errors: string[] = [];
    for (const op of operations) {
      const norm = op.path.replace(/\\/g, "/").trim();
      if (!norm || norm.startsWith("/") || norm.split("/").includes("..")) {
        errors.push(`Path escapes harness root: ${op.path}`);
        continue;
      }
      for (const pat of IMMUTABLE_L0_PATH_PATTERNS) {
        if (norm === pat || norm.startsWith(pat) || norm.includes(`/${pat}`)) {
          errors.push(`Path touches immutable L0 zone: ${op.path}`);
        }
      }
    }
    return { ok: errors.length === 0, errors };
  }

  async commitPatch(
    baseCommitSha: string,
    operations: HarnessPatchOp[],
    message: string,
    domain = "general",
  ): Promise<GitCommitPatchResult> {
    const check = this.validatePatch(operations);
    if (!check.ok) {
      return {
        ok: false,
        conflict: false,
        conflictingFiles: [],
        error: check.errors.join("; "),
      };
    }
    return this.bridge.gitCommitPatch({
      baseCommitSha,
      operations,
      message,
      domain,
      authorName: "Harnex",
    });
  }
}
