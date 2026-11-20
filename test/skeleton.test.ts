import test from "node:test";
import assert from "node:assert/strict";
import piUnify from "../src/index.ts";
import type { CommandOptions } from "../src/types.ts";

test("extension loads and registers a callable liveness command", async () => {
  const commands = new Map<string, CommandOptions>();
  piUnify({
    on: () => {},
    registerCommand: (name, options) => commands.set(name, options),
  });

  const command = commands.get("unify");
  assert.ok(command, "/unify command registered");

  const seen: string[] = [];
  await command.handler("", {
    cwd: "/tmp",
    isProjectTrusted: () => false,
    ui: { notify: (msg) => seen.push(msg) },
  });
  assert.equal(seen.length, 1, "one multi-line notify");
  assert.match(seen[0] as string, /^pi-unify: \d+ adapter\(s\) loaded, \d+ migrated$/m);
  assert.match(seen[0] as string, /^interception: 13 fs function\(s\) patched/m);
  assert.match(seen[0] as string, /^self-check: /m);
});

// The command seam: no argument must mean "all", not "usage error". Point the
// extension at a temp agent dir so the real one is never touched.
test("/unify:migrate with no argument migrates every adapter", async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "pi-unify-cmd-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Isolate HOME too: shipped descriptors use literal ~ paths (pi-memory, pi-lens),
  // so a "migrate all" must not be able to reach the real agent dir.
  const previousHome = process.env.HOME;
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  process.env.HOME = root;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
  mkdirSync(join(root, "extensions/unify"), { recursive: true });
  writeFileSync(join(root, "extensions/unify/demo.adapter.json"), JSON.stringify({ name: "demo", config: { path: join(root, "demo.json") } }));
  writeFileSync(join(root, "demo.json"), JSON.stringify({ level: "x" }));

  const commands = new Map<string, CommandOptions>();
  piUnify({ on: () => {}, registerCommand: (name, options) => commands.set(name, options) });
  const seen: string[] = [];
  await commands.get("unify:migrate")!.handler("", {
    cwd: root,
    isProjectTrusted: () => false,
    ui: { notify: (msg) => seen.push(msg) },
  });

  assert.match(seen[0] as string, /migrate all/);
  assert.match(seen[0] as string, /demo: migrated/);
  assert.equal(existsSync(join(root, "demo.json")), false);
  assert.equal(existsSync(join(root, "extensions/settings/demo.json")), true);
});
