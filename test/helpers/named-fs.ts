// Mirrors how third-party plugins touch the filesystem: named ESM imports.
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";

export const readNamed = (p: string) => readFileSync(p, "utf8");
export const readNamedAsync = (p: string) => readFile(p, "utf8");
export const statNamedAsync = (p: string) => stat(p);
