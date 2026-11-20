# 07: /unify:migrate 迁移

**What to build:** 手动逐个迁移命令 `/unify:migrate <插件名>`：先把旧位置文件备份到统一数据目录下的备份区，再 move 到统一位置（旧位置不残留），记录迁移状态。重跑无害（幂等）。

**Blocked by:** 03, 04.

**Status:** resolved

- [x] 迁移前旧文件完整备份到备份区
- [x] 迁移后旧位置无残留，统一位置内容与原文件一致
- [x] 已迁移的插件重跑命令直接成功无副作用
- [x] 迁移状态被记录，供诊断视图与 eject 使用

## Answer


- [x] 迁移前旧文件完整备份到备份区
- [x] 迁移后旧位置无残留，统一位置内容与原文件一致
- [x] 已迁移的插件重跑命令直接成功无副作用
- [x] 迁移状态被记录，供诊断视图与 eject 使用

### Exported signature (`src/migrate.ts`)

```ts
export interface MigrateOptions { agentDir: string; adapters: Adapter[]; now?: () => Date }
export interface MigrateResult { ok: boolean; message: string; backedUp: string[]; moved: string[] }
export const MIGRATE_USAGE = "usage: /unify:migrate <plugin-name>";
export function migrate(name: string, opts: MigrateOptions): MigrateResult;
```

`name` is the raw command args string; `migrate` trims it. Never throws: unknown/empty name,
backup failure and move failure all return `ok: false` with a message. `now` is the clock seam
for reproducible backup timestamps. `backedUp` = absolute backup paths (config file path, one
dir path per old data dir); `moved` = absolute unified destinations. The command handler in
`src/index.ts` only notifies `result.message` (`info` when ok, `error` otherwise).

### Backup layout

```
<AD>/extensions/data/unify/backup/<plugin>/<timestamp>/
  config/<basename of old config file>
  data/<basename of old data dir>/<relative path inside it>
```

`<timestamp>` = `now().toISOString()` with `:` and `.` replaced by `-`
(`2026-02-03T04:05:06.000Z` -> `2026-02-03T04-05-06-000Z`). Two migrations inside the same
second get distinct dirs: the second one gets a `-2` suffix (then `-3`, ...).

### Behaviour details for eject (ticket 08)

- Order per call: BACKUP every old file -> MOVE -> `writeState`. A move failure leaves the
  state untouched (the backup dir is named in the failure message).
- Config: `renameSync(old -> <AD>/extensions/settings/<plugin>.json)`; destination parents created.
- Data: contents merged recursively into `<AD>/extensions/data/<plugin>/` (an existing subtree on
  both sides merges; a conflicting file at the destination is replaced); old dir removed when empty.
- Idempotent: a plugin already in `readState().migrations` returns `ok: true` "already migrated"
  and touches nothing. No old files at all returns `ok: true` "no old files to migrate", records
  nothing, creates no backup dir.
- Project overrides (`<cwd>/.pi/unify/*`) are never read or written here; post-migration merged
  reads still layer them via `configLayers`/`readConfig`.
- `MigrationRecord` written: `{ migratedAt, config?: { from, to }, data?: [{ from, to }] }` —
  eject must invert exactly these `from`/`to` pairs and then clear the entry.
