# pi-unify

Gather every adopted pi plugin's config and data under one directory, without
forking or patching the plugins themselves.

pi-unify installs a filesystem shim in the pi process. A path whitelist is built
from adapter descriptors (one small JSON file per plugin), and only exact
whitelisted paths are redirected; everything else passes through untouched.

Two consequences worth knowing before you install:

- The shim is an in-process monkey patch of `node:fs` (sync, promises and named
  ESM imports). A pi host upgrade that changes how it reads config, or another
  plugin that also patches `fs`, can conflict with it. `/unify` reports whether
  the patch is still ours.
- Nothing moves on its own. You migrate plugins one at a time, and every
  migration is backed up first.

## Install

Local path install (until the package is published):

```bash
pi install /abs/path/to/pi-unify
```

This adds an entry to your pi settings `packages` array. If you write it by hand,
pi-unify **must be the first entry**:

```json
{
  "packages": ["/abs/path/to/pi-unify", "other-package", "..."]
}
```

Why first: the shim has to be installed before any other plugin reads its config.
pi runs packages in array order, so a plugin loaded earlier would read the old
path and miss the merged view. To guard against a wrong order, pi-unify records
which adopted config paths were read before its own load; if any were, the
startup self-check notifies you (`/unify` shows it too). Fix the order and
`/reload`.

## Unified layout

Agent dir = `$PI_CODING_AGENT_DIR`, default `~/.pi/agent`.

```
<agent>/
  extensions/
    settings/<plugin>.json        # config: the single canonical file per plugin
    data/<plugin>/                # data and cache directories per plugin
    data/unify/backup/            # pre-migration backups
    data/unify/state.json         # what was migrated, for /unify and eject
    unify/<plugin>.json           # adapter descriptors you drop in yourself
```

Shipped descriptors use `<plugin>.adapter.json`, because a bare `<plugin>.json` in a
checked-out repo gets picked up by some plugins as their project config (pi-lens
does exactly that with `pi-lens.json`). Yours are matched on their `name` field, so
either name works, but prefer `<plugin>.adapter.json`.

Project overrides live in the repository:

```
<repo>/.pi/unify/<plugin>.json
```

Only merged into reads when pi reports the project as trusted. It is a
hand-maintained, read-only layer: plugins never write it, and their own writes
always land in the global file `extensions/settings/<plugin>.json`.

## Commands

- `/unify` — status: adopted plugins, per-key layer (`global`/`project`),
  migration state, and intercept health / self-check result.
- `/unify:migrate <plugin>` — back up every old file, move it into the unified
  layout, record the migration. Idempotent: a second run reports "already
  migrated" and touches nothing. Unknown names and failures leave everything in
  place and name the backup directory.
- `/unify:eject <plugin>` — reverse migration: restore the old layout from the
  recorded `from`/`to` pairs. Backups are kept.

Config is read at extension load. Changing config or the `packages` order needs a
restart or `/reload`; there is no hot reload.

## Built-in adapters

| Plugin | Old config | Old data |
| --- | --- | --- |
| pi-caveman | `<agent>/caveman.json` | — |
| pi-fff | `<agent>/pi-fff.json` | none — its LMDB dirs are opened by a native addon (see Limits) |
| pi-web-search | `<agent>/web-search.json` | — |
| pi-cc-extensions | `<agent>/pi-cc-extensions.json` | — |
| pi-memory | — | `~/.pi/agent/memory` (`MEMORY.md`, `daily/`, `recovery/`, scratchpad) |
| pi-lens | `~/.pi-lens/config.json` | — |

Notes on the table:

- `pi-cc-extensions` also reads the legacy `claude-code-style.json` when the new
  file is absent. That legacy read is not adopted; once you migrate, the plugin's
  own legacy fallback is irrelevant because the unified file exists.
- `pi-memory` resolves its directory from `$HOME`, not from
  `$PI_CODING_AGENT_DIR`, so its descriptor names the literal
  `~/.pi/agent/memory`.
- `pi-lens` is adopted for its **config file part only**. Its other
  `~/.pi-lens/` subdirectories (`bin`, `grammars`, install logs) are tool
  installation state, not user data, so they stay where they are. The legacy
  `~/.pi-lens/lsp.json` is ignored by pi-lens itself and is not adopted.
  `PI_LENS_HOME` / `PI_LENS_CONFIG_PATH` overrides are not handled.
- These descriptors use the `<agent>` token so relocating
  `$PI_CODING_AGENT_DIR` keeps matching the plugins that honor it.

## Limits

- Only `fs.*` and `fs.promises.*` are redirected. Callback-style
  `fs.readFile(path, cb)` and `fs.readFile(path, opts, cb)` are not patched, so a
  plugin that reads its config that way still sees the old path.
- pi-fff's data lives in LMDB directories opened by a native addon, which bypasses
  the in-process fs shim entirely: the addon reopens and recreates the old path even
  after a migration. Its descriptor therefore declares the config file only. If you
  want those databases under the unified root, point pi-fff at them itself — its own
  config supports absolute paths:

  ```jsonc
  // extensions/settings/pi-fff.json
  {
    "frecencyDbPath": "/abs/path/.pi/agent/extensions/data/pi-fff/frecency",
    "historyDbPath": "/abs/path/.pi/agent/extensions/data/pi-fff/history"
  }
  ```

  That is the plugin's own configuration, not interception: no `~`, absolute paths
  only, and moving the databases is a plain file move.

## Not applicable

- **ponytail** — no standalone config file; settings travel with the package.
- **pi-ask-user** — no standalone config file.

Both are skipped rather than adopted with an empty descriptor.

## Adding a plugin

Drop one JSON descriptor into `<agent>/extensions/unify/`. A descriptor with the
same name as a shipped one wins.

```json
{
  "name": "my-plugin",
  "config": { "path": "<agent>/my-plugin.json", "projectOverride": "my-plugin.json" },
  "data": ["<agent>/my-plugin-cache"]
}
```

`config` and `data` are both optional. Paths are literal: `~`, `$VAR`/`${VAR}`
and a leading `<agent>` token are expanded; matching later happens on the
expanded absolute form, exact only. A malformed descriptor is skipped with a
warning, never fatal. Restart or `/reload` after adding one, then
`/unify:migrate my-plugin`.

## Limits

- Only `fs.*` and `fs.promises.*` are redirected. Callback-style calls
  (`fs.readFile(path, cb)`) and native addons (pi-fff's LMDB directories, opened
  by a Rust binding) bypass the shim.
- Project overrides become active from pi-unify's own `session_start` handler
  onward. If another extension reads config earlier in startup, `/unify` reports
  `project override for <plugin> present at ... but not applied` — that is the
  load-order problem, and the fix is putting pi-unify first in `packages`.
- The startup self-check can only observe reads that happen after pi-unify
  loaded, so it catches "some plugin loaded before me", not "every plugin did".

## Out of scope (first version)

- Unifying plugins' environment-variable configuration.
- Forking or modifying any third-party plugin.
- Full schema validation: writes are shallow-checked (top-level keys exist, same
  value type), not validated against a declarative schema.
- Code (TypeScript) adapters — JSON descriptors only.
- Hot reload of config or adapters: restart or `/reload`.
