# 04: 数据目录重定向

**What to build:** adapter 描述单中声明的数据/缓存目录的文件系统调用被重定向到统一数据目录下以插件名命名的子目录；白名单外的目录操作不受影响。

**Blocked by:** 02.

**Status:** resolved

- [x] 白名单内数据目录的读写调用落到重定向后的位置
- [x] 白名单外目录操作透传不受影响
- [x] 与配置拦截（02 的白名单）互不干扰，可同时生效

## Answer

`src/data-dir.ts` (new) owns the mapping; `src/fs-intercept.ts` wires it in after the
config whitelist so config always wins.

Exports:
```ts
interface DataTarget { plugin: string; old: string; unified: string }
interface DataPath   { target: DataTarget; old: string; unified: string }
dataTargets(agentDir: string, adapters: Adapter[]): DataTarget[]
matchDataPath(targets: DataTarget[], p: unknown): DataPath | undefined
preferUnified(dp: DataPath): string   // read side: unified if it exists, else old, else unified
writePath(dp: DataPath): string       // write side: always unified
parentDir(dp: DataPath): string       // dirname(unified), created before a write
dataHealth(targets: DataTarget[]): string[]
```

Matching is exact-prefix on the expanded absolute old dir (`p === old || p.startsWith(old + sep)`),
remainder preserved under `AD/extensions/data/<plugin>/`. No prefix guessing beyond a real path
boundary: `<ad>/memory-other` does not match `<ad>/memory`.

Patched calls (all also added to `health().patched`): `readFileSync`, `writeFileSync`,
`existsSync`, `statSync`, `mkdirSync`, `readdirSync`, `rmSync`, and the `fs.promises`
counterparts `readFile`, `writeFile`, `stat`, `mkdir`, `readdir`, `rm`.
`uninstall()` restores all of them.

Reads/deletes follow the read side (unified wins, else the un-migrated old path). Writes and
`mkdir` always land on the unified side with parent dirs created, so a plugin writing a fresh
file never recreates the old layout. A path under no declared data dir is passed through
untouched. `health()` adds "adapter X data path is not a directory" when an old data dir
exists as a non-directory.

Tests: `test/data-dir.test.ts`, 12 tests; suite total 56 green.
