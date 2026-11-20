import fs from "node:fs";
import { withBypass } from "./fs-intercept.ts";

// Move a file or directory, creating no leftovers at the source. `rename` fails
// across filesystems (EXDEV) — e.g. an agent dir on tmpfs and an old config on
// the home disk — so fall back to copy-then-remove.
export function movePath(src: string, dest: string): void {
  withBypass(() => {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EXDEV" && code !== "EPERM") throw error;
    }
    fs.cpSync(src, dest, { recursive: true, preserveTimestamps: true });
    fs.rmSync(src, { recursive: true, force: true });
  });
}
