import { existsSync as rawExistsSync, mkdirSync, readFileSync as rawReadFileSync, writeFileSync as rawWriteFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Adapter } from "./adapters.ts";
import { settingsDir } from "./paths.ts";

export type LayerName = "global" | "project";

// Where one plugin's config really lives. `global` is the only write target;
// `project` is a user-maintained read-only override, present only when trusted.
export interface ConfigLayers {
  global: string;
  project?: string;
}

export interface ConfigView {
  merged: Record<string, unknown>;
  /** Winning layer per key, for the /unify diagnostic view. */
  sources: Record<string, LayerName>;
}

export interface LayerContext {
  agentDir: string;
  cwd: string;
  projectTrusted: boolean;
}

export function configLayers(ctx: LayerContext, adapter: Adapter): ConfigLayers | undefined {
  if (!adapter.config) return undefined;
  const layers: ConfigLayers = { global: join(settingsDir(ctx.agentDir), `${adapter.name}.json`) };
  if (ctx.projectTrusted && adapter.config.projectOverride) {
    layers.project = join(ctx.cwd, ".pi/unify", adapter.config.projectOverride);
  }
  return layers;
}

// Shallow (top-level key) merge of the global and project layers. Undefined when
// neither layer exists, which tells the caller to fall through to the old path.
export function readConfig(layers: ConfigLayers): ConfigView | undefined {
  const global = readJsonObject(layers.global);
  const project = layers.project !== undefined ? readJsonObject(layers.project) : undefined;
  if (!global && !project) return undefined;
  const merged: Record<string, unknown> = {};
  const sources: Record<string, LayerName> = {};
  for (const [key, value] of Object.entries(global ?? {})) {
    merged[key] = value;
    sources[key] = "global";
  }
  for (const [key, value] of Object.entries(project ?? {})) {
    merged[key] = value;
    sources[key] = "project";
  }
  return { merged, sources };
}

// Unparseable or non-object content is "no layer" so the caller can fall back
// to the raw file instead of turning a plain-text config into an error.
function readJsonObject(file: string): Record<string, unknown> | undefined {
  if (!rawExistsSync(file)) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(rawReadFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

// Writes always land in the global layer. The project override is a hand-written
// read-only layer, and the write is shape-checked so a plugin cannot silently
// corrupt keys the user already has.
export function writeConfig(layers: ConfigLayers, data: string | Uint8Array, onWarn?: (msg: string) => void): boolean {
  const reject = (why: string): false => {
    onWarn?.(`reject config write to ${layers.global}: ${why}`);
    return false;
  };
  const next = parseJsonObject(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
  if (!next) return reject("not a JSON object");
  // Validate against the merged view: a key that exists only in the project
  // layer is still a key the plugin legitimately read back.
  const existing = readConfig(layers)?.merged;
  if (existing) {
    for (const [key, value] of Object.entries(next)) {
      if (!(key in existing)) return reject(`unknown key "${key}"`);
      if (typeOf(existing[key]) !== typeOf(value)) {
        return reject(`key "${key}" expects ${typeOf(existing[key])}, got ${typeOf(value)}`);
      }
    }
  }
  // Merge over the global file so a partial write cannot drop untouched keys.
  // An explicit {} over a populated file is treated as a bad write, not a wipe.
  const global = readJsonObject(layers.global) ?? {};
  if (Object.keys(next).length === 0 && Object.keys(global).length > 0) {
    return reject("refusing to write an empty object over a populated config");
  }
  mkdirSync(dirname(layers.global), { recursive: true });
  rawWriteFileSync(layers.global, JSON.stringify({ ...global, ...next }));
  return true;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  return raw as Record<string, unknown>;
}

// Shallow type tag: no recursion into nested values by design (first version).
function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
