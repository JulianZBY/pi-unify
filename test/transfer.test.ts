import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { movePath } from "../src/transfer.ts";

test("movePath moves a file and leaves nothing behind", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-unify-move-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const src = join(root, "a.json");
  writeFileSync(src, "content");

  movePath(src, join(root, "b.json"));

  assert.equal(existsSync(src), false);
  assert.equal(readFileSync(join(root, "b.json"), "utf8"), "content");
});

// Different filesystem: /tmp is usually tmpfs, /dev/shm is a separate tmpfs mount,
// so rename() returns EXDEV and only the copy fallback can succeed.
test("movePath falls back to copy across filesystems", (t) => {
  if (!existsSync("/dev/shm") || statSync("/dev/shm").dev === statSync(tmpdir()).dev) {
    t.skip("/dev/shm is not a separate filesystem here");
    return;
  }
  const srcDir = mkdtempSync(join(tmpdir(), "pi-unify-xdev-src-"));
  const destDir = mkdtempSync("/dev/shm/pi-unify-xdev-dest-");
  t.after(() => {
    rmSync(srcDir, { recursive: true, force: true });
    rmSync(destDir, { recursive: true, force: true });
  });
  mkdirSync(join(srcDir, "daily"), { recursive: true });
  writeFileSync(join(srcDir, "daily", "log.md"), "entry");

  movePath(srcDir, join(destDir, "moved"));

  assert.equal(existsSync(srcDir), false);
  assert.equal(readFileSync(join(destDir, "moved", "daily", "log.md"), "utf8"), "entry");
});
