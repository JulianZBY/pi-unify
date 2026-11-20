# 08: /unify:eject 退路

**What to build:** 反向迁移命令 `/unify:eject <插件名>`：按层合并配置写回插件旧路径、清除该插件的重定向与迁移状态、恢复原布局。保证 pi-unify 可被安全卸载。

**Blocked by:** 07.

**Status:** ready-for-agent

- [ ] eject 后旧路径存在合并结果（含项目覆盖生效值），插件卸载 pi-unify 后可正常读取
- [ ] 该插件的迁移/重定向状态被清除
- [ ] 未迁移的插件 eject 报告无可做操作而非报错
