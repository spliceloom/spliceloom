export type SpecErrorCode =
  | "INVALID_NAME"
  | "INVALID_REF"
  | "INVALID_VERSION"
  | "INVALID_RANGE"
  | "INVALID_BUNDLE"
  | "INVALID_MANIFEST";

/** Error raised when user or package input violates the Splice specification. */
export class SpecError extends Error {
  readonly code: SpecErrorCode;
  readonly details: string[];

  constructor(code: SpecErrorCode, message: string, details: string[] = []) {
    super(message);
    this.name = "SpecError";
    this.code = code;
    this.details = details;
  }
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };
