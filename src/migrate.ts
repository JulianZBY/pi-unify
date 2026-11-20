import fs from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Adapter } from "./adapters.ts";
import { dataTargets } from "./data-dir.ts";
import { backupDir, expandPath, settingsDir } from "./paths.ts";
import { readState, writeState } from "./state.ts";
import type { MigrationRecord } from "./state.ts";

export const MIGRATE_USAGE = "usage: /unify:migrate <plugin-name>";

export interface MigrateOptions {
  agentDir: string;
  adapters: Adapter[];
  /** Clock seam so backup timestamps are reproducible in tests. */
  now?: () => Date;
}

export interface MigrateResult {
  ok: boolean;
  message: string;
  /** Absolute paths written into the backup dir, in backup order. */
  backedUp: string[];
  /** Absolute unified paths the old files were moved to. */
  moved: string[];
}

// One plugin per call: backup every old file, move it into the unified layout and
// record what happened, so eject can reverse exactly this migration.
export function migrate(name: string, opts: MigrateOptions): MigrateResult {
  const none = { backedUp: [] as string[], moved: [] as string[] };
  const fail = (message: string): MigrateResult => ({ ok: false, message, ...none });

  const plugin = name.trim();
  if (plugin === "") return fail(`pi-unify: ${MIGRATE_USAGE}`);
  const adapter = opts.adapters.find((a) => a.name === plugin);
  if (!adapter) return fail(`pi-unify: unknown adapter "${plugin}"; ${MIGRATE_USAGE}`);

  const ad = opts.agentDir;
  if (readState(ad).migrations[plugin]) {
    return { ok: true, message: `pi-unify: ${plugin} is already migrated, nothing to do`, ...none };
  }

  const configFrom = adapter.config ? resolve(expandPath(adapter.config.path, ad)) : undefined;
  const configTo = join(settingsDir(ad), `${plugin}.json`);
  const dirs = dataTargets(ad, opts.adapters)
    .filter((target) => target.plugin === plugin)
    .filter((target, i, all) => all.findIndex((t) => t.old === target.old) === i)
    .filter((target) => isDir(target.old));

  const hasConfig = configFrom !== undefined && isFile(configFrom);
  if (!hasConfig && dirs.length === 0) {
    return { ok: true, message: `pi-unify: no old files to migrate for ${plugin}`, ...none };
  }

  const now = (opts.now ?? (() => new Date()))();
  // ISO with ':' and '.' flattened so the stamp is a legal directory name anywhere.
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const root = freshDir(join(backupDir(ad), plugin, stamp));
  const backedUp: string[] = [];

  try {
    if (hasConfig) {
      const dest = join(root, "config", basename(configFrom));
      copyFile(configFrom, dest);
      backedUp.push(dest);
    }
    for (const target of dirs) {
      const dest = freshDir(join(root, "data", basename(target.old)));
      copyDir(target.old, dest);
      backedUp.push(dest);
    }
  } catch (err) {
    return fail(`pi-unify: backup of ${plugin} failed: ${(err as Error).message}`);
  }

  const moved: string[] = [];
  try {
    if (hasConfig) {
      mkdir(dirname(configTo));
      fs.renameSync(configFrom, configTo);
      moved.push(configTo);
    }
    for (const target of dirs) {
      mergeDir(target.old, target.unified);
      removeIfEmpty(target.old);
      if (!moved.includes(target.unified)) moved.push(target.unified);
    }
  } catch (err) {
    return fail(`pi-unify: migration of ${plugin} failed: ${(err as Error).message}; backup in ${root}`);
  }

  const record: MigrationRecord = { migratedAt: now.toISOString() };
  if (hasConfig) record.config = { from: configFrom, to: configTo };
  if (dirs.length > 0) record.data = dirs.map((target) => ({ from: target.old, to: target.unified }));
  writeState(ad, { migrations: { ...readState(ad).migrations, [plugin]: record } });

  return {
    ok: true,
    message: `pi-unify: migrated ${plugin}: ${backedUp.length} backup(s) in ${root}, ${moved.length} location(s) moved`,
    backedUp,
    moved,
  };
}

// Backup dirs must never collide, not even two migrations inside the same second.
function freshDir(candidate: string): string {
  let dir = candidate;
  for (let n = 2; fs.existsSync(dir); n++) dir = `${candidate}-${n}`;
  mkdir(dir);
  return dir;
}

function mkdir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(from: string, to: string): void {
  mkdir(dirname(to));
  fs.copyFileSync(from, to);
}

function copyDir(from: string, to: string): void {
  mkdir(to);
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else copyFile(src, dest);
  }
}

// Move the contents of `from` into `to`, merging directory trees that exist on
// both sides; `from` itself is left for removeIfEmpty.
function mergeDir(from: string, to: string): void {
  mkdir(to);
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dest = join(to, entry.name);
    if (entry.isDirectory() && isDir(dest)) {
      mergeDir(src, dest);
      removeIfEmpty(src);
      continue;
    }
    if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(src, dest);
  }
}

function removeIfEmpty(dir: string): void {
  if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

function isDir(p: string): boolean {
  return stat(p)?.isDirectory() ?? false;
}

function isFile(p: string): boolean {
  return stat(p)?.isFile() ?? false;
}

function stat(p: string): fs.Stats | undefined {
  try {
    return fs.statSync(p);
  } catch {
    return undefined;
  }
}
