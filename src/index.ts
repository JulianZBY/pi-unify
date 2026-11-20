import type { ExtensionAPI } from "./types.ts";

export default function piUnify(pi: ExtensionAPI): void {
  pi.registerCommand("unify", {
    description: "Show pi-unify status",
    handler: async (_args, ctx) => {
      ctx.ui.notify("pi-unify loaded", "info");
    },
  });
}
