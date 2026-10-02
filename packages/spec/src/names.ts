import { SpecError } from "./errors.js";
import { isValidRange } from "./semver.js";

/** Namespace and package name segment: lowercase, digits, dashes. No dots (dots separate tools). */
export const NAME_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Tool names start with a letter. */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

export interface PackageName {
  namespace: string;
  name: string;
  /** Canonical id, e.g. `@splice/example`. */
  id: string;
}

export interface PackageRef extends PackageName {
  /** Version range; `latest` when omitted. */
  range: string;
}

export interface ToolRef {
  /** Present only when the reference was fully qualified (`@ns/name.tool`). */
  namespace?: string;
  name: string;
  tool: string;
}

export function isValidNameSegment(value: string): boolean {
  return NAME_SEGMENT_PATTERN.test(value);
}

export function isValidToolName(value: string): boolean {
  return TOOL_NAME_PATTERN.test(value);
}

export function formatPackageId(namespace: string, name: string): string {
  return `@${namespace}/${name}`;
}

const ID_PATTERN = /^@([^/@\s]+)\/([^/@\s]+)$/;

/** Parses `@namespace/name`. */
export function parsePackageId(input: string): PackageName {
  const match = ID_PATTERN.exec(input.trim());
  if (!match) {
    throw new SpecError("INVALID_NAME", `Invalid package name "${input}". Expected @namespace/name, e.g. @splice/example.`);
  }
  const namespace = match[1]!;
  const name = match[2]!;
  if (!isValidNameSegment(namespace) || !isValidNameSegment(name)) {
    throw new SpecError(
      "INVALID_NAME",
      `Invalid package name "${input}". Namespace and name may only contain lowercase letters, digits and dashes.`,
    );
  }
  return { namespace, name, id: formatPackageId(namespace, name) };
}

/** Parses `@namespace/name` or `@namespace/name@range`. */
export function parsePackageRef(input: string): PackageRef {
  const trimmed = input.trim();
  const at = trimmed.indexOf("@", 1);
  const idPart = at === -1 ? trimmed : trimmed.slice(0, at);
  const range = at === -1 ? "latest" : trimmed.slice(at + 1);
  const parsed = parsePackageId(idPart);
  if (!range || !isValidRange(range)) {
    throw new SpecError(
      "INVALID_RANGE",
      `Invalid version range "${range}" in "${input}". Use an exact version (1.2.3), ^1.2.3, ~1.2.3, * or latest.`,
    );
  }
  return { ...parsed, range };
}

/** Parses a tool reference: `example.hello` or `@splice/example.hello`. */
export function parseToolRef(input: string): ToolRef {
  const trimmed = input.trim();
  const dot = trimmed.lastIndexOf(".");
  if (dot <= 0 || dot === trimmed.length - 1) {
    throw new SpecError("INVALID_REF", `Invalid tool reference "${input}". Expected <package>.<tool>, e.g. example.hello.`);
  }
  const pkg = trimmed.slice(0, dot);
  const tool = trimmed.slice(dot + 1);
  if (!isValidToolName(tool)) {
    throw new SpecError("INVALID_REF", `Invalid tool name "${tool}" in "${input}".`);
  }
  if (pkg.startsWith("@")) {
    const { namespace, name } = parsePackageId(pkg);
    return { namespace, name, tool };
  }
  if (!isValidNameSegment(pkg)) {
    throw new SpecError("INVALID_REF", `Invalid package name "${pkg}" in "${input}".`);
  }
  return { name: pkg, tool };
}
