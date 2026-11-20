import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eject } from "../src/eject.ts";
import { migrate } from "../src/migrate.ts";
import { backupDir, dataRoot, settingsDir } from "../src/paths.ts";
import { readState, writeState } from "../src/state.ts";
import type { Adapter } from "../src/adapters.ts";
import type { CommandOptions } from "../src/types.ts";

interface Sandbox {
  ad: string;
  cwd: string;
  adapter: Adapter;
  oldConfig: string;
  newConfig: string;
  oldData: string;
  newData: string;
}

function sandbox(t: { after: (fn: () => void) => void }): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "pi-unify-eject-"));
  const ad = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(ad, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const adapter: Adapter = {
    name: "pi-demo",
    config: { path: join(ad, "demo.json"), projectOverride: "demo.json" },
    data: [join(ad, "demo-cache")],
  };
  return {
    ad,
    cwd,
    adapter,
    oldConfig: join(ad, "demo.json"),
    newConfig: join(settingsDir(ad), "pi-demo.json"),
    oldData: join(ad, "demo-cache"),
    newData: join(dataRoot(ad), "pi-demo"),
  };
}

const fixedNow = () => new Date("2026-02-03T04:05:06.000Z");

function opts(sb: Sandbox, extra: Partial<{ projectTrusted: boolean; now: () => Date }> = {}) {
  return {
    agentDir: sb.ad,
    adapters: [sb.adapter],
    cwd: sb.cwd,
    projectTrusted: extra.projectTrusted ?? false,
    now: extra.now ?? fixedNow,
  };
}

// Real adoption: config + data present at the old paths, then /unify:migrate.
function adopted(sb: Sandbox, config: string = '{"a":1}', data: Record<string, string> = { "cache.txt": "x" }): void {
  writeFileSync(sb.oldConfig, config);
  for (const [rel, content] of Object.entries(data)) {
    const file = join(sb.oldData, rel);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, content);
  }
  const result = migrate("pi-demo", { agentDir: sb.ad, adapters: [sb.adapter], now: fixedNow });
  assert.equal(result.ok, true, result.message);
}

function list(dir: string): string[] {
  return fs.existsSync(dir) ? readdirSync(dir).sort() : [];
}

test("unknown plugin name reports an error and changes nothing", (t) => {
  const sb = sandbox(t);
  adopted(sb);
  const result = eject("nope", opts(sb));
  assert.equal(result.ok, false);
  assert.match(result.message, /unknown adapter "nope"/);
  assert.deepEqual(result.restored, []);
  assert.deepEqual(result.backedUp, []);
  assert.equal(fs.existsSync(sb.newConfig), true);
  assert.equal(readState(sb.ad).migrations["pi-demo"] !== undefined, true);
});

test("empty name reports usage and changes nothing", (t) => {
  const sb = sandbox(t);
  adopted(sb);
  const result = eject("   ", opts(sb));
  assert.equal(result.ok, false);
  assert.match(result.message, /usage/i);
  assert.equal(fs.existsSync(sb.newConfig), true);
});

test("a plugin that was never migrated reports nothing to do and creates no backup", (t) => {
  const sb = sandbox(t);
  writeFileSync(sb.oldConfig, '{"a":1}');
  const result = eject("pi-demo", opts(sb));
  assert.equal(result.ok, true);
  assert.match(result.message, /nothing to eject/);
  assert.deepEqual(result.restored, []);
  assert.deepEqual(result.backedUp, []);
  assert.equal(fs.existsSync(backupDir(sb.ad)), false);
  assert.equal(fs.readFileSync(sb.oldConfig, "utf8"), '{"a":1}');
});

test("config is written back to the plugin's old path as merged JSON", (t) => {
  const sb = sandbox(t);
  const projectFile = join(sb.cwd, ".pi/unify/demo.json");
  mkdirSync(join(sb.cwd, ".pi/unify"), { recursive: true });
  writeFileSync(projectFile, '{"b":2}');
  adopted(sb, '{"a":1}');

  const result = eject("pi-demo", opts(sb, { projectTrusted: true }));
  assert.equal(result.ok, true, result.message);

  assert.deepEqual(JSON.parse(fs.readFileSync(sb.oldConfig, "utf8")), { a: 1, b: 2 });
  assert.deepEqual(result.restored, [sb.oldConfig, sb.oldData]);
  // The override file is the user's; eject never writes or removes it.
  assert.equal(fs.readFileSync(projectFile, "utf8"), '{"b":2}');
});

test("an untrusted project override is not baked into the restored old file", (t) => {
  const sb = sandbox(t);
  mkdirSync(join(sb.cwd, ".pi/unify"), { recursive: true });
  writeFileSync(join(sb.cwd, ".pi/unify/demo.json"), '{"b":2}');
  adopted(sb, '{"a":1}');

  assert.equal(eject("pi-demo", opts(sb, { projectTrusted: false })).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(sb.oldConfig, "utf8")), { a: 1 });
});

test("data moves back to the old dir preserving layout and the unified dir is removed", (t) => {
  const sb = sandbox(t);
  adopted(sb, '{"a":1}', { "top.txt": "top", "deep/nested/leaf.txt": "leaf" });

  const result = eject("pi-demo", opts(sb));
  assert.equal(result.ok, true, result.message);

  assert.equal(fs.readFileSync(join(sb.oldData, "top.txt"), "utf8"), "top");
  assert.equal(fs.readFileSync(join(sb.oldData, "deep/nested/leaf.txt"), "utf8"), "leaf");
  assert.equal(fs.existsSync(sb.newData), false);
});

test("eject clears the unified config file and the migration entry", (t) => {
  const sb = sandbox(t);
  adopted(sb);

  assert.equal(eject("pi-demo", opts(sb)).ok, true);
  assert.equal(fs.existsSync(sb.newConfig), false);
  assert.deepEqual(readState(sb.ad).migrations, {});
});

test("a pre-eject backup of the unified files is left behind", (t) => {
  const sb = sandbox(t);
  adopted(sb);
  // Edit the unified file after migration so the backup content is distinguishable.
  writeFileSync(sb.newConfig, '{"a":9}');

  const result = eject("pi-demo", opts(sb));
  assert.equal(result.ok, true, result.message);

  const stamp = join(backupDir(sb.ad), "pi-demo", "2026-02-03T04-05-06-000Z-eject");
  assert.deepEqual(result.backedUp, [join(stamp, "config/demo.json"), join(stamp, "data/demo-cache")]);
  assert.equal(fs.readFileSync(join(stamp, "config/demo.json"), "utf8"), '{"a":9}');
  assert.equal(fs.readFileSync(join(stamp, "data/demo-cache/cache.txt"), "utf8"), "x");
  // The migrate-time backup is kept for safety.
  assert.deepEqual(list(join(backupDir(sb.ad), "pi-demo")), [
    "2026-02-03T04-05-06-000Z",
    "2026-02-03T04-05-06-000Z-eject",
  ]);
});

test("a second eject is a no-op and reports it", (t) => {
  const sb = sandbox(t);
  adopted(sb);
  assert.equal(eject("pi-demo", opts(sb)).ok, true);
  const backups = list(join(backupDir(sb.ad), "pi-demo"));

  const again = eject("pi-demo", opts(sb));
  assert.equal(again.ok, true);
  assert.match(again.message, /nothing to eject/);
  assert.deepEqual(again.restored, []);
  assert.deepEqual(list(join(backupDir(sb.ad), "pi-demo")), backups);
  assert.deepEqual(JSON.parse(fs.readFileSync(sb.oldConfig, "utf8")), { a: 1 });
});

test("eject then migrate again works, so the plugin can be re-adopted", (t) => {
  const sb = sandbox(t);
  adopted(sb);
  assert.equal(eject("pi-demo", opts(sb)).ok, true);

  const result = migrate("pi-demo", { agentDir: sb.ad, adapters: [sb.adapter], now: fixedNow });
  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /migrated pi-demo/);
  assert.notEqual(readState(sb.ad).migrations["pi-demo"], undefined);
});

test("a state record whose files are already gone clears the entry without throwing", (t) => {
  const sb = sandbox(t);
  writeState(sb.ad, {
    migrations: {
      "pi-demo": {
        migratedAt: "2026-02-03T04:05:06.000Z",
        config: { from: sb.oldConfig, to: sb.newConfig },
        data: [{ from: sb.oldData, to: sb.newData }],
      },
    },
  });

  const result = eject("pi-demo", opts(sb));
  assert.equal(result.ok, true);
  assert.match(result.message, /nothing to eject/);
  assert.deepEqual(result.backedUp, []);
  assert.deepEqual(readState(sb.ad).migrations, {});
});

test("/unify:eject command is registered and reports its result without throwing", async (t) => {
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-unify-eject-cmd-"));
  t.after(() => {
    rmSync(process.env.PI_CODING_AGENT_DIR as string, { recursive: true, force: true });
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = before;
  });

  const { default: piUnify } = await import("../src/index.ts");
  const commands = new Map<string, CommandOptions>();
  piUnify({ on: () => {}, registerCommand: (name, options) => commands.set(name, options) });
  const command = commands.get("unify:eject");
  assert.ok(command, "/unify:eject command registered");

  const seen: [string, string | undefined][] = [];
  const ctx = {
    cwd: "/tmp",
    isProjectTrusted: () => false,
    ui: { notify: (msg: string, type?: "info" | "warning" | "error") => seen.push([msg, type]) },
  };
  await command.handler("  ", ctx);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][1], "error");
  assert.match(seen[0][0], /usage/i);
});
