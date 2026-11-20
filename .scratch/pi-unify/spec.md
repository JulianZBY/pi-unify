# pi-unify — 统一 pi 插件的配置与数据目录

Status: implemented

## Problem Statement

pi coding agent 的生态里，每个插件（extension/package）自行决定配置文件和数据的存放位置：有的在 agent 全局目录下散落多个同名 JSON，有的开自己的数据目录，有的靠环境变量。用户装了多个插件后，配置四处分布，无法统一查看和管理，也难以备份和同步。

## Solution

一个垫片型 pi 插件 `pi-unify`。它在所有其它插件之前加载，通过进程内拦截文件系统调用（路径白名单精确匹配），把所有收编插件的配置读写重定向到统一位置：

- 配置文件 → agent 目录下 `extensions/settings/<插件名>.json`，用户直接编辑文件管理，无写配置命令
- 数据/缓存目录 → agent 目录下 `extensions/data/<插件名>/`
- 支持项目级覆盖：项目内同名覆盖文件合并到读取结果之上；插件自身的写入永远只落全局层
- 插件本身完全无感知，不需要 fork 或改造任何第三方插件
- adapter 机制可扩展：每个插件一份 JSON 描述单声明旧路径与新位置，自动扫描加载

迁移由用户手动逐个触发、迁移前自动备份；提供反向迁移（eject）作为完整退路。唯一的诊断命令 `/unify` 展示收编状态、每个配置值的来源层、迁移/拦截健康情况。

## User Stories

1. As a pi user, I want all my plugins' config files gathered under one directory, so that I can find and edit them without remembering where each plugin hides its settings.
2. As a pi user, I want all my plugins' data and cache directories gathered under one directory with per-plugin subfolders, so that my agent directory stays clean and backup/sync is trivial.
3. As a pi user, I want plugins to keep working without any modification, so that upgrading third-party plugins never breaks my unified layout.
4. As a pi user, I want plugin writes to their own config to land in the global unified file, so that plugin-internal state never pollutes my project repositories.
5. As a pi user, I want to override specific config values per project with a project-local file, so that a repo can use different plugin behavior without touching my global setup.
6. As a pi user, I want the project override file to be read-only from the plugin's perspective, so that plugins can never silently rewrite values I deliberately overrode.
7. As a pi user, I want to adopt plugins one at a time via an explicit migrate command, so that no data moves without my consent.
8. As a pi user, I want an automatic backup before each migration moves anything, so that a failed or wrong migration is always recoverable.
9. As a pi user, I want old files removed after a successful migration, so that no stale duplicate copies linger at the old locations.
10. As a pi user, I want an eject command that reverses the whole scheme, so that I can uninstall pi-unify without losing access to my plugin configs.
11. As a pi user, I want a diagnostic command showing each plugin's config values and which layer (global/project/default) each value comes from, so that I can answer "why is this setting behaving this way".
12. As a pi user, I want the diagnostic view to report the health of interceptions and symlinks-free redirections, so that I can detect a silently broken redirect before it bites.
13. As a pi user, I want a startup self-check that warns if any plugin read a config file before the interception layer was installed, so that a wrong load order can't cause silent misbehavior.
14. As a pi user, I want config writes validated against the existing file's shape (key existence and value type), so that a bad write can't silently corrupt a plugin's config.
15. As a pi user, I want to add support for any plugin by dropping a single JSON adapter descriptor into a known folder, so that I don't need to write code to onboard a new plugin.
16. As a pi user, I want pi-unify itself to load before every other package, so that interception is in place before any plugin reads config.
17. As a pi user, I want paths outside the adapter whitelist to pass through untouched, so that the interception layer can never break unrelated file operations.
18. As a pi user, I want migrations to be idempotent (running twice does nothing harmful), so that retried commands never double-move or destroy data.
19. As a pi user, I want pi-unify to honor the agent-dir relocation environment variable, so that it works for users who relocated their agent directory.
20. As a plugin author, I want my plugin's config to keep living at a single canonical file (the unified one), so that my own read/write logic works unchanged under pi-unify.

## Implementation Decisions

- **加载顺序**：pi-unify 必须是用户 `packages` 列表的第一项；README 与安装说明中明确要求，启动自检兜底。
- **拦截层**：monkey-patch 进程内的 `fs.readFileSync`/`writeFileSync`（及数据目录所需的相关 API）。保存原始函数形成透传链；仅白名单内路径被拦截，白名单来自已加载的 adapter 描述单。
- **配置读取合并**：拦截到的配置读取返回「全局统一文件 + 项目覆盖文件」的合并结果；项目覆盖优先。
- **配置写入规则**：插件发起的写入永远写全局统一文件；项目覆盖文件永不被插件写入。项目层定位为用户手动维护的只读覆盖。
- **数据目录重定向**：拦截目录相关调用，把旧数据路径重定向到 `extensions/data/<插件名>/`；迁移搬空旧目录、不留符号链接。
- **adapter 描述单**：纯 JSON，每插件一份，声明插件名、旧配置路径、旧数据路径列表、项目覆盖文件名。放在 agent 目录下 `extensions/unify/` 中自动扫描。首版不支持代码型 adapter（v2 再议）。
- **写入校验**：浅校验——写入前对照现有文件结构检查 key 存在性与值类型；不匹配拒绝写入并告警。首版不引入完整 schema。
- **迁移**：`/unify:migrate <name>` 手动触发；流程为 备份（复制到 `extensions/data/unify/backup/`）→ 搬移（move，旧位置不残留）→ 记录迁移状态。幂等。
- **退路**：`/unify:eject` 反向迁移：按层合并写回旧路径、清除重定向状态、恢复原布局。
- **自检**：拦截层安装前记录哪些收编路径已被读取；安装完成后若有命中则在 `/unify` 与启动通知中告警。
- **首版收编 adapter**：pi-caveman、pi-fff、pi-web-search、pi-cc-extensions（配置文件）、pi-memory（数据目录）、pi-lens（仅文件部分）。ponytail、pi-ask-user 无独立配置，跳过。
- **环境变量**：明确不管。各插件的 env-var 配置面不在本插件职责内。
- **项目信任**：项目覆盖文件仅在 pi 报告项目已信任时参与合并（沿用 pi 原生信任机制语义）。
- **agent 目录定位**：所有路径基于 `PI_CODING_AGENT_DIR`（或默认位置）解析，不硬编码家目录。
- **分发**：先本地路径安装，稳定后发 npm，包名 `pi-unify`。

## Testing Decisions

- **唯一主 seam：拦截后的 fs 层**。所有测试对着真实临时目录，通过 patched 后的 fs 调用断言外部行为：合并读取语义、写落全局层且项目文件不动、数据目录重定向、白名单外透传。adapter 加载、迁移、备份、幂等性全部经这一层间接覆盖，不测内部实现。
- **命令 seam 冒烟**：`/unify`、`/unify:migrate`、`/unify:eject` 三个命令走 pi ExtensionAPI 做冒烟级测试（该 seam 由 pi 宿主提供）。
- 本仓库为全新项目，无既有测试先例；测试随实现建立，放在与实现分离的测试目录，用 Node 内建 test runner 或与 pi 生态一致的轻量方案。

## Out of Scope

- 环境变量配置的统一（各插件 env-var 面）——明确不做
- 修改或 fork 任何第三方插件源码
- 完整 schema 校验（zod/typebox 声明式 schema）——首版仅浅校验
- 代码型（TS）adapter —— v2 再议
- 热重载配置：pi 不支持插件配置热加载，本插件同样要求重启或 /reload 生效
- 首版收编范围外的插件适配（可后续以 adapter JSON 增量添加，不算本 spec 变更）

## Further Notes

- fs monkey-patch 是高强度手段，已知风险：pi 宿主升级、或其它插件也 patch fs 时可能冲突。缓解：白名单精确匹配、补丁链透传、自检告警。
- 设计经一轮 grilling 访谈收敛，全部决策（含被否决的 symlink-only、智能写入分流、自动迁移等备选）已在会话中确认。
