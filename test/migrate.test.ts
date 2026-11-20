import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/migrate.ts";
import { configLayers, readConfig } from "../src/config.ts";
import { backupDir, settingsDir, dataRoot } from "../src/paths.ts";
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
  const root = mkdtempSync(join(tmpdir(), "pi-unify-migrate-"));
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

function opts(sb: Sandbox, now?: () => Date) {
  return now === undefined
    ? { agentDir: sb.ad, adapters: [sb.adapter] }
    : { agentDir: sb.ad, adapters: [sb.adapter], now };
}

const fixedNow = () => new Date("2026-02-03T04:05:06.000Z");

function list(dir: string): string[] {
  return fs.existsSync(dir) ? readdirSync(dir).sort() : [];
}

test("unknown plugin name reports an error and moves nothing", (t) => {
  const sb = sandbox(t);
  writeFileSync(sb.oldConfig, '{"a":1}');
  const result = migrate("nope", opts(sb));
  assert.equal(result.ok, false);
  assert.match(result.message, /unknown adapter "nope"/);
  assert.equal(fs.readFileSync(sb.oldConfig, "utf8"), '{"a":1}');
  assert.equal(fs.existsSync(backupDir(sb.ad)), false);
});

test("empty name reports usage and moves nothing", (t) => {
  const sb = sandbox(t);
  writeFileSync(sb.oldConfig, '{"a":1}');
  const result = migrate("   ", opts(sb));
  assert.equal(result.ok, false);
  assert.match(result.message, /usage/i);
  assert.equal(fs.readFileSync(sb.oldConfig, "utf8"), '{"a":1}');
});

test("config move backs up the old file first, then leaves no trace at the old path", (t) => {
  const sb = sandbox(t);
  writeFileSync(sb.oldConfig, '{"a":1}');
  const result = migrate("pi-demo", opts(sb, fixedNow));
  assert.equal(result.ok, true, result.message);

  const stamp = join(backupDir(sb.ad), "pi-demo", "2026-02-03T04-05-06-000Z");
  assert.deepEqual(result.backedUp, [join(stamp, "config/demo.json")]);
  assert.equal(fs.readFileSync(join(stamp, "config/demo.json"), "utf8"), '{"a":1}');

  assert.equal(fs.existsSync(sb.oldConfig), false);
  assert.equal(fs.readFileSync(sb.newConfig, "utf8"), '{"a":1}');
  assert.deepEqual(result.moved, [sb.newConfig]);
});

test("data dir contents move under the unified data dir preserving layout", (t) => {
  const sb = sandbox(t);
  mkdirSync(join(sb.oldData, "deep/nested"), { recursive: true });
  writeFileSync(join(sb.oldData, "top.txt"), "top");
  writeFileSync(join(sb.oldData, "deep/nested/leaf.txt"), "leaf");

  const result = migrate("pi-demo", opts(sb, fixedNow));
  assert.equal(result.ok, true, result.message);

  assert.equal(fs.readFileSync(join(sb.newData, "top.txt"), "utf8"), "top");
  assert.equal(fs.readFileSync(join(sb.newData, "deep/nested/leaf.txt"), "utf8"), "leaf");
  assert.equal(fs.existsSync(sb.oldData), false);

  const stamp = join(backupDir(sb.ad), "pi-demo", "2026-02-03T04-05-06-000Z");
  assert.equal(fs.readFileSync(join(stamp, "data/demo-cache/deep/nested/leaf.txt"), "utf8"), "leaf");
});

test("config and data merge into an existing unified data dir", (t) => {
  const sb = sandbox(t);
  mkdirSync(join(sb.oldData, "shared"), { recursive: true });
  mkdirSync(join(sb.newData, "shared"), { recursive: true });
  writeFileSync(join(sb.oldData, "shared/old.txt"), "old");
  writeFileSync(join(sb.newData, "shared/new.txt"), "new");

  const result = migrate("pi-demo", opts(sb, fixedNow));
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(list(join(sb.newData, "shared")), ["new.txt", "old.txt"]);
  assert.equal(fs.existsSync(sb.oldData), false);
});

test("migration state records config and data moves for eject", (t) => {
  const sb = sandbox(t);
  writeFileSync(sb.oldConfig, '{"a":1}');
  mkdirSync(sb.oldData, { recursive: true });
  writeFileSync(join(sb.oldData, "cache.txt"), "x");

  assert.equal(migrate("pi-demo", opts(sb, fixedNow)).ok, true);

  const record = readState(sb.ad).migrations["pi-demo"];
  assert.equal(record.migratedAt, "2026-02-03T04:05:06.000Z");
  assert.deepEqual(record.config, { from: sb.oldConfig, to: sb.newConfig });
  assert.deepEqual(record.data, [{ from: sb.oldData, to: sb.newData }]);
});

test("a second run is a no-op", (t) => {
  const sb = sandbox(t);
  writeFileSync(sb.oldConfig, '{"a":1}');
  mkdirSync(sb.oldData, { recursive: true });
  writeFileSync(join(sb.oldData, "cache.txt"), "x");
  assert.equal(migrate("pi-demo", opts(sb, fixedNow)).ok, true);

  const backupsBefore = list(join(backupDir(sb.ad), "pi-demo"));
  const mtimeBefore = statSync(sb.newConfig).mtimeMs;

  const again = migrate("pi-demo", opts(sb, fixedNow));
  assert.equal(again.ok, true);
  assert.match(again.message, /already migrated/);
  assert.deepEqual(again.moved, []);
  assert.deepEqual(again.backedUp, []);
  assert.deepEqual(list(join(backupDir(sb.ad), "pi-demo")), backupsBefore);
  assert.equal(statSync(sb.newConfig).mtimeMs, mtimeBefore);
  assert.equal(fs.readFileSync(sb.newConfig, "utf8"), '{"a":1}');
});

test("fresh install with no old files records nothing", (t) => {
  const sb = sandbox(t);
  const result = migrate("pi-demo", opts(sb, fixedNow));
  assert.equal(result.ok, true);
  assert.match(result.message, /no old files to migrate/);
  assert.deepEqual(result.backedUp, []);
  assert.deepEqual(result.moved, []);
  assert.deepEqual(readState(sb.ad).migrations, {});
  assert.equal(fs.existsSync(backupDir(sb.ad)), false);
});

test("project override files are never touched and still merge after migration", (t) => {
  const sb = sandbox(t);
  const projectFile = join(sb.cwd, ".pi/unify/demo.json");
  mkdirSync(join(sb.cwd, ".pi/unify"), { recursive: true });
  writeFileSync(projectFile, '{"b":2}');
  writeFileSync(sb.oldConfig, '{"a":1}');

  assert.equal(migrate("pi-demo", opts(sb, fixedNow)).ok, true);

  assert.equal(fs.readFileSync(projectFile, "utf8"), '{"b":2}');
  const layers = configLayers({ agentDir: sb.ad, cwd: sb.cwd, projectTrusted: true }, sb.adapter);
  assert.ok(layers);
  assert.deepEqual(readConfig(layers)?.merged, { a: 1, b: 2 });
});

test("two migrations in the same second get separate backup dirs", (t) => {
  const sb = sandbox(t);
  writeFileSync(sb.oldConfig, '{"first":1}');
  assert.equal(migrate("pi-demo", opts(sb, fixedNow)).ok, true);

  // Undo by hand the way eject would, then migrate again within the same second.
  writeState(sb.ad, { migrations: {} });
  writeFileSync(sb.oldConfig, '{"second":2}');
  assert.equal(migrate("pi-demo", opts(sb, fixedNow)).ok, true);

  assert.deepEqual(list(join(backupDir(sb.ad), "pi-demo")), [
    "2026-02-03T04-05-06-000Z",
    "2026-02-03T04-05-06-000Z-2",
  ]);
  const second = join(backupDir(sb.ad), "pi-demo", "2026-02-03T04-05-06-000Z-2", "config/demo.json");
  assert.equal(fs.readFileSync(second, "utf8"), '{"second":2}');
});

test("a failing move returns ok:false instead of throwing", (t) => {
  const sb = sandbox(t);
  writeFileSync(sb.oldConfig, '{"a":1}');
  // A regular file where the settings dir must go makes the move impossible.
  mkdirSync(join(sb.ad, "extensions"), { recursive: true });
  writeFileSync(settingsDir(sb.ad), "not a directory");

  const result = migrate("pi-demo", opts(sb, fixedNow));
  assert.equal(result.ok, false);
  assert.match(result.message, /pi-demo/);
  assert.equal(fs.existsSync(sb.oldConfig), true);
  assert.deepEqual(readState(sb.ad).migrations, {});
});

test("/unify:migrate command is registered and reports its result without throwing", async (t) => {
  // Isolate HOME as well: shipped descriptors use literal ~ paths (pi-memory,
  // pi-lens), so without this a "migrate all" would reach the real agent dir.
  const beforeHome = process.env.HOME;
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-unify-migrate-cmd-"));
  process.env.HOME = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    rmSync(process.env.PI_CODING_AGENT_DIR as string, { recursive: true, force: true });
    if (before === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = before;
    if (beforeHome === undefined) delete process.env.HOME;
    else process.env.HOME = beforeHome;
  });

  const { default: piUnify } = await import("../src/index.ts");
  const commands = new Map<string, CommandOptions>();
  piUnify({ on: () => {}, registerCommand: (name, options) => commands.set(name, options) });
  const command = commands.get("unify:migrate");
  assert.ok(command, "/unify:migrate command registered");

  const seen: [string, string | undefined][] = [];
  const ctx = {
    cwd: "/tmp",
    isProjectTrusted: () => false,
    ui: { notify: (msg: string, type?: "info" | "warning" | "error") => seen.push([msg, type]) },
  };
  // No plugin name (whitespace only) means "all adapters", not a usage error.
  await command.handler("  ", ctx);
  assert.equal(seen.length, 1);
  assert.equal(seen[0][1], "info");
  assert.match(seen[0][0], /migrate all — \d+ migrated, \d+ already migrated, 0 failed/);
});

// Regression: migration runs inside the same process as the intercept, so its own
// fs calls were being redirected to the unified paths and the move corrupted itself.
test("migration works while the intercept is installed", async (t) => {
  const sb = sandbox(t);
  writeFileSync(sb.oldConfig, JSON.stringify({ keep: 1 }));
  mkdirSync(sb.oldData, { recursive: true });
  writeFileSync(join(sb.oldData, "cache.bin"), "data");

  const { installIntercept } = await import("../src/fs-intercept.ts");
  const intercept = installIntercept({
    agentDir: sb.ad,
    adapters: [sb.adapter],
    cwd: sb.cwd,
    projectTrusted: false,
  });
  t.after(() => intercept.uninstall());

  const result = migrate("pi-demo", { agentDir: sb.ad, adapters: [sb.adapter] });
  assert.equal(result.ok, true, result.message);
  // lstatSync is not intercepted, so it shows the real disk rather than the
  // redirected view the old paths now resolve to.
  assert.throws(() => fs.lstatSync(sb.oldConfig), /ENOENT/);
  assert.throws(() => fs.lstatSync(sb.oldData), /ENOENT/);
  assert.equal(fs.readFileSync(sb.newConfig, "utf8"), JSON.stringify({ keep: 1 }));
  assert.equal(fs.readFileSync(join(sb.newData, "cache.bin"), "utf8"), "data");
  assert.ok(readState(sb.ad).migrations["pi-demo"]);
});

// Regression: renaming the old file over an existing unified file used to erase
// keys the unified file already had, and the erased copy was not backed up.
test("migrating over an existing unified config keeps its keys and backs it up", (t) => {
  const sb = sandbox(t);
  mkdirSync(settingsDir(sb.ad), { recursive: true });
  writeFileSync(sb.newConfig, JSON.stringify({ unifiedOnly: true, shared: "unified" }));
  writeFileSync(sb.oldConfig, JSON.stringify({ fromOld: 1, shared: "old" }));

  const result = migrate("pi-demo", opts(sb, fixedNow));
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(JSON.parse(fs.readFileSync(sb.newConfig, "utf8")), {
    unifiedOnly: true,
    fromOld: 1,
    shared: "old",
  });

  const backedUp = result.backedUp.map((p) => [p, fs.readFileSync(p, "utf8")] as const);
  assert.ok(
    backedUp.some(([, content]) => content.includes("unifiedOnly")),
    `existing unified config not backed up: ${result.backedUp.join(", ")}`,
  );
});

// Regression: mergeDir deleted a newer destination file without keeping a copy.
test("migrating over an existing unified data file backs the destination up", (t) => {
  const sb = sandbox(t);
  mkdirSync(sb.oldData, { recursive: true });
  writeFileSync(join(sb.oldData, "cache.txt"), "old");
  mkdirSync(sb.newData, { recursive: true });
  writeFileSync(join(sb.newData, "cache.txt"), "unified-newer");

  const result = migrate("pi-demo", opts(sb, fixedNow));
  assert.equal(result.ok, true, result.message);
  assert.equal(fs.readFileSync(join(sb.newData, "cache.txt"), "utf8"), "old");

  const backedUp = result.backedUp
    .filter((p) => statSync(p).isFile())
    .map((p) => [p, fs.readFileSync(p, "utf8")] as const);
  assert.ok(
    backedUp.some(([, content]) => content === "unified-newer"),
    `existing unified data file not backed up: ${result.backedUp.join(", ")}`,
  );
});

// Regression: a move that failed halfway left no state, so a retry said
// "nothing to migrate" and eject had nothing to reverse.
test("a failed data move after a config move leaves a reversible record", (t) => {
  const sb = sandbox(t);
  writeFileSync(sb.oldConfig, '{"a":1}');
  mkdirSync(sb.oldData, { recursive: true });
  writeFileSync(join(sb.oldData, "cache.txt"), "x");
  // A regular file where the unified data dir must go makes the data move fail.
  mkdirSync(join(sb.newData, ".."), { recursive: true });
  writeFileSync(sb.newData, "not a directory");

  const result = migrate("pi-demo", opts(sb, fixedNow));
  assert.equal(result.ok, false);
  const record = readState(sb.ad).migrations["pi-demo"];
  assert.ok(record, "migration record must exist so eject can reverse the partial move");
  assert.deepEqual(record.config, { from: sb.oldConfig, to: sb.newConfig });
  assert.deepEqual(record.data, [{ from: sb.oldData, to: sb.newData }]);
});

test("migrate all adopts every adapter in one call", async (t) => {
  const sb = sandbox(t);
  writeFileSync(sb.oldConfig, JSON.stringify({ keep: 1 }));
  mkdirSync(sb.oldData, { recursive: true });
  writeFileSync(join(sb.oldData, "cache.bin"), "data");
  const second = { name: "pi-other", data: [] } as Adapter;
  const secondOld = join(sb.ad, "other.json");
  writeFileSync(secondOld, JSON.stringify({ x: 1 }));
  second.config = { path: secondOld };

  const { migrateAll } = await import("../src/migrate.ts");
  const result = migrateAll({ agentDir: sb.ad, adapters: [sb.adapter, second] });

  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /2 migrated/);
  const state = readState(sb.ad);
  assert.deepEqual(Object.keys(state.migrations).sort(), ["pi-demo", "pi-other"]);
  assert.throws(() => fs.lstatSync(sb.oldConfig), /ENOENT/);
  assert.throws(() => fs.lstatSync(secondOld), /ENOENT/);
});

test("migrate all is a no-op for plugins already adopted", async (t) => {
  const sb = sandbox(t);
  writeFileSync(sb.oldConfig, JSON.stringify({ keep: 1 }));
  const { migrate, migrateAll } = await import("../src/migrate.ts");

  assert.equal(migrate("pi-demo", { agentDir: sb.ad, adapters: [sb.adapter] }).ok, true);
  const result = migrateAll({ agentDir: sb.ad, adapters: [sb.adapter] });

  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /1 already migrated/);
  assert.equal(fs.readFileSync(sb.newConfig, "utf8"), JSON.stringify({ keep: 1 }));
});
