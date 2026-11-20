# 05: 启动自检

**What to build:** 拦截层安装前记录哪些收编路径已被进程读取；安装完成后若有命中，启动时告警，且诊断视图（06）能展示自检结果。作用：捕获加载顺序错误导致的静默失效。

**Blocked by:** 02.

**Status:** ready-for-agent

- [ ] patch 前命中收编路径的读取被记录
- [ ] 命中时启动阶段产生用户可见告警
- [ ] 自检结果数据可供诊断命令读取

## Limits

The self-check can only observe reads that happen after pi-unify loaded, so it catches "some plugin loaded before me", not "every plugin did".

## Answer

Status: resolved. Implemented in new `src/probe.ts` (owned) plus a 23-line addition to
`src/index.ts`. `src/fs-intercept.ts` was not touched.

Exports ticket 06 must use (from `src/probe.ts`):

```ts
interface SelfCheckResult { hits: string[]; ok: boolean }

selfCheck(): SelfCheckResult          // stable read-only copy of the last factory result
setSelfCheck(result): void            // index.ts calls this once per factory run
earlyReads(adapters: Adapter[], ad: string): string[]   // recorded ∩ whitelisted config paths

installProbe(): void                  // called automatically at module evaluation
uninstallProbe(): void                // tests only
clearProbe(): void                    // tests only
```

Ticket 06 reads `selfCheck()` (or imports it via `./index.ts`'s module state, which is the
same object) and renders `hits`/`ok`. `ok === hits.length === 0`. `hits` are sorted
absolute expanded old config paths.

How it works:

- `src/probe.ts` patches `fs.readFileSync` and `fs.promises.readFile` when the module is
  evaluated (last line of the file) and calls `syncBuiltinESMExports()` so named ESM
  imports of `node:fs` reach the probe too. It records only plain string paths into a
  `Set` capped at 2000 entries, drops everything after the cap, and always delegates to the
  saved original — Buffers, fds, URLs and error paths behave exactly like the original.
- `src/index.ts` imports `./probe.ts` as its first import, so the probe is live before
  adapters load and before other extensions in the same process can read their configs.
  The factory keeps the existing load + `installIntercept` flow, then computes
  `earlyReads(adapters, ad)` and stores it with `setSelfCheck`. Because `installIntercept`
  saved the probe wrapper as *its* original, the two patches chain: intercept ->
  probe -> real fs, and `intercept.uninstall()` restores the probe wrapper.
- `pi.on("session_start")` emits, only when `ctx.hasUI` and hits exist:
  `pi-unify: <n> adopted config file(s) were read before interception was installed — pi-unify must be first in `packages`. Move it to the top and /reload.` with type `warning`.
- `/unify` is unchanged in its base summary and appends
  `; <n> adopted config file(s) read before interception` only when `ok` is false.

Tests: `test/probe.test.ts` (6, probe seam against temp dirs) and `test/selfcheck.test.ts`
(2, factory seam with a fake `pi` + fake ctx: warns on pre-install read, silent otherwise).
Full suite: 28 pass / 0 fail (`node --test test/*.test.ts`).

Note for later tickets: `installIntercept` installs once per factory call with
`projectTrusted: false`; if the intercept is reinstalled at `session_start` the self-check
result should be recomputed from `earlyReads` at that point, since `hits` is a snapshot.
