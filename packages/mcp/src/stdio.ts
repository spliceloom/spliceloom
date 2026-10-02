/**
 * MCP stdio transport: newline-delimited JSON-RPC on stdin/stdout. stdout carries protocol
 * messages only; diagnostics go to the server's log (stderr).
 */
import { StringDecoder } from "node:string_decoder";
import type { Readable } from "node:stream";
import { JSONRPC_INVALID_REQUEST, JSONRPC_PARSE_ERROR, type JsonRpcResponse } from "./protocol.js";

/** Longest accepted message line (bytes of UTF-16 text); longer lines are discarded while streaming. */
export const MAX_STDIO_LINE_LENGTH = 4 * 1024 * 1024;

/** Serves until `input` ends. `writeOut` receives complete protocol lines for stdout. */
export function serveStdio(
  server: { handle(message: unknown): Promise<JsonRpcResponse | null> },
  input: Readable,
  writeOut: (line: string) => void,
  options: { maxLineLength?: number } = {},
): Promise<void> {
  const maxLine = options.maxLineLength ?? MAX_STDIO_LINE_LENGTH;
  const write = (message: unknown) => {
    writeOut(JSON.stringify(message) + "\n");
  };
  const pending = new Set<Promise<void>>();

  const handleLine = (raw: string) => {
    // Some shells (Windows PowerShell 5.1) prepend a UTF-8 byte order mark to piped input.
    const line = (raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw).replace(/\r$/, "");
    if (line.trim() === "") return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: JSONRPC_PARSE_ERROR, message: "Parse error" } });
      return;
    }
    // Requests are handled concurrently; each response carries its request id.
    const task = server.handle(message).then((response) => {
      if (response) write(response);
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  // A line is never buffered beyond maxLine: an oversized message is dropped as it streams in.
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let discarding = false;
  const push = (text: string) => {
    let start = 0;
    for (let nl = text.indexOf("\n"); nl !== -1; nl = text.indexOf("\n", start)) {
      const piece = text.slice(start, nl);
      if (discarding) discarding = false;
      else if (buffer.length + piece.length > maxLine) write({ jsonrpc: "2.0", id: null, error: { code: JSONRPC_INVALID_REQUEST, message: "Message too large" } });
      else handleLine(buffer + piece);
      buffer = "";
      start = nl + 1;
    }
    if (discarding) return;
    buffer += text.slice(start);
    if (buffer.length > maxLine) {
      buffer = "";
      discarding = true;
      write({ jsonrpc: "2.0", id: null, error: { code: JSONRPC_INVALID_REQUEST, message: "Message too large" } });
    }
  };

  return new Promise((resolve) => {
    input.on("data", (chunk: Buffer | string) => push(typeof chunk === "string" ? chunk : decoder.write(chunk)));
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      push(decoder.end());
      if (!discarding && buffer.length > 0) handleLine(buffer);
      buffer = "";
      void Promise.allSettled([...pending]).then(() => resolve());
    };
    input.on("end", finish);
    input.on("close", finish);
  });
}
