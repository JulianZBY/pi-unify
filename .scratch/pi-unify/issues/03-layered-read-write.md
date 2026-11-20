# 03: 分层读 + 写规则 + 浅校验

**What to build:** 完整配置语义上线。配置读取返回「全局统一文件 + 已信任项目覆盖文件」的合并结果，项目覆盖优先；插件发起的写入永远写全局统一文件，项目覆盖文件永不被插件写入；写入前按现有文件结构做浅校验（key 存在性 + 值类型），不匹配拒绝写入并告警。

**Blocked by:** 02.

**Status:** resolved

- [x] 全局文件与项目覆盖文件同 key 不同值时，读取返回项目层值
- [x] 项目未信任时项目覆盖不参与合并
- [x] 插件写入落全局层，项目覆盖文件内容不变
- [x] 写入不存在的 key 或类型不匹配的值被拒绝并告警
- [x] 对着真实临时目录的外部行为测试全部通过

## Answer

Done in `src/config.ts` (new, owned), `test/config.test.ts` (new, owned), plus the config
routing inside `src/fs-intercept.ts` and ~10 lines of `src/index.ts` (trust flag on
`session_start`). No signature from the design notes changed.

### `src/config.ts` signatures

```ts
export type LayerName = "global" | "project";

export interface ConfigLayers { global: string; project?: string }
export interface ConfigView { merged: Record<string, unknown>; sources: Record<string, LayerName> }

export interface LayerContext { agentDir: string; cwd: string; projectTrusted: boolean }

// global = <ad>/extensions/settings/<plugin>.json
// project = <cwd>/.pi/unify/<adapter.config.projectOverride>, only when projectTrusted
export function configLayers(ctx: LayerContext, adapter: Adapter): ConfigLayers | undefined;

// Shallow merge, project layer wins per key. undefined = no layer (caller falls
// through to the old path). `sources` maps each winning key to its layer.
export function readConfig(layers: ConfigLayers): ConfigView | undefined;

// Validates, then writes the global layer only. Returns false when rejected.
export function writeConfig(
  layers: ConfigLayers,
  data: string | Uint8Array,
  onWarn?: (msg: string) => void,
): boolean;
```

### Read semantics (through intercepted fs)

- `readFileSync` / `promises.readFile` on a whitelisted old path return `JSON.stringify(merged)`,
  as a string when the caller passed an encoding, as a Buffer otherwise.
- Layers: global first, then project when `opts.projectTrusted` is true (read per call, so trust
  set later in the session applies without re-patching). Top-level keys only; project wins.
- No layer at all -> original old path (unmigrated plugin), unchanged from ticket 02.
- A layer that is not a JSON object (plain-text/legacy config) is treated as "no layer" and the
  raw existing file is served, so plain-text configs keep working.
- `existsSync` -> true when any layer exists; `statSync` -> stats the global file
  (`shortcut:` its size is not the merged size when the project layer adds keys).

### Write semantics

- `writeFileSync` and `promises.writeFile` on a whitelisted old path always write
  `<ad>/extensions/settings/<plugin>.json`; the project override is never written.
- Bytes are written as given (`Buffer` stays a Buffer, string stays utf8); write options
  (`mode`/`flag`) are dropped (`shortcut:` whole-file replaces only).
- Async rejection is silent from the caller's view: the promise resolves, nothing is written.

### Validation rules (shallow, no schema library)

1. The payload must decode to a JSON **object** (not array/null/scalar). Otherwise rejected.
2. The existing shape is the **merged view** (so a key that exists only in the project layer
   counts as existing). No existing file -> no shape -> the first write is allowed (adoption).
3. Every top-level key being written must already exist in the existing shape.
4. `typeOf(existing) === typeOf(next)` with tags `object | array | string | number | boolean | null`
   (no recursion into nested values).
5. Any violation: nothing is written and `onWarn` gets one message
   (`reject config write to <path>: unknown key "x"` / `... expects <type>, got <type>` /
   `... not a JSON object`).

### Tests

`test/config.test.ts`: 16 tests, all external behaviour against real temp dirs (merged read,
untrusted read, fall-through, project-only layer, async read, global-only write, async write,
Buffer write, unknown key, four type mismatches, matching types accepted, adoption, project-only
key, non-JSON write, async rejection, live trust flip). `node --test test/*.test.ts` = 44 pass, 0 fail.

### For later tickets

- Diagnostics (06): call `readConfig(configLayers({agentDir, cwd, projectTrusted}, adapter))` and
  use `view.sources[key]` for the per-key layer, `undefined` = no layer = "default/unmigrated".
- Migrate (07) / eject (08): write through `fs` on the old path (goes global + validated), or use
  `writeConfig(layers, ...)` directly; read the merged view with `readConfig` before ejecting so
  the project layer can be folded back.
