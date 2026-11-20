# 02: fs 拦截核心 + adapter 加载

**What to build:** 拦截层上线：monkey-patch 进程内 fs 读写，保存原始函数形成透传链，仅白名单路径被拦截。自动扫描 adapter 描述单目录生成白名单。验证方式：放一份手写测试 adapter，白名单内的配置读取被重定向到统一位置，白名单外的任意文件操作完全透传不受影响。

**Blocked by:** 01.

**Status:** resolved

- [x] patch 后白名单外路径读写行为与原 fs 一致（透传测试覆盖）
- [x] 多次 patch 叠加不破坏透传链（链式调用测试）
- [x] adapter 描述单目录被扫描，JSON 描述单正确生成拦截白名单
- [x] 白名单内配置读取返回统一位置文件的内容
- [x] 所有路径基于 agent 目录定位（含目录重定位环境变量）解析，不硬编码家目录

## Answer

Status: resolved. Implemented in `src/paths.ts`, `src/adapters.ts`, `src/fs-intercept.ts`;
`src/index.ts` gained a minimal factory wiring (load adapters from AD + shipped
`adapters/`, install intercept, `/unify` now reports one intercept summary line).

Public signatures (exactly as the design notes require, plus two additive details):

```ts
// paths.ts
agentDir(env?: NodeJS.ProcessEnv): string                       // env param is test-only
unifyAdapterDir(ad), settingsDir(ad), dataRoot(ad), backupDir(ad), statePath(ad): string
expandPath(p: string, ad: string): string                        // ~, $VAR/${VAR}, leading "<agent>"

// adapters.ts
interface Adapter { name: string; config?: { path: string; projectOverride?: string }; data: string[] }
loadAdapters(ad: string, extraDirs?: string[]): { adapters: Adapter[]; warnings: string[] }

// fs-intercept.ts
interface InterceptOptions { agentDir; adapters; cwd; projectTrusted; onWarn? }
interface Intercept { uninstall(): void; health(): { patched: string[]; problems: string[] } }
installIntercept(opts): Intercept
```

Behavior shipped: whitelist = exact absolute match of expanded adapter `config.path`.
Patched: `fs.readFileSync`, `existsSync`, `statSync`, `writeFileSync`,
`fs.promises.readFile/stat/writeFile`; saved originals give the passthrough chain, so a
second install wraps the first and both uninstalls restore in LIFO order. Whitelisted reads
return `AD/extensions/settings/<plugin>.json` when it exists, otherwise fall through to the
old path (unmigrated plugins keep working). Everything non-whitelisted is a straight
delegation (verified for strings, Buffers, `{encoding}` options, ENOENT codes/messages).
`health()` lists the seven function names still carrying our patch and reports a missing
settings dir or a foreign patch installed after us.

19 tests green (`node --test test/*.test.ts`), 11 of them at the patched-fs seam against
real temp dirs.

Deviations later tickets MUST know:

1. **Whitelisted writes already redirect** to `AD/extensions/settings/<plugin>.json`
   (creating `extensions/settings/`). Ticket 03 must replace this with the
   merge/shallow-validate write; the single seam is `patched.writeFileSync` /
   `patched.promisesWriteFile` in `src/fs-intercept.ts`, i.e. route through `src/config.ts`.
2. **`existsSync`/`statSync` on a whitelisted old path report the unified file** when it
   exists (fall through to the old path otherwise), so existence checks agree with reads.
3. **ESM named imports of `node:fs` are not patched.** `import { readFileSync } from "node:fs"`
   snapshots the binding at instantiation; only property access through the module object
   (`fs.readFileSync`, `require("node:fs").readFileSync`) is intercepted. Tests must use
   `import fs from "node:fs"` (this repo's test files do). Real plugins loaded by jiti/CJS
   are covered.
4. **`resolveTarget(p)` returns the settings path for whitelisted config paths and
   `undefined` for everything else**; the "unified file missing -> use old path" fallback
   lives in the wrappers, not in `resolveTarget`, so ticket 03/04 extend one place.
5. **`expandPath` also expands a leading `<agent>` token** to the agent dir (convenience for
   descriptors). `~` and `$VAR` are as specified; matching is on the expanded string, no
   path resolution of relative inputs.
6. **Adapter clash policy:** agent-dir descriptors are scanned first, then `extraDirs` in
   order; a name already seen wins, so a user descriptor overrides a shipped one. Invalid
   descriptors and unreadable dirs become warnings only.
7. **`src/index.ts` installs with `cwd: process.cwd()`, `projectTrusted: false`** at factory
   time. The project-override trust path (`ctx.isProjectTrusted()`) needs the intercept
   options refreshed at `session_start` — a later ticket must uninstall/reinstall (chain is
   safe) or add a re-resolve hook.
8. `agentDir(env?)`'s optional argument is for tests only; production calls pass nothing.
