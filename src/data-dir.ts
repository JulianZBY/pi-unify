import fsDefault from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Adapter } from "./adapters.ts";
import { dataRoot, expandPath } from "./paths.ts";

// Pinned at module load so the redirect's own existence probes never run
// through our patch (recursion guard, and it must see the real disk).
const rawExistsSync: typeof fsDefault.existsSync = fsDefault.existsSync;
const rawStatSync: typeof fsDefault.statSync = fsDefault.statSync;

export interface DataTarget {
  plugin: string;
  /** Old (pre-unification) directory, absolute. */
  old: string;
  /** New home: AD/extensions/data/<plugin>. */
  unified: string;
}

// One entry per declared data dir, in adapter order; the first match wins, so a
// descriptor that reuses another plugin's old dir keeps the first declaration.
export function dataTargets(agentDir: string, adapters: Adapter[]): DataTarget[] {
  const targets: DataTarget[] = [];
  for (const adapter of adapters) {
    for (const dir of adapter.data) {
      const old = resolve(expandPath(dir, agentDir));
      // One declared dir keeps the plain per-plugin folder; several would collide on
      // their file names (pi-fff's two LMDB envs both hold data.mdb), so each gets a
      // folder named after the old dir.
      const unified =
        adapter.data.length > 1
          ? join(dataRoot(agentDir), adapter.name, basename(old))
          : join(dataRoot(agentDir), adapter.name);
      targets.push({ plugin: adapter.name, old, unified });
    }
  }
  return targets;
}

export interface DataPath {
  target: DataTarget;
  /** The path the caller asked for (normalised). */
  old: string;
  /** The same file under the unified data dir, remainder preserved. */
  unified: string;
}

// undefined means "not inside any declared data dir": the caller must pass through.
export function matchDataPath(targets: DataTarget[], p: unknown): DataPath | undefined {
  if (typeof p !== "string") return undefined;
  const abs = resolve(p);
  for (const target of targets) {
    if (abs !== target.old && !abs.startsWith(target.old + sep)) continue;
    const remainder = abs.slice(target.old.length).replace(/^[/\\]+/, "");
    return { target, old: abs, unified: remainder === "" ? target.unified : join(target.unified, remainder) };
  }
  return undefined;
}

// Read side: the unified file wins when it exists, otherwise the old path still
// serves pre-migration data (mirrors how config layers fall back). When neither
// exists we return the unified path so ENOENT points at the new home.
export function preferUnified(path: DataPath): string {
  if (rawExistsSync(path.unified)) return path.unified;
  if (rawExistsSync(path.old)) return path.old;
  return path.unified;
}

// Resolve a path a caller is about to create or write: always the unified side.
export function writePath(path: DataPath): string {
  return path.unified;
}

// Parent dir for a write through the redirect, created before the write.
export function parentDir(path: DataPath): string {
  return dirname(path.unified);
}

export function dataHealth(targets: DataTarget[]): string[] {
  const problems: string[] = [];
  for (const target of targets) {
    if (!rawExistsSync(target.old)) continue;
    if (!rawStatSync(target.old).isDirectory()) {
      problems.push(`adapter ${target.plugin} data path is not a directory: ${target.old}`);
    }
  }
  return problems;
}
