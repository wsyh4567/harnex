/**
 * Example PostToolUse Hook: Trim Overly Long Stdout
 *
 * SECURITY NOTICE:
 * - This hook is DISABLED BY DEFAULT until the user explicitly trusts its
 *   SHA-256 hash in `~/.harnex/trust.json` via the F2 Trust Store UI.
 * - Executed exclusively by Rust L0 via embedded Bun (`BUN_BE_BUN=1`) inside
 *   the OS sandbox. Any 1-byte change invalidates trust and triggers re-approval.
 */

export interface PostToolUsePayload {
  event: "PostToolUse";
  toolName: string;
  stdout?: string;
  stderr?: string;
  maxChars?: number;
}

export interface PostToolUseHookResult {
  action: "pass" | "modify";
  stdout?: string;
  truncated?: boolean;
  note?: string;
}

const DEFAULT_MAX_CHARS = 8_000;

export function trimToolOutput(payload: PostToolUsePayload): PostToolUseHookResult {
  const limit = payload.maxChars && payload.maxChars > 0 ? payload.maxChars : DEFAULT_MAX_CHARS;
  const stdout = payload.stdout ?? "";

  if (stdout.length <= limit) {
    return { action: "pass" };
  }

  const head = stdout.slice(0, Math.floor(limit * 0.75));
  const tail = stdout.slice(-Math.floor(limit * 0.2));
  const omitted = stdout.length - head.length - tail.length;

  return {
    action: "modify",
    truncated: true,
    stdout: `${head}\n\n... [example_trim_output hook omitted ${omitted} chars] ...\n\n${tail}`,
    note: `Trimmed stdout from ${stdout.length} to within ${limit} chars`,
  };
}

if (import.meta.main) {
  const raw = await Bun.stdin.text();
  if (!raw.trim()) {
    console.log(JSON.stringify({ action: "pass" }));
  } else {
    const payload = JSON.parse(raw) as PostToolUsePayload;
    console.log(JSON.stringify(trimToolOutput(payload)));
  }
}
