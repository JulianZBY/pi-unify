import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piUnify from "../src/index.ts";
import { clearProbe, selfCheck, uninstallProbe } from "../src/probe.ts";
import type { CommandOptions, ExtensionAPI, ExtensionContext } from "../src/types.ts";

function fakePi() {
  const commands = new Map<string, CommandOptions>();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void> | void>();
  const api: ExtensionAPI = {
    on: (event, handler) => handlers.set(event, handler),
    registerCommand: (name, options) => commands.set(name, options),
  };
  return { api, commands, handlers };
}

function sandbox(t: { after: (fn: () => void) => void }, withAdapter: boolean) {
  const root = mkdtempSync(join(tmpdir(), "pi-unify-selfcheck-"));
  const ad = join(root, "agent");
  const cwd = join(root, "project");
  const oldConfig = join(ad, "demo.json");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(ad, "extensions/unify"), { recursive: true });
  writeFileSync(oldConfig, '{"a":1}');
  if (withAdapter) {
    writeFileSync(
      join(ad, "extensions/unify/pi-demo.json"),
      JSON.stringify({ name: "pi-demo", config: { path: oldConfig } }),
    );
  }
  t.after(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    rmSync(root, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = ad;
  return { ad, cwd, oldConfig };
}

function ctx(cwd: string, seen: Array<{ message: string; type?: string }>, hasUI = true): ExtensionContext {
  return {
    cwd,
    hasUI,
    isProjectTrusted: () => false,
    ui: { notify: (message, type) => seen.push({ message, type }) },
  };
}

test("session_start warns when an adopted config was read before interception", async (t) => {
  const sb = sandbox(t, true);
  clearProbe();
  // Probe is installed by src/index.ts at module evaluation; this read stands
  // in for a plugin that loaded before pi-unify did.
  readFileSync(sb.oldConfig, "utf8");

  const { api, handlers } = fakePi();
  piUnify(api);

  const seen: Array<{ message: string; type?: string }> = [];
  const start = handlers.get("session_start");
  assert.ok(start, "session_start handler registered");
  await start({}, ctx(sb.cwd, seen));

  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, "warning");
  assert.match(seen[0].message, /^pi-unify: 1 adopted config file\(s\) were read before interception was installed/);
  assert.match(seen[0].message, /`packages`/);
  assert.match(seen[0].message, /\/reload/);

  assert.deepEqual(selfCheck(), { hits: [sb.oldConfig], ok: false });
});

test("session_start stays silent without pre-interception hits, even with no UI", async (t) => {
  const sb = sandbox(t, false);
  clearProbe();

  const { api, handlers } = fakePi();
  piUnify(api);

  const seen: Array<{ message: string; type?: string }> = [];
  const start = handlers.get("session_start");
  assert.ok(start, "session_start handler registered");
  await start({}, ctx(sb.cwd, seen));

  assert.deepEqual(seen, []);
  assert.deepEqual(selfCheck(), { hits: [], ok: true });
});

// Keeps the probe from leaking into later tests in this file.
test.after(() => uninstallProbe());
