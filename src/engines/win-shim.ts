/**
 * Windows runs a `.cmd` or `.bat` file only through cmd.exe. Node refuses to spawn one directly (EINVAL, since the
 * CVE-2024-27980 fix), and `shell: true` would join the arguments unescaped. So an engine installed as a shim
 * (`cursor-agent.cmd`) is launched as `cmd.exe /d /s /c "…"`, with the file quoted once and each argument quoted
 * twice: the shim hands its `%*` to a second cmd parse.
 */
const CMD_META = /([()\][%!^"`<>&|;, *?\t\n\r=])/g;

function quoteForCmd(arg: string, passes: number): string {
  // CommandLineToArgv rules: a backslash is literal unless it precedes a quote, so double those, then quote.
  let s = `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
  for (let i = 0; i < passes; i++) s = s.replace(CMD_META, "^$1");
  return s;
}

export interface SpawnInvocation {
  file: string;
  args: string[];
  /** Node must pass `args` to the command line as they are: the cmd line above is already quoted. */
  verbatim: boolean;
}

export function shimInvocation(file: string, args: string[], platform: NodeJS.Platform = process.platform): SpawnInvocation {
  if (platform !== "win32" || !/\.(cmd|bat)$/i.test(file)) return { file, args, verbatim: false };
  const line = [quoteForCmd(file, 1), ...args.map((a) => quoteForCmd(a, 2))].join(" ");
  return { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", `"${line}"`], verbatim: true };
}
