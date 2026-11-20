import fsDefault from "node:fs";
import { existsSync as rawExistsSync, mkdirSync as rawMkdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { configLayers, readConfig, writeConfig, type ConfigLayers } from "./config.ts";
import { dataHealth, dataTargets, matchDataPath, parentDir, preferUnified, writePath } from "./data-dir.ts";
import { expandPath, settingsDir } from "./paths.ts";
import type { Intercept, InterceptOptions } from "./types.ts";

// Our own admin code (migrate/eject/diagnostics) must see the real filesystem,
// not the redirected view, or a migration ends up moving its own files twice.
let bypassDepth = 0;

export function withBypass<T>(fn: () => T): T {
  bypassDepth += 1;
  try {
    return fn();
  } finally {
    bypassDepth -= 1;
  }
}

// Path whitelist for exact absolute config paths -> the adapter that declared it.
// Layers are resolved per call in resolveTarget, from the current cwd and trust.
function buildTargets(opts: InterceptOptions): Map<string, InterceptOptions["adapters"][number]> {
  const targets = new Map<string, InterceptOptions["adapters"][number]>();
  for (const adapter of opts.adapters) {
    if (!adapter.config) continue;
    targets.set(expandPath(adapter.config.path, opts.agentDir), adapter);
  }
  return targets;
}

// A whitelisted path counts as existing when any of its layers does.
function anyLayerExists(layers: ConfigLayers): boolean {
  return rawExistsSync(layers.global) || (layers.project !== undefined && rawExistsSync(layers.project));
}

export function installIntercept(opts: InterceptOptions): Intercept {
  const targets = buildTargets(opts);
  // One warning per adapter, not one per intercepted read.
  const warnedProjectLayer = new Set<string>();
  const dataDirs = dataTargets(opts.agentDir, opts.adapters);
  if (targets.size > 0 && !rawExistsSync(settingsDir(opts.agentDir))) {
    opts.onWarn?.(`unified settings dir missing: ${settingsDir(opts.agentDir)}`);
  }

  // Config wins over data: a declared config path that happens to sit inside a
  // declared data dir is served as config, because that is the narrower contract
  // the plugin declared. Each patch therefore checks config targets first and
  // only consults data dirs when the path is not a config path.

  // One place deciding where a whitelisted path really lives. Undefined means
  // "not whitelisted": every patched function then calls the saved original.
  // Trust is read per call so a session_start update takes effect without re-patching.
  const resolveTarget = (p: unknown): ConfigLayers | undefined => {
    if (bypassDepth > 0) return undefined;
    if (typeof p !== "string") return undefined;
    const adapter = targets.get(p);
    if (!adapter) return undefined;
    // Recompute from the live opts so session_start moving the cwd is honored.
    const layers = configLayers(opts, adapter);
    if (layers && layers.project === undefined && adapter.config?.projectOverride) {
      // Our trust/cwd refresh runs from our own session_start handler, which is not
      // guaranteed to run before another extension reads config. Say so instead of
      // silently ignoring an override the user wrote.
      const candidate = expandPath(join(opts.cwd, ".pi/unify", adapter.config.projectOverride), opts.agentDir);
      if (rawExistsSync(candidate) && !warnedProjectLayer.has(adapter.name)) {
        warnedProjectLayer.add(adapter.name);
        opts.onWarn?.(
          `project override for ${adapter.name} present at ${candidate} but not applied (project not reported trusted yet)`,
        );
      }
    }
    return layers;
  };

  // Render the merged view in the shape the caller asked for: a string for a
  // requested encoding, a Buffer otherwise (same as the original readFileSync).
  // No parseable layer means the file is not JSON: serve that raw file so
  // plugins with plain-text/legacy config keep working.
  const readWhitelisted = (read: Function, layers: ConfigLayers, p: string, args: unknown[]) => {
    const view = readConfig(layers);
    if (!view) {
      const raw = rawExistsSync(layers.global)
        ? layers.global
        : layers.project !== undefined && rawExistsSync(layers.project)
          ? layers.project
          : p;
      return read(raw, ...args);
    }
    const json = JSON.stringify(view.merged);
    const requested = typeof args[0] === "string" ? args[0] : (args[0] as { encoding?: BufferEncoding } | undefined)?.encoding;
    return requested ? json : Buffer.from(json);
  };

  const dataPath = (p: unknown) =>
    bypassDepth > 0 || resolveTarget(p) ? undefined : matchDataPath(dataDirs, p);
  // Writes and directory creation always go to the unified side, creating the
  // parent dir; deletes follow the read side so an unmigrated old dir can still
  // be removed where it currently lives.
  const ensureParent = (dir: string) => rawMkdirSync(dir, { recursive: true });

  const original = {
    readFileSync: fsDefault.readFileSync,
    existsSync: fsDefault.existsSync,
    statSync: fsDefault.statSync,
    writeFileSync: fsDefault.writeFileSync,
    mkdirSync: fsDefault.mkdirSync,
    readdirSync: fsDefault.readdirSync,
    rmSync: fsDefault.rmSync,
    promisesReadFile: fsDefault.promises.readFile,
    promisesStat: fsDefault.promises.stat,
    promisesWriteFile: fsDefault.promises.writeFile,
    promisesMkdir: fsDefault.promises.mkdir,
    promisesReaddir: fsDefault.promises.readdir,
    promisesRm: fsDefault.promises.rm,
  } as const;

  const patched = {
    readFileSync: ((p: unknown, ...rest: unknown[]) => {
      const layers = resolveTarget(p);
      if (layers && anyLayerExists(layers)) return readWhitelisted(original.readFileSync, layers, p as string, rest);
      const dp = dataPath(p);
      if (dp) return (original.readFileSync as Function)(preferUnified(dp), ...rest);
      return (original.readFileSync as Function)(p, ...rest);
    }) as typeof fsDefault.readFileSync,

    existsSync: ((p: unknown) => {
      const layers = resolveTarget(p);
      if (layers && anyLayerExists(layers)) return true;
      const dp = dataPath(p);
      if (dp) return (original.existsSync as Function)(preferUnified(dp));
      return (original.existsSync as Function)(p);
    }) as typeof fsDefault.existsSync,

    mkdirSync: ((p: unknown, ...rest: unknown[]) => {
      const dp = dataPath(p);
      if (dp) return (original.mkdirSync as Function)(writePath(dp), ...rest);
      return (original.mkdirSync as Function)(p, ...rest);
    }) as typeof fsDefault.mkdirSync,

    readdirSync: ((p: unknown, ...rest: unknown[]) => {
      const dp = dataPath(p);
      if (dp) return (original.readdirSync as Function)(preferUnified(dp), ...rest);
      return (original.readdirSync as Function)(p, ...rest);
    }) as typeof fsDefault.readdirSync,

    rmSync: ((p: unknown, ...rest: unknown[]) => {
      const dp = dataPath(p);
      if (dp) return (original.rmSync as Function)(preferUnified(dp), ...rest);
      return (original.rmSync as Function)(p, ...rest);
    }) as typeof fsDefault.rmSync,

    statSync: ((p: unknown, ...rest: unknown[]) => {
      const layers = resolveTarget(p);
      if (layers && anyLayerExists(layers)) {
        // shortcut: stat reports the global file, so size != merged size when the
        // project layer adds keys; upgrade if a caller ever trusts stat().size.
        const existing = rawExistsSync(layers.global) ? layers.global : (layers.project as string);
        return (original.statSync as Function)(existing, ...rest);
      }
      const dp = dataPath(p);
      if (dp) return (original.statSync as Function)(preferUnified(dp), ...rest);
      return (original.statSync as Function)(p, ...rest);
    }) as typeof fsDefault.statSync,

    // Writes always land in the global layer, after src/config.ts validates them.
    // shortcut: write options (mode/flag) are dropped; plugin config writes are
    // whole-file replaces. Upgrade if a plugin appends to its config file.
    writeFileSync: ((p: unknown, ...rest: unknown[]) => {
      const layers = resolveTarget(p);
      if (layers) {
        writeConfig(layers, rest[0] as string | Uint8Array, opts.onWarn);
        return;
      }
      const dp = dataPath(p);
      if (dp) {
        ensureParent(parentDir(dp));
        return (original.writeFileSync as Function)(writePath(dp), ...rest);
      }
      return (original.writeFileSync as Function)(p, ...rest);
    }) as typeof fsDefault.writeFileSync,

    promisesReadFile: (async (p: unknown, ...rest: unknown[]) => {
      const layers = resolveTarget(p);
      if (layers && anyLayerExists(layers)) return readWhitelisted(original.promisesReadFile, layers, p as string, rest);
      const dp = dataPath(p);
      if (dp) return (original.promisesReadFile as Function)(preferUnified(dp), ...rest);
      return (original.promisesReadFile as Function)(p, ...rest);
    }) as typeof fsDefault.promises.readFile,

    promisesReaddir: (async (p: unknown, ...rest: unknown[]) => {
      const dp = dataPath(p);
      if (dp) return (original.promisesReaddir as Function)(preferUnified(dp), ...rest);
      return (original.promisesReaddir as Function)(p, ...rest);
    }) as typeof fsDefault.promises.readdir,

    promisesMkdir: (async (p: unknown, ...rest: unknown[]) => {
      const dp = dataPath(p);
      if (dp) return (original.promisesMkdir as Function)(writePath(dp), ...rest);
      return (original.promisesMkdir as Function)(p, ...rest);
    }) as typeof fsDefault.promises.mkdir,

    promisesRm: (async (p: unknown, ...rest: unknown[]) => {
      const dp = dataPath(p);
      if (dp) return (original.promisesRm as Function)(preferUnified(dp), ...rest);
      return (original.promisesRm as Function)(p, ...rest);
    }) as typeof fsDefault.promises.rm,

    promisesStat: (async (p: unknown, ...rest: unknown[]) => {
      const layers = resolveTarget(p);
      if (layers && anyLayerExists(layers)) {
        const existing = rawExistsSync(layers.global) ? layers.global : (layers.project as string);
        return (original.promisesStat as Function)(existing, ...rest);
      }
      const dp = dataPath(p);
      if (dp) return (original.promisesStat as Function)(preferUnified(dp), ...rest);
      return (original.promisesStat as Function)(p, ...rest);
    }) as typeof fsDefault.promises.stat,

    promisesWriteFile: (async (p: unknown, ...rest: unknown[]) => {
      const layers = resolveTarget(p);
      if (layers) {
        writeConfig(layers, rest[0] as string | Uint8Array, opts.onWarn);
        return;
      }
      const dp = dataPath(p);
      if (dp) {
        ensureParent(parentDir(dp));
        return (original.promisesWriteFile as Function)(writePath(dp), ...rest);
      }
      return (original.promisesWriteFile as Function)(p, ...rest);
    }) as typeof fsDefault.promises.writeFile,
  };

  // Assign through the module objects so callers using `fs.x` / `fs.promises.x`
  // observe the patch.
  fsDefault.readFileSync = patched.readFileSync;
  fsDefault.existsSync = patched.existsSync;
  fsDefault.statSync = patched.statSync;
  fsDefault.writeFileSync = patched.writeFileSync;
  fsDefault.mkdirSync = patched.mkdirSync;
  fsDefault.readdirSync = patched.readdirSync;
  fsDefault.rmSync = patched.rmSync;
  fsDefault.promises.readFile = patched.promisesReadFile;
  fsDefault.promises.stat = patched.promisesStat;
  fsDefault.promises.writeFile = patched.promisesWriteFile;
  fsDefault.promises.readdir = patched.promisesReaddir;
  fsDefault.promises.mkdir = patched.promisesMkdir;
  fsDefault.promises.rm = patched.promisesRm;
  // Named ESM imports (`import { readFileSync } from "node:fs"`) snapshot the
  // builtin's exports at first instantiation, which happens long before an
  // extension loads. Re-syncing is the only way those bindings see our patch —
  // without it every plugin written with named imports bypasses interception.
  syncBuiltinESMExports();

  let installed = true;

  return {
    uninstall() {
      if (!installed) return;
      installed = false;
      // Restore each slot only while it is still ours: a patch installed after
      // us must survive, or we would silently disable another interceptor.
      if (fsDefault.readFileSync === patched.readFileSync) fsDefault.readFileSync = original.readFileSync;
      if (fsDefault.existsSync === patched.existsSync) fsDefault.existsSync = original.existsSync;
      if (fsDefault.statSync === patched.statSync) fsDefault.statSync = original.statSync;
      if (fsDefault.writeFileSync === patched.writeFileSync) fsDefault.writeFileSync = original.writeFileSync;
      if (fsDefault.mkdirSync === patched.mkdirSync) fsDefault.mkdirSync = original.mkdirSync;
      if (fsDefault.readdirSync === patched.readdirSync) fsDefault.readdirSync = original.readdirSync;
      if (fsDefault.rmSync === patched.rmSync) fsDefault.rmSync = original.rmSync;
      if (fsDefault.promises.readFile === patched.promisesReadFile) fsDefault.promises.readFile = original.promisesReadFile;
      if (fsDefault.promises.stat === patched.promisesStat) fsDefault.promises.stat = original.promisesStat;
      if (fsDefault.promises.writeFile === patched.promisesWriteFile) fsDefault.promises.writeFile = original.promisesWriteFile;
      if (fsDefault.promises.readdir === patched.promisesReaddir) fsDefault.promises.readdir = original.promisesReaddir;
      if (fsDefault.promises.mkdir === patched.promisesMkdir) fsDefault.promises.mkdir = original.promisesMkdir;
      if (fsDefault.promises.rm === patched.promisesRm) fsDefault.promises.rm = original.promisesRm;
      syncBuiltinESMExports();
    },
    health() {
      if (!installed) return { patched: [], problems: ["intercept uninstalled"] };
      const problems: string[] = [];
      const patchedNames: string[] = [];
      for (const [name, current, ours] of [
        ["readFileSync", fsDefault.readFileSync, patched.readFileSync],
        ["existsSync", fsDefault.existsSync, patched.existsSync],
        ["statSync", fsDefault.statSync, patched.statSync],
        ["writeFileSync", fsDefault.writeFileSync, patched.writeFileSync],
        ["mkdirSync", fsDefault.mkdirSync, patched.mkdirSync],
        ["readdirSync", fsDefault.readdirSync, patched.readdirSync],
        ["rmSync", fsDefault.rmSync, patched.rmSync],
        ["promises.readFile", fsDefault.promises.readFile, patched.promisesReadFile],
        ["promises.stat", fsDefault.promises.stat, patched.promisesStat],
        ["promises.writeFile", fsDefault.promises.writeFile, patched.promisesWriteFile],
        ["promises.readdir", fsDefault.promises.readdir, patched.promisesReaddir],
        ["promises.mkdir", fsDefault.promises.mkdir, patched.promisesMkdir],
        ["promises.rm", fsDefault.promises.rm, patched.promisesRm],
      ] as const) {
        if (current === ours) patchedNames.push(name);
        else problems.push(`${name} is no longer our patch (another interceptor ran after us)`);
      }
      if (targets.size > 0 && !rawExistsSync(settingsDir(opts.agentDir))) {
        problems.push(`unified settings dir missing: ${settingsDir(opts.agentDir)}`);
      }
      problems.push(...dataHealth(dataDirs));
      return { patched: patchedNames, problems };
    },
  };
}

