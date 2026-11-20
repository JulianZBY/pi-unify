import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { unifyAdapterDir } from "./paths.ts";

export interface Adapter {
  name: string;
  config?: { path: string; projectOverride?: string };
  data: string[];
}

export interface LoadResult {
  adapters: Adapter[];
  warnings: string[];
}

// Search order: agent unify dir first, then shipped descriptor dirs. A name
// already seen wins, so user descriptors override shipped ones.
export function loadAdapters(ad: string, extraDirs: string[] = []): LoadResult {
  const adapters: Adapter[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const dir of [unifyAdapterDir(ad), ...extraDirs]) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    } catch (err) {
      warnings.push(`cannot read adapter dir ${dir}: ${(err as Error).message}`);
      continue;
    }
    for (const file of entries) {
      const full = join(dir, file);
      const adapter = parseDescriptor(full, warnings);
      if (!adapter || seen.has(adapter.name)) continue;
      seen.add(adapter.name);
      adapters.push(adapter);
    }
  }
  return { adapters, warnings };
}

function parseDescriptor(file: string, warnings: string[]): Adapter | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    warnings.push(`skip adapter ${file}: ${(err as Error).message}`);
    return undefined;
  }
  const fail = (why: string): undefined => {
    warnings.push(`skip adapter ${file}: ${why}`);
    return undefined;
  };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return fail("not a JSON object");
  const obj = raw as Record<string, unknown>;
  if (typeof obj.name !== "string" || obj.name.trim() === "") return fail("missing name");

  const adapter: Adapter = { name: obj.name, data: [] };

  if (obj.config !== undefined) {
    const config = obj.config;
    if (typeof config !== "object" || config === null || Array.isArray(config)) return fail("config must be an object");
    const c = config as Record<string, unknown>;
    if (typeof c.path !== "string" || c.path === "") return fail("config.path must be a non-empty string");
    if (c.projectOverride !== undefined && typeof c.projectOverride !== "string") {
      return fail("config.projectOverride must be a string");
    }
    adapter.config = { path: c.path };
    if (typeof c.projectOverride === "string") adapter.config.projectOverride = c.projectOverride;
  }

  if (obj.data !== undefined) {
    if (!Array.isArray(obj.data) || obj.data.some((d) => typeof d !== "string" || d === "")) {
      return fail("data must be an array of non-empty strings");
    }
    adapter.data = obj.data as string[];
  }

  return adapter;
}
