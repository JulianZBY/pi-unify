import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Adapter } from "../src/adapters.ts";
import { diagnose, type DiagnoseInput } from "../src/diagnose.ts";
import { setSelfCheck } from "../src/probe.ts";

interface Sandbox {
  ad: string;
  cwd: string;
  oldConfig: string;
  globalConfig: string;
  projectConfig: string;
  stateFile: string;
}

function sandbox(t: { after: (fn: () => void) => void }): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "pi-unify-diagnose-"));
  const ad = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(ad, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    ad,
    cwd,
    oldConfig: join(ad, "demo.json"),
    globalConfig: join(ad, "extensions/settings/pi-demo.json"),
    projectConfig: join(cwd, ".pi/unify/demo.json"),
    stateFile: join(ad, "extensions/data/unify/state.json"),
  };
}

function adapter(overrides: Partial<Adapter> = {}): Adapter {
  return { name: "pi-demo", config: { path: "<agent>/demo.json", projectOverride: "demo.json" }, data: [], ...overrides };
}

function put(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function run(sb: Sandbox, overrides: Partial<DiagnoseInput> = {}): string[] {
  return diagnose({
    agentDir: sb.ad,
    cwd: sb.cwd,
    projectTrusted: false,
    adapters: [],
    warnings: [],
    health: { patched: ["readFileSync"], problems: [] },
    ...overrides,
  });
}

const text = (lines: string[]): string => lines.join("\n");

function lineWith(lines: string[], needle: string): string {
  const hit = lines.find((line) => line.includes(needle));
  assert.ok(hit, `no line contains "${needle}" in:\n${text(lines)}`);
  return hit;
}

test("lists every loaded adapter and whether it is migrated", (t) => {
  const sb = sandbox(t);
  // The descriptor's old config path is resolved against the real agent dir, so
  // the state file still keys by adapter name only.
  put(sb.stateFile, { migrations: { "pi-demo": { migratedAt: "2026-01-02T03:04:05Z" } } });
  const lines = run(sb, { adapters: [adapter(), adapter({ name: "pi-plain", config: undefined })] });

  assert.match(lineWith(lines, "pi-demo"), /migrated 2026-01-02T03:04:05Z/);
  assert.match(lineWith(lines, "pi-plain"), /not migrated/);
  assert.match(lineWith(lines, "pi-unify:"), /2 adapter\(s\) loaded, 1 migrated/);
});

test("each config value carries the layer it came from", (t) => {
  const sb = sandbox(t);
  put(sb.globalConfig, { model: "global-model", verbose: true });
  put(sb.projectConfig, { model: "project-model" });
  const lines = run(sb, { adapters: [adapter()], projectTrusted: true });

  assert.match(lineWith(lines, "model ="), /"project-model" \(source: project\)/);
  assert.match(lineWith(lines, "verbose ="), /true \(source: global\)/);
});

test("an untrusted project override is reported as ignored, not applied", (t) => {
  const sb = sandbox(t);
  put(sb.globalConfig, { model: "global-model" });
  put(sb.projectConfig, { model: "project-model" });
  const lines = run(sb, { adapters: [adapter()], projectTrusted: false });

  assert.match(lineWith(lines, "model ="), /"global-model" \(source: global\)/);
  assert.match(lineWith(lines, "project override ignored"), /project not trusted/);
});

test("keys served from the old file are labelled default when no layer exists", (t) => {
  const sb = sandbox(t);
  put(sb.oldConfig, { temperature: 0.5 });
  const lines = run(sb, { adapters: [adapter()] });

  assert.match(lineWith(lines, "no unified layer"), /demo\.json/);
  assert.match(lineWith(lines, "temperature ="), /0\.5 \(source: old file — not migrated yet\)/);
});

test("a config-carrying adapter without any file reports built-in defaults instead of throwing", (t) => {
  const sb = sandbox(t);
  const lines = run(sb, { adapters: [adapter()] });

  assert.match(lineWith(lines, "no unified layer"), /no old file/);
});

test("an adapter with no config is listed without config values", (t) => {
  const sb = sandbox(t);
  const lines = run(sb, { adapters: [adapter({ name: "pi-plain", config: undefined })] });

  assert.match(lineWith(lines, "pi-plain"), /not migrated/);
  assert.match(text(lines), /config: none declared/);
});

test("interception health shows the patched functions and every problem", (t) => {
  const sb = sandbox(t);
  const lines = run(sb, {
    adapters: [adapter()],
    health: {
      patched: ["readFileSync", "existsSync", "promises.readFile"],
      problems: ["unified settings dir missing: /tmp/x/extensions/settings"],
    },
  });

  assert.match(lineWith(lines, "interception:"), /3 fs function\(s\) patched.*existsSync/);
  assert.match(lineWith(lines, "problem:"), /unified settings dir missing/);
});

test("the startup self-check warning is shown loudly with each hit", (t) => {
  const sb = sandbox(t);
  t.after(() => setSelfCheck({ hits: [], ok: true }));
  setSelfCheck({ hits: ["/home/u/.pi/agent/demo.json"], ok: false });
  const lines = run(sb, { adapters: [adapter()] });

  assert.match(lineWith(lines, "self-check:"), /WARNING/);
  assert.match(lineWith(lines, "/home/u/.pi/agent/demo.json"), /- \/home/);
});

test("a clean self-check is reported as ok", (t) => {
  const sb = sandbox(t);
  setSelfCheck({ hits: [], ok: true });
  const lines = run(sb, { adapters: [adapter()] });

  assert.match(lineWith(lines, "self-check:"), /ok/);
});

test("data dir health distinguishes redirected, not yet redirected and absent dirs", (t) => {
  const sb = sandbox(t);
  const data = join(sb.ad, "cache");
  const unified = join(sb.ad, "extensions/data/pi-demo");
  const other = join(sb.ad, "other-cache");
  mkdirSync(data, { recursive: true });
  mkdirSync(unified, { recursive: true });
  const lines = run(sb, {
    adapters: [adapter({ data: [data] }), adapter({ name: "pi-plain", config: undefined, data: [other] })],
  });

  assert.match(text(lines), /ok, old dir still present/);
  assert.match(text(lines), /neither the unified nor the old dir/);
});

test("old dir present without a unified dir is flagged as not yet redirected", (t) => {
  const sb = sandbox(t);
  const data = join(sb.ad, "cache");
  mkdirSync(data, { recursive: true });
  const lines = run(sb, { adapters: [adapter({ data: [data] })] });

  assert.match(text(lines), /not yet redirected/);
});

test("loader warnings are listed last", (t) => {
  const sb = sandbox(t);
  const lines = run(sb, { warnings: ["malformed adapter descriptor: bad.json"] });

  assert.match(lineWith(lines, "warning:"), /malformed adapter descriptor/);
});

test("a missing state file and missing settings dir never throw", (t) => {
  const sb = sandbox(t);
  const lines = run(sb, { adapters: [adapter(), adapter({ name: "pi-two", data: [join(sb.ad, "nope")] })] });

  assert.ok(lines.length > 0);
  assert.equal(existsSync(sb.stateFile), false);
  assert.match(text(lines), /0 migrated/);
});
