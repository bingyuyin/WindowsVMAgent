import { spawn, type ChildProcess } from "node:child_process";

export interface CommandRunOptions {
  cwd: string;
  /** Hard limit for the whole command. */
  timeoutMs: number;
  /** Stops a command that prints nothing for this long: it most likely hangs. */
  silenceMs: number;
  signal?: AbortSignal;
  /** Called whenever the command prints something (a sign of life). */
  onOutput?: () => void;
  /** Variables to set on top of the hub's environment (e.g. a per-task temp folder). */
  env?: Record<string, string>;
}

export interface CommandResult {
  /** Null when the command was stopped. */
  exitCode: number | null;
  stopped?: "timeout" | "silent" | "cancelled";
  durationMs: number;
  /** The end of the combined stdout and stderr. */
  output: string;
}

export type CommandRunner = (command: string, options: CommandRunOptions) => Promise<CommandResult>;

const OUTPUT_LIMIT = 64 * 1024;

/** Agents run commands in PowerShell on Windows and in bash elsewhere, so commands they report run in the same shell. */
const SHELLS: ReadonlyArray<readonly [string, (command: string) => string[]]> =
  process.platform === "win32"
    ? [
        ["pwsh", powershellArgs],
        ["powershell", powershellArgs],
      ]
    : [
        ["bash", (command) => ["-c", command]],
        ["sh", (command) => ["-c", command]],
      ];

function powershellArgs(command: string): string[] {
  // Fail when a native command failed even if a later statement succeeded; -EncodedCommand avoids quoting issues.
  const script = `${WINDOWS_JOB}\n[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n${command}\nif ($LASTEXITCODE) { exit $LASTEXITCODE }`;
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

/**
 * Windows has no process groups: the shell joins a job object that allows no breakaway and ends every process still
 * in it (a test server, a watcher, a build server) once the shell exits or is stopped, even processes whose parent
 * already exited. Best effort: if the job cannot be set up, the command still runs.
 */
const WINDOWS_JOB = [
  "& { try {",
  "  $type = [Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly([Reflection.AssemblyName]'AgentHubJob', 'Run').DefineDynamicModule('AgentHubJob').DefineType('AgentHubJob', 'Public')",
  "  $type.DefinePInvokeMethod('CreateJobObjectW', 'kernel32.dll', 'Public, Static, PinvokeImpl', 'Standard', [IntPtr], [Type[]]@([IntPtr], [IntPtr]), 'Winapi', 'Unicode').SetImplementationFlags('PreserveSig')",
  "  $type.DefinePInvokeMethod('SetInformationJobObject', 'kernel32.dll', 'Public, Static, PinvokeImpl', 'Standard', [bool], [Type[]]@([IntPtr], [int], [byte[]], [int]), 'Winapi', 'Unicode').SetImplementationFlags('PreserveSig')",
  "  $type.DefinePInvokeMethod('AssignProcessToJobObject', 'kernel32.dll', 'Public, Static, PinvokeImpl', 'Standard', [bool], [Type[]]@([IntPtr], [IntPtr]), 'Winapi', 'Unicode').SetImplementationFlags('PreserveSig')",
  "  $api = $type.CreateType()",
  "  $job = $api::CreateJobObjectW([IntPtr]::Zero, [IntPtr]::Zero)",
  // JOBOBJECT_EXTENDED_LIMIT_INFORMATION with LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; the handle stays open until the shell exits.
  "  $limits = [byte[]]::new(80 + 8 * [IntPtr]::Size)",
  "  [BitConverter]::GetBytes(0x2000).CopyTo($limits, 16)",
  "  if ($api::SetInformationJobObject($job, 9, $limits, $limits.Length)) { $null = $api::AssignProcessToJobObject($job, [Diagnostics.Process]::GetCurrentProcess().Handle) }",
  "} catch {} }",
].join("\n");

/** Runs a shell command non-interactively (CI=true) and returns its exit code and the end of its output. */
export async function runShellCommand(command: string, options: CommandRunOptions): Promise<CommandResult> {
  for (const [index, [shell, args]] of SHELLS.entries()) {
    try {
      return await run(shell, args(command), options);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || index === SHELLS.length - 1) throw error;
    }
  }
  throw new Error("No shell available to run the command");
}

function run(file: string, args: string[], options: CommandRunOptions): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    if (options.signal?.aborted) {
      resolve({ exitCode: null, stopped: "cancelled", durationMs: 0, output: "" });
      return;
    }
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: withEnv(process.env, { CI: "true", NO_COLOR: "1", ...options.env }),
      windowsHide: true,
      // Its own process group, so the whole tree can be stopped.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let stopped: CommandResult["stopped"];
    let settled = false;
    let exitCode: number | null = null;
    let silence: NodeJS.Timeout | undefined;
    let drain: NodeJS.Timeout | undefined;
    const stop = (reason: NonNullable<CommandResult["stopped"]>) => {
      if (stopped) return;
      stopped = reason;
      killTree(child);
    };
    const armSilence = () => {
      clearTimeout(silence);
      silence = setTimeout(() => stop("silent"), options.silenceMs);
    };
    const overall = setTimeout(() => stop("timeout"), options.timeoutMs);
    const onAbort = () => stop("cancelled");
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(silence);
      clearTimeout(overall);
      clearTimeout(drain);
      options.signal?.removeEventListener("abort", onAbort);
      settle();
    };
    const done = () => finish(() => resolve({ exitCode: stopped ? null : exitCode, stopped, durationMs: Date.now() - started, output }));
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_LIMIT);
      options.onOutput?.();
      armSilence();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    armSilence();
    child.stdout!.on("data", collect);
    child.stderr!.on("data", collect);
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code) => {
      if (settled) return;
      exitCode = code;
      // Whatever the command left running (a test server, a watcher) holds ports and files other tasks need, and keeps
      // the pipes open. On Windows the shell's job object ends it as the shell exits.
      if (process.platform !== "win32") killTree(child);
      drain = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        done();
      }, 2000);
    });
    child.once("close", done);
  });
}

/** Environment variables are case-insensitive on Windows, so an override replaces any differently cased original. */
function withEnv(base: NodeJS.ProcessEnv, overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (process.platform === "win32") {
      for (const existing of Object.keys(env)) if (existing.toUpperCase() === key.toUpperCase()) delete env[existing];
    }
    env[key] = value;
  }
  return env;
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).once("error", () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
