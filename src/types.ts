// Minimal structural subset of the pi host extension API, kept local so that
// this package has no runtime dependency on the host (tests run under node --test).
export interface Ui {
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

export interface ExtensionContext {
  cwd: string;
  hasUI?: boolean;
  isProjectTrusted(): boolean;
  ui: Ui;
}

export interface CommandContext extends ExtensionContext {}

export interface CommandOptions {
  description?: string;
  handler: (args: string, ctx: CommandContext) => Promise<void>;
}

export interface ExtensionAPI {
  on(event: "session_start", handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void): void;
  registerCommand(name: string, options: CommandOptions): void;
}

// Filesystem interception surface. Kept here with the other shared structural
// types so the intercept, migrate/eject and the command wiring agree on one shape.
export interface InterceptOptions {
  agentDir: string;
  adapters: { name: string; config?: { path: string; projectOverride?: string }; data: string[] }[];
  cwd: string;
  projectTrusted: boolean;
  onWarn?: (message: string) => void;
}

export interface Intercept {
  uninstall(): void;
  health(): { patched: string[]; problems: string[] };
}
