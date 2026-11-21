import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { assertNoGraderVerdicts } from "../harness2/context.ts";
import { normalizePaths, normalizeRelativePath } from "../harness2/tree.ts";

export interface ShadowLimits { perFileBytes: number; totalBytes: number }
export const DEFAULT_SHADOW_LIMITS: Readonly<ShadowLimits> = { perFileBytes: 4 * 1024 * 1024, totalBytes: 16 * 1024 * 1024 };

export class ShadowCapacityError extends Error {}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}

async function readChecked(root: string, path: string, cap: number, signal?: AbortSignal): Promise<Buffer | undefined> {
  let current = root;
  const parts = path.split("/");
  for (const [i, part] of parts.entries()) {
    current = join(current, part);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (i < parts.length - 1) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe shadow source directory: ${path}`);
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe shadow source file: ${path}`);
    if (stat.size > cap) throw new ShadowCapacityError(`Shadow byte cap exceeded at ${path}`);
    const resolved = await realpath(current);
    if (!isWithin(root, resolved)) throw new Error(`Shadow source escapes workspace: ${path}`);
    const file = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || await realpath(current) !== resolved) {
        throw new Error(`Shadow source changed while opening: ${path}`);
      }
      if (opened.size > cap) throw new ShadowCapacityError(`Shadow byte cap exceeded at ${path}`);
      const chunks: Buffer[] = [];
      let read = 0;
      while (true) {
        signal?.throwIfAborted();
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, cap - read + 1));
        const { bytesRead } = await file.read(chunk);
        if (!bytesRead) return Buffer.concat(chunks, read);
        read += bytesRead;
        if (read > cap) throw new ShadowCapacityError(`Shadow byte cap exceeded at ${path}`);
        chunks.push(chunk.subarray(0, bytesRead));
      }
    } finally {
      await file.close();
    }
  }
}

export async function withShadowWorkspace<T>(options: {
  workspacePath: string;
  touchedFiles: readonly string[];
  snapshot?: Record<string, string>;
  limits?: ShadowLimits;
  signal?: AbortSignal;
}, run: (shadowPath: string) => Promise<T>): Promise<T> {
  const { signal, limits = DEFAULT_SHADOW_LIMITS } = options;
  if (![limits.perFileBytes, limits.totalBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("Invalid shadow byte caps");
  signal?.throwIfAborted();
  const sourcePaths = options.snapshot ? Object.keys(options.snapshot) : [...new Set(options.touchedFiles.map(normalizeRelativePath))];
  const paths = normalizePaths(sourcePaths);
  const root = await realpath(options.workspacePath);
  const parent = await realpath(tmpdir());
  if (root === parent || isWithin(root, parent)) throw new Error("The temporary directory must be outside the host workspace");
  const temp = await mkdtemp(join(parent, "harnex-shadow-"));
  if (!isWithin(parent, temp) || dirname(temp) !== parent || isWithin(root, temp)) throw new Error("Invalid shadow workspace location");
  try {
    let copied = 0;
    for (const [i, path] of paths.entries()) {
      signal?.throwIfAborted();
      const cap = Math.min(limits.perFileBytes, limits.totalBytes - copied);
      const text = options.snapshot?.[sourcePaths[i]!];
      if (text !== undefined && Buffer.byteLength(text) > cap) throw new ShadowCapacityError(`Shadow byte cap exceeded at ${path}`);
      const content = options.snapshot ? Buffer.from(text!) : await readChecked(root, path, cap, signal);
      if (!content) continue;
      assertNoGraderVerdicts({ [path]: content.toString("utf8") });
      copied += content.length;
      const destination = join(temp, ...path.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      // Prepare disposable fixtures only. All solver side effects go through the sandboxed runner.
      await writeFile(destination, content, { flag: "wx", mode: 0o600 });
    }
    signal?.throwIfAborted();
    return await run(temp);
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 2 });
  }
}
