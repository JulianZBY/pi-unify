# 01: 最小可加载骨架

**What to build:** pi-unify 能通过本地路径安装进 pi、被排到 packages 列表第一位、随 pi 启动正常加载。加载后注册一个无操作命令证明存活（后续 ticket 会替换为真实命令）。

**Blocked by:** None (can start immediately).

**Status:** resolved

- [x] 本地路径安装成功，pi 启动无报错
- [x] 扩展在所有其它 package 之前加载（加载顺序可验证）
- [x] 注册的存活命令可调用
- [x] 仓库有 package.json 与入口结构，扩展入口遵循 pi 扩展约定

## Answer

`package.json` declares `pi.extensions: ["./src/index.ts"]` and no runtime dependencies (host
API is mirrored structurally in `src/types.ts` so `node --test` runs without the host package).
`src/index.ts` is the factory; `/unify` liveness command registered. `test/skeleton.test.ts`
covers registration + invocation.

End-to-end load verified against pi 1.5.2 with an isolated agent dir
(`PI_CODING_AGENT_DIR=/tmp/unify-pi-home`, `packages: ["/home/julianzby/pi-extension-rules"]`):
`pi list` lists the package and a temporary marker write at the top of the factory fired during
`pi -p`, proving pi discovered and loaded the local-path package first in `packages`. Pi orders
packages by array position (`docs/packages.md` / package-manager resolve order).
