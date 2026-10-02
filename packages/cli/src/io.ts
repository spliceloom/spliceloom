import type { Readable } from "node:stream";
import type { FetchLike } from "@spliceloom/core";

/** Everything the CLI touches in the outside world, injectable for tests. */
export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  color: boolean;
  fetch?: FetchLike;
  /** Test seam: replaces provider HTTP of the live data commands (unit tests only). */
  dataFetch?: (input: string, init?: RequestInit) => Promise<Response>;
  /** Reads a secret (hidden input on a TTY, or piped stdin). Absent in non-interactive contexts. */
  readSecret?: (prompt: string) => Promise<string>;
  /** Raw stdin, used by `splice mcp`. */
  stdin?: Readable;
}

export const EXIT_OK = 0;
/** The operation failed (package not found, tool error, registry unreachable, ...). */
export const EXIT_FAILURE = 1;
/** The command line was invalid. */
export const EXIT_USAGE = 2;

export class UsageError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "UsageError";
    this.hint = hint;
  }
}

export interface Style {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
}

const wrap = (open: number, close: number) => (s: string) => `\u001b[${open}m${s}\u001b[${close}m`;

export function createStyle(color: boolean): Style {
  if (!color) {
    const id = (s: string) => s;
    return { bold: id, dim: id, red: id, green: id, yellow: id, cyan: id };
  }
  return {
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    cyan: wrap(36, 39),
  };
}

export interface Context {
  io: CliIo;
  style: Style;
  /** --registry override. */
  registry?: string;
  json: boolean;
  out(line?: string): void;
  err(line?: string): void;
}
