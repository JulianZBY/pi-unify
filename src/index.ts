// First import on purpose: evaluating ./probe.ts installs the read probe, which
// must happen before any adapter or plugin work below.
import "./probe.ts";
import { fileURLToPath } from "node:url";
import { loadAdapters } from "./adapters.ts";
import { diagnose } from "./diagnose.ts";
import { eject, ejectAll } from "./eject.ts";
import { installIntercept } from "./fs-intercept.ts";
import { migrate, migrateAll } from "./migrate.ts";
import { agentDir } from "./paths.ts";
import { earlyReads, setSelfCheck, uninstallProbe } from "./probe.ts";
import type { ExtensionAPI } from "./types.ts";
import type { InterceptOptions } from "./types.ts";

function selfCheckMessage(hits: string[]): string {
  return (
    `pi-unify: ${hits.length} adopted config file(s) were read before interception was installed` +
    " — pi-unify must be first in `packages`. Move it to the top and /reload."
  );
}

// This package must load before the plugins it adopts (see README), so the
// intercept is installed here in the factory rather than in session_start.
export default function piUnify(pi: ExtensionAPI): void {
  const ad = agentDir();
  const warnings: string[] = [];
  let rejectedWrites = 0;
  let notifiedRejected = 0;
  const { adapters, warnings: loadWarnings } = loadAdapters(ad, [fileURLToPath(new URL("../adapters", import.meta.url))]);
  warnings.push(...loadWarnings);
  const options: InterceptOptions = {
    agentDir: ad,
    adapters,
    cwd: process.cwd(),
    projectTrusted: false,
    onWarn: (msg) => {
      if (msg.startsWith("reject config write")) rejectedWrites += 1;
      warnings.push(msg);
    },
  };
  const intercept = installIntercept(options);

  // Rejections are otherwise invisible; tell the user once per batch, not per write.
  const notifyRejected = (ctx: { hasUI?: boolean; ui: { notify: (msg: string, type?: "warning") => void } }) => {
    if (rejectedWrites === notifiedRejected || ctx.hasUI === false) return;
    const count = rejectedWrites - notifiedRejected;
    notifiedRejected = rejectedWrites;
    ctx.ui.notify(`pi-unify: ${count} config write(s) rejected — run /unify for details`, "warning");
  };

  const hits = earlyReads(adapters, ad);
  // The probe only matters before the intercept exists; the recorded hits are
  // kept in the self-check result, so drop the extra wrapper now.
  uninstallProbe();
  setSelfCheck({ hits, ok: hits.length === 0 });

  pi.on("session_start", (_event, ctx) => {
    // Project overrides are only read once the host reports the project trusted;
    // the intercept re-reads this flag per call, so no second patch is needed.
    options.projectTrusted = ctx.isProjectTrusted();
    options.cwd = ctx.cwd;
    notifyRejected(ctx);
    if (!ctx.hasUI || hits.length === 0) return;
    ctx.ui.notify(selfCheckMessage(hits), "warning");
  });

  pi.registerCommand("unify", {
    description: "Show pi-unify status",
    handler: async (_args, ctx) => {
      notifyRejected(ctx);
      const lines = diagnose({
        agentDir: ad,
        cwd: ctx.cwd,
        projectTrusted: ctx.isProjectTrusted(),
        adapters,
        warnings,
        health: intercept.health(),
      });
      const selfCheckFailed = lines.some((line) => line.startsWith("self-check: WARNING"));
      ctx.ui.notify(lines.join("\n"), selfCheckFailed ? "warning" : "info");
    },
  });

  pi.registerCommand("unify:migrate", {
    description: "Back up and move plugin config/data into the unified layout (no name = every adapter)",
    handler: async (args, ctx) => {
      notifyRejected(ctx);
      const plugin = args.trim();
      const result = plugin ? migrate(plugin, { agentDir: ad, adapters }) : migrateAll({ agentDir: ad, adapters });
      ctx.ui.notify(result.message, result.ok ? "info" : "error");
    },
  });

  pi.registerCommand("unify:eject", {
    description: "Move config/data back to the old layout and forget the migration (no name = every plugin)",
    handler: async (args, ctx) => {
      notifyRejected(ctx);
      const plugin = args.trim();
      const options = { agentDir: ad, adapters, cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() };
      const result = plugin ? eject(plugin, options) : ejectAll(options);
      ctx.ui.notify(result.message, result.ok ? "info" : "error");
    },
  });
}
