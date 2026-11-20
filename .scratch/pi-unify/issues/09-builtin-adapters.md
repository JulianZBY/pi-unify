# 09: 内置 6 个 adapter + 安装文档

**What to build:** 随包发布首版收编插件的 adapter 描述单：pi-caveman、pi-fff、pi-web-search、pi-cc-extensions（配置文件）、pi-memory（数据目录）、pi-lens（仅文件部分）。README 讲清安装方式、packages 首位要求、迁移流程与退路。

**Blocked by:** 03, 04, 07.

**Status:** resolved

- [x] 6 份 adapter 描述单随包提供，路径与各插件实际布局核对过
- [x] 至少一个真实插件完成端到端迁移验证（建议 pi-caveman 当小白鼠）
- [x] README 覆盖：安装、加载顺序要求、迁移、eject、项目覆盖写法
- [x] ponytail、pi-ask-user 在文档中明确列为不适用（无独立配置）

## Answer


- [x] 6 份 adapter 描述单随包提供，路径与各插件实际布局核对过
- [x] 至少一个真实插件完成端到端迁移验证（pi-caveman）
- [x] README 覆盖：安装、加载顺序要求、迁移、eject、项目覆盖写法
- [x] ponytail、pi-ask-user 在文档中明确列为不适用（无独立配置）

### Shipped descriptors (`adapters/*.json`)

| File | name | config.path | projectOverride | data |
| --- | --- | --- | --- | --- |
| `pi-caveman.json` | pi-caveman | `<agent>/caveman.json` | `caveman.json` | — |
| `pi-fff.json` | pi-fff | `<agent>/pi-fff.json` | `pi-fff.json` | `<agent>/fff/frecency`, `<agent>/fff/history` |
| `pi-web-search.json` | pi-web-search | `<agent>/web-search.json` | `web-search.json` | — |
| `pi-cc-extensions.json` | pi-cc-extensions | `<agent>/pi-cc-extensions.json` | `pi-cc-extensions.json` | — |
| `pi-memory.json` | pi-memory | — | — | `~/.pi/agent/memory` |
| `pi-lens.json` | pi-lens | `~/.pi-lens/config.json` | `pi-lens.json` | — |

Verified against installed sources: `pi-caveman/extensions/caveman.ts` (`getConfigDir` honors
`PI_CODING_AGENT_DIR`), `@ff-labs/pi-fff/src/config.ts` + `src/paths.ts` (`piDataDir()` honors it),
`pi-web-search/src/utils.ts` (`getAgentDir()`), `pi-cc-extensions/extensions/config/config.ts`
(`AGENT_DIR`). Those four use the `<agent>` token so a relocated agent dir keeps matching.

Two deviations from the notes file, both deliberate:

- `pi-memory` resolves `$HOME/.pi/agent/memory` (or `$PI_MEMORY_DIR`) and does **not** honor
  `PI_CODING_AGENT_DIR`, so its descriptor is the literal `~/.pi/agent/memory`.
- `pi-lens` global config default is `~/.pi-lens/config.json`; it additionally falls back to
  `<agent>/extensions/pi-lens.json` when that file is absent, and honors `PI_LENS_CONFIG_PATH` /
  `PI_LENS_HOME`. Only the file part above is adopted (one config path per descriptor, env-var
  surface is out of scope); documented in README.

### Tests (`test/builtin-adapters.test.ts`, 4 tests)

Loading all six with zero warnings; exact path/projectOverride/data table; e2e pi-caveman
migration through the real intercept (`installIntercept` -> `migrate` -> plugin read of the OLD
`<agent>/caveman.json` returns the migrated values, no stale duplicate on disk, plugin write via
the old path lands in `extensions/settings/pi-caveman.json`); project override wins only when
trusted. The e2e test proved the descriptor path actually drives interception, not just the scan.

`test/skeleton.test.ts` needed one line changed: its `/unify` assertion hardcoded "0 adapter(s)
loaded", which stopped being true once shipped descriptors exist.
