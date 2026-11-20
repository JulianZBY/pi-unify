import fsDefault from "node:fs";
import { existsSync as rawExistsSync, mkdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { dirname } from "node:path";
import { expandPath, settingsDir } from "./paths.ts";
import type { Intercept, InterceptOptions } from "./types.ts";

// Path whitelist for exact absolute config paths -> unified settings file.
// Data-dir mapping is added by a later ticket; keep that decision here only.
function buildTargets(opts: InterceptOptions): Map<string, string> {
  const targets = new Map<string, string>();
  for (const adapter of opts.adapters) {
    if (!adapter.config) continue;
    const oldPath = expandPath(adapter.config.path, opts.agentDir);
    targets.set(oldPath, `${settingsDir(opts.agentDir)}/${adapter.name}.json`);
  }
  return targets;
}

export function installIntercept(opts: InterceptOptions): Intercept {
  const targets = buildTargets(opts);
  if (targets.size > 0 && !rawExistsSync(settingsDir(opts.agentDir))) {
    opts.onWarn?.(`unified settings dir missing: ${settingsDir(opts.agentDir)}`);
  }

  // One place deciding where a whitelisted path really lives. Undefined means
  // "not whitelisted": every patched function then calls the saved original.
  const resolveTarget = (p: unknown): string | undefined =>
    typeof p === "string" ? targets.get(p) : undefined;

  const original = {
    readFileSync: fsDefault.readFileSync,
    existsSync: fsDefault.existsSync,
    statSync: fsDefault.statSync,
    writeFileSync: fsDefault.writeFileSync,
    promisesReadFile: fsDefault.promises.readFile,
    promisesStat: fsDefault.promises.stat,
    promisesWriteFile: fsDefault.promises.writeFile,
  } as const;

  const patched = {
    readFileSync: ((p: unknown, ...rest: unknown[]) => {
      const target = resolveTarget(p);
      if (target && rawExistsSync(target)) return (original.readFileSync as Function)(target, ...rest);
      return (original.readFileSync as Function)(p, ...rest);
    }) as typeof fsDefault.readFileSync,

    existsSync: ((p: unknown) => {
      const target = resolveTarget(p);
      if (target && rawExistsSync(target)) return true;
      return (original.existsSync as Function)(p);
    }) as typeof fsDefault.existsSync,

    statSync: ((p: unknown, ...rest: unknown[]) => {
      const target = resolveTarget(p);
      if (target && rawExistsSync(target)) return (original.statSync as Function)(target, ...rest);
      return (original.statSync as Function)(p, ...rest);
    }) as typeof fsDefault.statSync,

    // TODO(ticket 03): config writes will be merged/validated in src/config.ts.
    writeFileSync: ((p: unknown, ...rest: unknown[]) => {
      const target = resolveTarget(p);
      if (target) {
        mkdirSync(dirname(target), { recursive: true });
        return (original.writeFileSync as Function)(target, ...rest);
      }
      return (original.writeFileSync as Function)(p, ...rest);
    }) as typeof fsDefault.writeFileSync,

    promisesReadFile: (async (p: unknown, ...rest: unknown[]) => {
      const target = resolveTarget(p);
      if (target && rawExistsSync(target)) return (original.promisesReadFile as Function)(target, ...rest);
      return (original.promisesReadFile as Function)(p, ...rest);
    }) as typeof fsDefault.promises.readFile,

    promisesStat: (async (p: unknown, ...rest: unknown[]) => {
      const target = resolveTarget(p);
      if (target && rawExistsSync(target)) return (original.promisesStat as Function)(target, ...rest);
      return (original.promisesStat as Function)(p, ...rest);
    }) as typeof fsDefault.promises.stat,

    promisesWriteFile: (async (p: unknown, ...rest: unknown[]) => {
      const target = resolveTarget(p);
      if (target) {
        mkdirSync(dirname(target), { recursive: true });
        return (original.promisesWriteFile as Function)(target, ...rest);
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
  fsDefault.promises.readFile = patched.promisesReadFile;
  fsDefault.promises.stat = patched.promisesStat;
  fsDefault.promises.writeFile = patched.promisesWriteFile;
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
      fsDefault.readFileSync = original.readFileSync;
      fsDefault.existsSync = original.existsSync;
      fsDefault.statSync = original.statSync;
      fsDefault.writeFileSync = original.writeFileSync;
      fsDefault.promises.readFile = original.promisesReadFile;
      fsDefault.promises.stat = original.promisesStat;
      fsDefault.promises.writeFile = original.promisesWriteFile;
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
        ["promises.readFile", fsDefault.promises.readFile, patched.promisesReadFile],
        ["promises.stat", fsDefault.promises.stat, patched.promisesStat],
        ["promises.writeFile", fsDefault.promises.writeFile, patched.promisesWriteFile],
      ] as const) {
        if (current === ours) patchedNames.push(name);
        else problems.push(`${name} is no longer our patch (another interceptor ran after us)`);
      }
      if (targets.size > 0 && !rawExistsSync(settingsDir(opts.agentDir))) {
        problems.push(`unified settings dir missing: ${settingsDir(opts.agentDir)}`);
      }
      return { patched: patchedNames, problems };
    },
  };
}

