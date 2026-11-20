import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readState, writeState } from "../src/state.ts";
import { statePath } from "../src/paths.ts";

function agentDir(t: { after: (fn: () => void) => void }): string {
  const ad = mkdtempSync(join(tmpdir(), "pi-unify-state-"));
  t.after(() => rmSync(ad, { recursive: true, force: true }));
  return ad;
}

test("missing state file means nothing adopted", (t) => {
  assert.deepEqual(readState(agentDir(t)), { migrations: {} });
});

test("state round-trips through the agent dir", (t) => {
  const ad = agentDir(t);
  writeState(ad, { migrations: { "pi-demo": { migratedAt: "2026-01-01T00:00:00Z" } } });
  assert.deepEqual(readState(ad).migrations["pi-demo"].migratedAt, "2026-01-01T00:00:00Z");
});

test("corrupt state file is ignored rather than thrown", (t) => {
  const ad = agentDir(t);
  mkdirSync(join(ad, "extensions/data/unify"), { recursive: true });
  writeFileSync(statePath(ad), "{ not json");
  assert.deepEqual(readState(ad), { migrations: {} });
});

// Regression: a crash mid-write could leave a truncated state file and lose
// every migration record. The write now goes through a temp file + rename.
test("a failed swap leaves the existing state intact", (t) => {
  const ad = agentDir(t);
  writeState(ad, { migrations: { keep: { migratedAt: "keep" } } });

  const realRename = fs.renameSync;
  fs.renameSync = (() => {
    throw new Error("boom");
  }) as typeof fs.renameSync;
  try {
    assert.throws(() => writeState(ad, { migrations: { next: { migratedAt: "next" } } }), /boom/);
  } finally {
    fs.renameSync = realRename;
  }

  assert.deepEqual(Object.keys(readState(ad).migrations), ["keep"]);
  assert.equal(readdirSync(join(ad, "extensions/data/unify")).some((f) => f.endsWith(".tmp")), true);
});
