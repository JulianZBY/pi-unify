# 01: 最小可加载骨架

**What to build:** pi-unify 能通过本地路径安装进 pi、被排到 packages 列表第一位、随 pi 启动正常加载。加载后注册一个无操作命令证明存活（后续 ticket 会替换为真实命令）。

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] 本地路径安装成功，pi 启动无报错
- [ ] 扩展在所有其它 package 之前加载（加载顺序可验证）
- [ ] 注册的存活命令可调用
- [ ] 仓库有 package.json 与入口结构，扩展入口遵循 pi 扩展约定
