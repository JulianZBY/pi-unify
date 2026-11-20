# 06: /unify 诊断视图

**What to build:** 唯一诊断命令 `/unify`：列出所有收编插件、其配置值及每个值来源层（全局/项目覆盖）、拦截与数据目录重定向健康状态、启动自检结果。排查「这个设置为什么这样生效」的唯一入口。

**Blocked by:** 03, 04, 05.

**Status:** ready-for-agent

- [ ] 命令列出全部已加载 adapter 的插件
- [ ] 每个配置值标注来源层
- [ ] 重定向状态异常（如目标缺失）可见
- [ ] 自检告警在视图中展示

## Answer

**Status:** resolved

- [x] 命令列出全部已加载 adapter 的插件
- [x] 每个配置值标注来源层
- [x] 重定向状态异常（如目标缺失）可见
- [x] 自检告警在视图中展示

**Files:** `src/diagnose.ts` (new), `test/diagnose.test.ts` (new, 13 tests); `src/index.ts` handler
now calls `diagnose(...)` and notifies one multi-line string (`warning` type when the self-check
has hits).

**Signature:**

```ts
export interface DiagnoseInput {
  agentDir: string; cwd: string; projectTrusted: boolean;
  adapters: Adapter[]; warnings: string[];
  health: { patched: string[]; problems: string[] };
}
export function diagnose(input: DiagnoseInput): string[];
```

Sections in order: adapter list with migration state, per-adapter config keys with source layer,
interception health, self-check, data dirs, loader warnings. Config source layers come from
`readConfig(configLayers(...)).sources`; keys served by the old file (no layer yet) are labelled
`default`. An untrusted-but-present project override is reported as ignored.

**Sample output:**

```
pi-unify: 2 adapter(s) loaded, 1 migrated
- pi-caveman [migrated 2026-02-01T10:00:00Z]
    config layers: global /ad/extensions/settings/pi-caveman.json (project override ignored, project not trusted: /proj/.pi/unify/caveman.json)
      level = "full" (source: global)
- pi-demo [not migrated]
    config layers: no unified layer yet, no old file at /ad/demo.json
interception: 2 fs function(s) patched: readFileSync, existsSync
  problem: unified settings dir missing: /x/extensions/settings
self-check: ok, no adopted config file was read before interception
data dirs: 1
  pi-caveman: /ad/extensions/data/pi-caveman - ok, old dir still present: /ad/caveman-cache
```

**For ticket 08 (eject):** the view only reads `readState(ad)` and never writes; a missing state
file means "0 migrated" and untrusted projects hide the project layer entirely. Eject should clear
the plugin's `state.migrations` entry and can rely on `dataTargets` ordering (first declaration
wins) when reporting what it moves back.
