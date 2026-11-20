import fsDefault from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { expandPath } from "./paths.ts";
import type { Adapter } from "./adapters.ts";

// Records every string path read from the process. The point is to catch the
// one silent failure mode of an fs interception layer: a plugin loaded before
// pi-unify already read its adopted config, so the intercept never saw it.
const READ_CAP = 2000;

const reads = new Set<string>();

let installed = false;
let saved: {
  readFileSync?: typeof fsDefault.readFileSync;
  promisesReadFile?: typeof fsDefault.promises.readFile;
} = {};
let patched: {
  readFileSync?: typeof fsDefault.readFileSync;
  promisesReadFile?: typeof fsDefault.promises.readFile;
} = {};

function record(p: unknown): void {
  // Never throw on odd inputs: only plain string paths are resolvable later.
  if (typeof p === "string" && reads.size < READ_CAP) reads.add(p);
}

export function installProbe(): void {
  if (installed) return;
  installed = true;
  saved = {
    readFileSync: fsDefault.readFileSync,
    promisesReadFile: fsDefault.promises.readFile,
  };
  const originalReadFileSync = saved.readFileSync;
  const originalPromisesReadFile = saved.promisesReadFile;

  patched.readFileSync = ((p: unknown, ...rest: unknown[]) => {
    record(p);
    return (originalReadFileSync as Function)(p, ...rest);
  }) as typeof fsDefault.readFileSync;

  patched.promisesReadFile = (async (p: unknown, ...rest: unknown[]) => {
    record(p);
    return (originalPromisesReadFile as Function)(p, ...rest);
  }) as typeof fsDefault.promises.readFile;

  fsDefault.readFileSync = patched.readFileSync;
  fsDefault.promises.readFile = patched.promisesReadFile;

  // Named ESM imports snapshot builtin exports before we load; resync so those
  // bindings reach the probe too (see the comment in src/fs-intercept.ts).
  syncBuiltinESMExports();
}

export function uninstallProbe(): void {
  if (!installed) return;
  installed = false;
  // Only while still ours: another interceptor may have patched on top, and its
  // patch must survive (index.ts uninstalls the probe right after installing the
  // intercept, whose chain still includes this wrapper, so it skips here).
  if (saved.readFileSync && fsDefault.readFileSync === patched.readFileSync) fsDefault.readFileSync = saved.readFileSync;
  if (saved.promisesReadFile && fsDefault.promises.readFile === patched.promisesReadFile) {
    fsDefault.promises.readFile = saved.promisesReadFile;
  }
  saved = {};
  patched = {};
  syncBuiltinESMExports();
}

export function clearProbe(): void {
  reads.clear();
}

// Adopted config paths that were already read before interception was in place.
export function earlyReads(adapters: Adapter[], ad: string): string[] {
  const watched = new Set<string>();
  for (const adapter of adapters) {
    if (adapter.config) watched.add(expandPath(adapter.config.path, ad));
  }
  return [...reads].filter((p) => watched.has(p)).sort();
}

export interface SelfCheckResult {
  hits: string[];
  ok: boolean;
}

// Module-level so the diagnostics view can read the same result the startup
// warning was based on, without re-reading anything.
let lastSelfCheck: SelfCheckResult = { hits: [], ok: true };

export function setSelfCheck(result: SelfCheckResult): void {
  lastSelfCheck = { hits: [...result.hits], ok: result.ok };
}

export function selfCheck(): SelfCheckResult {
  return { hits: [...lastSelfCheck.hits], ok: lastSelfCheck.ok };
}

// Installed at module evaluation: src/index.ts imports this file first, which is
// the earliest point an extension gets to run, before adapters or plugins load.
installProbe();
