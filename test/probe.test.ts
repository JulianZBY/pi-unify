import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearProbe,
  earlyReads,
  installProbe,
  selfCheck,
  setSelfCheck,
  uninstallProbe,
} from "../src/probe.ts";
import type { Adapter } from "../src/adapters.ts";
import { readNamed } from "./helpers/named-fs.ts";

function sandbox(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "pi-unify-probe-"));
  const ad = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(ad, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const oldConfig = join(ad, "demo.json");
  const other = join(ad, "other.json");
  writeFileSync(oldConfig, '{"a":1}');
  writeFileSync(other, '{"b":2}');
  const adapter: Adapter = { name: "pi-demo", config: { path: oldConfig }, data: [] };
  return { ad, cwd, oldConfig, other, adapter };
}

test("records a whitelisted path read before interception", (t) => {
  const sb = sandbox(t);
  clearProbe();
  installProbe();
  t.after(() => uninstallProbe());

  assert.equal(readFileSync(sb.oldConfig, "utf8"), '{"a":1}');
  assert.deepEqual(earlyReads([sb.adapter], sb.ad), [sb.oldConfig]);
});

test("ignores paths outside the adapter whitelist", (t) => {
  const sb = sandbox(t);
  clearProbe();
  installProbe();
  t.after(() => uninstallProbe());

  readFileSync(sb.other, "utf8");
  assert.deepEqual(earlyReads([sb.adapter], sb.ad), []);
});

test("records async reads and reads through named ESM imports", async (t) => {
  const sb = sandbox(t);
  clearProbe();
  installProbe();
  t.after(() => uninstallProbe());

  await readFile(sb.oldConfig, "utf8");
  readNamed(sb.oldConfig);
  assert.deepEqual(earlyReads([sb.adapter], sb.ad), [sb.oldConfig]);
});

test("delegates unchanged: extra args and odd path inputs still work", (t) => {
  const sb = sandbox(t);
  clearProbe();
  installProbe();
  t.after(() => uninstallProbe());

  assert.equal(fs.readFileSync(sb.oldConfig, { encoding: "utf8" }), '{"a":1}');
  clearProbe();
  // Buffer and URL paths must pass through untouched and must not be recorded.
  assert.equal(readFileSync(Buffer.from(sb.oldConfig), "utf8"), '{"a":1}');
  assert.equal(readFileSync(new URL(`file://${sb.oldConfig}`), "utf8"), '{"a":1}');
  assert.deepEqual(earlyReads([sb.adapter], sb.ad), []);

  // Missing files must still throw the original error, not a probe error.
  assert.throws(() => readFileSync(join(sb.ad, "nope.json"), "utf8"), /ENOENT/);
});

test("uninstall and clear reset recorded state", (t) => {
  const sb = sandbox(t);
  clearProbe();
  installProbe();
  readFileSync(sb.oldConfig, "utf8");
  uninstallProbe();
  assert.equal(readFileSync(sb.oldConfig, "utf8"), '{"a":1}');

  installProbe();
  t.after(() => uninstallProbe());
  clearProbe();
  assert.deepEqual(earlyReads([sb.adapter], sb.ad), []);
});

test("self-check result is stored and returned as a copy", () => {
  clearProbe();
  assert.deepEqual(selfCheck(), { hits: [], ok: true });

  setSelfCheck({ hits: ["/a.json"], ok: false });
  const read = selfCheck();
  assert.deepEqual(read, { hits: ["/a.json"], ok: false });

  read.hits.push("/mutated.json");
  assert.deepEqual(selfCheck(), { hits: ["/a.json"], ok: false });
  setSelfCheck({ hits: [], ok: true });
});
