import fsDefault from "node:fs";
import { join } from "node:path";
import type { Adapter } from "./adapters.ts";
import { configLayers, readConfig } from "./config.ts";
import { dataTargets } from "./data-dir.ts";
import { expandPath } from "./paths.ts";
import { selfCheck } from "./probe.ts";
import { readState } from "./state.ts";

// Pinned at module load: the fs intercept may already be installed when the
// view runs, and a whitelisted old data dir would answer "exists" from the
// unified side instead of the real disk.
const rawExistsSync: typeof fsDefault.existsSync = fsDefault.existsSync;
const rawReadFileSync: typeof fsDefault.readFileSync = fsDefault.readFileSync;

export interface DiagnoseInput {
  agentDir: string;
  cwd: string;
  projectTrusted: boolean;
  adapters: Adapter[];
  warnings: string[];
  health: { patched: string[]; problems: string[] };
}

// One line per fact, in a fixed section order, so the command handler only has
// to join them and the content stays assertable without a fake UI.
export function diagnose(input: DiagnoseInput): string[] {
  const lines: string[] = [];
  const state = readState(input.agentDir);
  const migrated = input.adapters.filter((adapter) => state.migrations[adapter.name] !== undefined);
  lines.push(`pi-unify: ${input.adapters.length} adapter(s) loaded, ${migrated.length} migrated`);

  for (const adapter of input.adapters) {
    const record = state.migrations[adapter.name];
    lines.push(`- ${adapter.name} ${record ? `[migrated ${record.migratedAt}]` : "[not migrated]"}`);
    lines.push(...configLines(input, adapter));
  }

  lines.push(...interceptLines(input.health));
  lines.push(...selfCheckLines());
  lines.push(...dataLines(input));

  for (const warning of input.warnings) lines.push(`warning: ${warning}`);
  return lines;
}

function configLines(input: DiagnoseInput, adapter: Adapter): string[] {
  if (!adapter.config) return ["    config: none declared"];
  const layers = configLayers({ agentDir: input.agentDir, cwd: input.cwd, projectTrusted: input.projectTrusted }, adapter);
  if (!layers) return ["    config: none declared"];
  const oldPath = expandPath(adapter.config.path, input.agentDir);

  // Built trust-blind so an untrusted-but-present override can be reported as
  // ignored instead of silently disappearing from the view.
  const ignoredPath = !input.projectTrusted && adapter.config.projectOverride
    ? join(input.cwd, ".pi/unify", adapter.config.projectOverride)
    : undefined;
  const ignored = ignoredPath && rawExistsSync(ignoredPath)
    ? ` (project override ignored, project not trusted: ${ignoredPath})`
    : "";

  const view = readConfig(layers);
  if (view) {
    const project = input.projectTrusted && layers.project ? `, project ${layers.project}` : "";
    const lines = [`    config layers: global ${layers.global}${project}${ignored}`];
    for (const key of Object.keys(view.merged).sort()) {
      lines.push(`      ${key} = ${JSON.stringify(view.merged[key])} (source: ${view.sources[key]})`);
    }
    return lines;
  }

  const old = readObject(oldPath);
  if (!old) return [`    config layers: no unified layer yet, no old file at ${oldPath}${ignored}`];
  const lines = [`    config layers: no unified layer yet, old path still serves this plugin: ${oldPath}${ignored}`];
  for (const key of Object.keys(old).sort()) {
    lines.push(`      ${key} = ${JSON.stringify(old[key])} (source: old file — not migrated yet)`);
  }
  return lines;
}

function interceptLines(health: DiagnoseInput["health"]): string[] {
  const patched = health.patched.length ? `: ${health.patched.join(", ")}` : "";
  const lines = [`interception: ${health.patched.length} fs function(s) patched${patched}`];
  for (const problem of health.problems) lines.push(`  problem: ${problem}`);
  return lines;
}

function selfCheckLines(): string[] {
  const check = selfCheck();
  if (check.ok) return ["self-check: ok, no adopted config file was read before interception"];
  const lines = [
    `self-check: WARNING ${check.hits.length} adopted config file(s) read before interception` +
      " — pi-unify must be first in `packages`:",
  ];
  for (const hit of check.hits) lines.push(`  - ${hit}`);
  return lines;
}

function dataLines(input: DiagnoseInput): string[] {
  const targets = dataTargets(input.agentDir, input.adapters);
  const lines = [`data dirs: ${targets.length}`];
  for (const target of targets) {
    const unified = rawExistsSync(target.unified);
    const old = rawExistsSync(target.old);
    const status = unified
      ? old
        ? `ok, old dir still present: ${target.old}`
        : "ok, old dir gone"
      : old
        ? `not yet redirected, old dir present: ${target.old}`
        : "neither the unified nor the old dir exists yet";
    lines.push(`  ${target.plugin}: ${target.unified} - ${status}`);
  }
  return lines;
}

function readObject(path: string): Record<string, unknown> | undefined {
  if (!rawExistsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(rawReadFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
