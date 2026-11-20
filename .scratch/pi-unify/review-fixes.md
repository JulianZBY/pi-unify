# Post-review fixes

Findings from the code review of `integration/pi-unify`, in severity order. Each
fix has a regression test. 101 tests before, 115 after.

1. **Project layer baked at install time** (`src/fs-intercept.ts`) — the whitelist
   now maps an old config path to its adapter; `resolveTarget` recomputes the
   layers from the live `opts.cwd`/`opts.projectTrusted` on every call, so a
   `session_start` cwd/trust update takes effect without re-patching.
2. **Destructive migrate over an existing unified file** (`src/migrate.ts`) — an
   existing unified config is backed up into the migration dir and merged as
   `{...existing, ...incoming}` (incoming old file wins, no key is lost). `mergeDir`
   takes a collision callback that backs the destination file up before replacing it.
3. **Config wipe by partial writes** (`src/config.ts`) — validated writes are merged
   over the existing global object, so keys the write omits survive. An explicit
   `{}` over a populated file is skipped with a warning instead of wiping it.
4. **Eject overwrote old-path files without backup** (`src/eject.ts`) — an existing
   `record.config.from` and every existing destination inside `mergeDir` are copied
   into the eject backup dir first.
5. **Unsafe uninstall / probe never removed** (`src/fs-intercept.ts`, `src/probe.ts`,
   `src/index.ts`) — uninstall restores a slot only while it is still ours, so a
   patch installed afterwards survives; both the intercept and the probe do this.
   `index.ts` calls `uninstallProbe()` right after `installIntercept` succeeds; the
   captured self-check data is kept.
6. **Unjournalled move** (`src/migrate.ts`) — the state record is written before the
   move phase. If the move fails with nothing moved, the entry is cleared (retry
   works); if anything moved it stays, so eject can reverse the partial migration.
7. **Silent write rejection** (`src/index.ts`) — `onWarn` counts rejected config
   writes, and `session_start` plus every command notify one rolled-up line
   (`pi-unify: N config write(s) rejected — run /unify for details`) per batch.
8. **Non-atomic state write** (`src/state.ts`) — `state.json.tmp` + `renameSync`, so
   a crash cannot truncate the file holding every migration record.
9. **Eject lost the config when the descriptor disappeared** (`src/eject.ts`) — with
   no matching adapter, eject falls back to `record.config.to`/`.from` and still
   restores the unified config.

Documented limits (deliberately not fixed): callback-style `fs` variants and
pi-fff's native-addon LMDB data dirs (README "Limits"), and the self-check's
"reads after load only" blind spot (issue 05 "Limits").
