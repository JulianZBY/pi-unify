import fsDefault from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Adapter } from "./adapters.ts";
import { configLayers, readConfig } from "./config.ts";
import { backupDir } from "./paths.ts";
import { readState, writeState } from "./state.ts";

// Pinned at module load, before the intercept is installed (index.ts imports this
// module first): eject must see the real disk, never the redirect it is undoing.
const rawExistsSync: typeof fsDefault.existsSync = fsDefault.existsSync;
const rawStatSync: typeof fsDefault.statSync = fsDefault.statSync;
const rawReaddirSync: typeof fsDefault.readdirSync = fsDefault.readdirSync;
const rawMkdirSync: typeof fsDefault.mkdirSync = fsDefault.mkdirSync;
const rawCopyFileSync: typeof fsDefault.copyFileSync = fsDefault.copyFileSync;
const rawRenameSync: typeof fsDefault.renameSync = fsDefault.renameSync;
const rawRmSync: typeof fsDefault.rmSync = fsDefault.rmSync;
const rawWriteFileSync: typeof fsDefault.writeFileSync = fsDefault.writeFileSync;

export const EJECT_USAGE = "usage: /unify:eject <plugin-name>";

export interface EjectOptions {
  agentDir: string;
  adapters: Adapter[];
  /** Project override layer; merged only when the project is trusted. */
  cwd?: string;
  projectTrusted?: boolean;
  /** Clock seam so backup timestamps are reproducible in tests. */
  now?: () => Date;
}

export interface EjectResult {
  ok: boolean;
  message: string;
  /** Absolute old paths the files were written/moved back to. */
  restored: string[];
  /** Absolute paths under the backup dir holding the pre-eject unified copies. */
  backedUp: string[];
}

// Reverses /unify:migrate for one plugin: merged config back to the old path,
// data back to the old dirs, unified leftovers removed, state entry cleared.
// Backups of both sides are kept; nothing here is ever deleted from the backup dir.
export function eject(name: string, opts: EjectOptions): EjectResult {
  const none = { restored: [] as string[], backedUp: [] as string[] };
  const fail = (message: string): EjectResult => ({ ok: false, message, ...none });

  const plugin = name.trim();
  if (plugin === "") return fail(`pi-unify: ${EJECT_USAGE}`);
  const adapter = opts.adapters.find((a) => a.name === plugin);
  if (!adapter) return fail(`pi-unify: unknown adapter "${plugin}"; ${EJECT_USAGE}`);

  const ad = opts.agentDir;
  const state = readState(ad);
  const record = state.migrations[plugin];
  if (!record) {
    return { ok: true, message: `pi-unify: nothing to eject, ${plugin} is not migrated`, ...none };
  }

  // Merged view (global + trusted project layer, project wins): what the plugin
  // sees today, which is what it must still see after pi-unify is uninstalled.
  const configFrom = record.config?.from;
  const configTo = record.config?.to;
  const layers = configLayers(
    { agentDir: ad, cwd: opts.cwd ?? process.cwd(), projectTrusted: opts.projectTrusted ?? false },
    adapter,
  );
  const merged = configFrom !== undefined && layers ? readConfig(layers)?.merged : undefined;
  const hasConfig = configFrom !== undefined && configTo !== undefined && merged !== undefined;

  const dirs = (record.data ?? []).filter((pair) => isDir(pair.to));
  if (!hasConfig && dirs.length === 0) {
    clearEntry(ad, plugin);
    return { ok: true, message: `pi-unify: nothing to eject for ${plugin}, no unified files left`, ...none };
  }

  const now = (opts.now ?? (() => new Date()))();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const root = freshDir(join(backupDir(ad), plugin, `${stamp}-eject`));
  const backedUp: string[] = [];

  try {
    if (hasConfig) {
      // Back up the raw unified file, not the merged view: the merged view also
      // contains values that live in the user's project override file.
      const dest = join(root, "config", basename(configFrom));
      mkdir(dirname(dest));
      rawCopyFileSync(configTo, dest);
      backedUp.push(dest);
    }
    for (const pair of dirs) {
      const dest = freshDir(join(root, "data", basename(pair.from)));
      copyDir(pair.to, dest);
      backedUp.push(dest);
    }
  } catch (err) {
    return fail(`pi-unify: backup of ${plugin} before eject failed: ${(err as Error).message}`);
  }

  const restored: string[] = [];
  try {
    if (hasConfig && merged !== undefined) {
      mkdir(dirname(configFrom));
      rawWriteFileSync(configFrom, JSON.stringify(merged, null, 2) + "\n");
      // Drop the unified copy: with no unified layer the intercept falls through
      // to the old path again, so the redirect is gone before uninstall.
      if (isFile(configTo)) rawRmSync(configTo, { force: true });
      restored.push(configFrom);
    }
    for (const pair of dirs) {
      mergeDir(pair.to, pair.from);
      removeIfEmpty(pair.to);
      restored.push(pair.from);
    }
  } catch (err) {
    return fail(
      `pi-unify: eject of ${plugin} failed: ${(err as Error).message}; backup in ${root}, state kept`,
    );
  }

  clearEntry(ad, plugin);
  return {
    ok: true,
    message: `pi-unify: ejected ${plugin}: ${restored.length} location(s) restored, ${backedUp.length} pre-eject backup(s) in ${root}`,
    restored,
    backedUp,
  };
}

function clearEntry(agentDir: string, plugin: string): void {
  const state = readState(agentDir);
  const migrations = { ...state.migrations };
  delete migrations[plugin];
  writeState(agentDir, { migrations });
}

// Backup dirs must never collide, not even two runs inside the same second.
function freshDir(candidate: string): string {
  let dir = candidate;
  for (let n = 2; rawExistsSync(dir); n++) dir = `${candidate}-${n}`;
  mkdir(dir);
  return dir;
}

function mkdir(dir: string): void {
  rawMkdirSync(dir, { recursive: true });
}

function copyFile(from: string, to: string): void {
  mkdir(dirname(to));
  rawCopyFileSync(from, to);
}

function copyDir(from: string, to: string): void {
  mkdir(to);
  for (const entry of rawReaddirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else copyFile(src, dest);
  }
}

// Move the contents of `from` into `to`, merging trees present on both sides;
// `from` itself is left for removeIfEmpty.
function mergeDir(from: string, to: string): void {
  mkdir(to);
  for (const entry of rawReaddirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory() && isDir(dest)) {
      mergeDir(src, dest);
      removeIfEmpty(src);
      continue;
    }
    if (rawExistsSync(dest)) rawRmSync(dest, { recursive: true, force: true });
    rawRenameSync(src, dest);
  }
}

function removeIfEmpty(dir: string): void {
  if (rawExistsSync(dir) && rawReaddirSync(dir).length === 0) rawRmSync(dir, { recursive: true, force: true });
}

function isDir(p: string): boolean {
  return stat(p)?.isDirectory() ?? false;
}

function isFile(p: string): boolean {
  return stat(p)?.isFile() ?? false;
}

function stat(p: string): fsDefault.Stats | undefined {
  try {
    return rawStatSync(p);
  } catch {
    return undefined;
  }
}
