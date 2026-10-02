export type RuntimeErrorCode =
  | "INVALID_PACKAGE"
  | "TOOL_NOT_FOUND"
  | "INVALID_INPUT"
  | "INPUT_TOO_LARGE"
  | "INVALID_OUTPUT"
  | "PERMISSION_DENIED"
  | "TOOL_LOAD_FAILED"
  | "TOOL_ERROR"
  | "TIMEOUT"
  | "OUTPUT_TOO_LARGE"
  | "TOOL_CRASHED"
  | "RUNTIME_UNSUPPORTED";

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly details: string[];

  constructor(code: RuntimeErrorCode, message: string, details: string[] = []) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
    this.details = details;
  }
}
