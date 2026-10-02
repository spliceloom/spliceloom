export type CoreErrorCode =
  | "NOT_A_PROJECT"
  | "INVALID_PROJECT"
  | "INVALID_CONFIG"
  | "PACKAGE_NOT_FOUND"
  | "NO_MATCHING_VERSION"
  | "INTEGRITY_MISMATCH"
  | "LOCK_MISMATCH"
  | "INSTALLED_PACKAGE_MODIFIED"
  | "INVALID_PACKAGE"
  | "NOT_INSTALLED"
  | "AMBIGUOUS_TOOL"
  | "NOT_LOGGED_IN"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "VERSION_EXISTS"
  | "RATE_LIMITED"
  | "PERMISSIONS_NOT_ACCEPTED"
  | "PERMISSIONS_NOT_GRANTED"
  | "REGISTRY_UNREACHABLE"
  | "REGISTRY_UNAVAILABLE"
  | "REGISTRY_ERROR";

export class CoreError extends Error {
  readonly code: CoreErrorCode;
  readonly details: string[];
  /** Optional suggestion shown to users, e.g. a command to run next. */
  readonly hint: string | undefined;

  constructor(code: CoreErrorCode, message: string, options: { details?: string[]; hint?: string } = {}) {
    super(message);
    this.name = "CoreError";
    this.code = code;
    this.details = options.details ?? [];
    this.hint = options.hint;
  }
}
