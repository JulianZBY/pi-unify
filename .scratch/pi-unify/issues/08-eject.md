# 08: /unify:eject 退路

**What to build:** 反向迁移命令 `/unify:eject <插件名>`：按层合并配置写回插件旧路径、清除该插件的重定向与迁移状态、恢复原布局。保证 pi-unify 可被安全卸载。

**Blocked by:** 07.

**Status:** resolved

- [x] eject 后旧路径存在合并结果（含项目覆盖生效值），插件卸载 pi-unify 后可正常读取
- [x] 该插件的迁移/重定向状态被清除
- [x] 未迁移的插件 eject 报告无可做操作而非报错

## Answer

### Exported signature (`src/eject.ts`)

```ts
export interface EjectOptions {
  agentDir: string;
  adapters: Adapter[];
  cwd?: string;
  projectTrusted?: boolean;
  now?: () => Date;
}
export interface EjectResult { ok: boolean; message: string; restored: string[]; backedUp: string[] }
export const EJECT_USAGE = "usage: /unify:eject <plugin-name>";
export function eject(name: string, opts: EjectOptions): EjectResult;
```

`name` is the raw command args string; `eject` trims it. Never throws. `restored` = absolute
old paths written/moved back to (config file first, then one dir per data pair); `backedUp` =
absolute paths under the pre-eject backup dir. The handler in `src/index.ts` only notifies
`result.message` (`info` when ok, `error` otherwise) — same style as `/unify:migrate`.

### Decisions

- **Merged view wins, project layer included.** The old file is written from
  `readConfig(configLayers(...)).merged`, i.e. global + project override with the project
  winning, so a still-installed plugin sees the same values it saw under pi-unify. The
  project layer is only merged when the caller passes `projectTrusted: true` (the command
  handler passes `ctx.isProjectTrusted()`). The override file itself is never written or
  removed. Consequence: project-scoped values get baked into the old global file — that is
  the point of the ticket, and it is recoverable from the pre-eject backup.
- **Unified config file is removed** after the write-back, so the intercept finds no unified
  layer and falls back to the old path. That is what "clears the redirect" can mean without
  touching `src/fs-intercept.ts` (whitelist is adapter-driven, not state-driven). Data dirs
  are moved back and their now-empty unified dirs removed, which makes the data redirect a
  no-op for the same reason.
- **No-op instead of error.** Already-migrated files gone, or a plugin with no state entry,
  returns `ok: true` with "nothing to eject" (no backup dir, no throw); the second case also
  leaves an existing old file untouched. Usage/unknown name are `ok: false` (same as migrate).
- **Idempotent.** Second run finds no state entry and reports "nothing to eject"; the backup
  dir is not touched. `eject` then `migrate` works again because the state entry is gone.
- **State entry is cleared** whenever the record exists and the restore did not throw — also
  when nothing was left on disk, so a stale record can no longer block re-migration. A thrown
  restore keeps the entry and names the backup dir.

### Backup policy

Backups are never deleted, including the migrate-time ones.

```text
<AD>/extensions/data/unify/backup/<plugin>/<timestamp>-eject/
  config/<basename of the old config path>   <- copy of the unified file (raw, not merged)
  data/<basename of the old data dir>/...    <- copy of the unified data dir
```

`<timestamp>` is the same flattened ISO form migrate uses, with `-eject` appended
(`2026-02-03T04-05-06-000Z-eject`); a same-second collision gets `-2`, `-3`, ... The
`config/<basename of the old path>` naming mirrors `migrate`'s layout (keyed by the old path).
The raw unified file is backed up deliberately: the written-back old file is the merged view,
so only the raw copy lets you see which values came from the project layer.

Tests: `test/eject.test.ts` (12 cases) covering unknown/empty name, never-migrated no-op,
merged write-back with and without trust, data move-back, unified removal, state clearing,
backup layout and content, idempotency, eject-then-migrate, and the command smoke test.

