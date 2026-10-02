/**
 * A deliberately small subset of JSON Schema used to describe tool input and output.
 * Unsupported keywords are rejected at manifest validation time so authors are never
 * surprised by a constraint that is silently ignored.
 */

export type JsonSchemaType = "object" | "string" | "number" | "integer" | "boolean" | "array" | "null";

export interface JsonSchema {
  type?: JsonSchemaType;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: Array<string | number | boolean | null>;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  default?: unknown;
}

const TYPES: readonly JsonSchemaType[] = ["object", "string", "number", "integer", "boolean", "array", "null"];
const KEYWORDS = new Set([
  "type",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "default",
]);
const NON_NEGATIVE_INT = ["minLength", "maxLength", "minItems", "maxItems"] as const;
const MAX_DEPTH = 16;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns errors describing why `schema` is not a valid Splice schema (empty when valid). */
export function checkSchemaDefinition(schema: unknown, path = "schema", depth = 0): string[] {
  if (depth > MAX_DEPTH) return [`${path}: schema nesting is too deep (max ${MAX_DEPTH})`];
  if (!isPlainObject(schema)) return [`${path}: must be an object`];
  const errors: string[] = [];
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key)) errors.push(`${path}: unsupported keyword "${key}"`);
  }
  if (schema.type !== undefined && !TYPES.includes(schema.type as JsonSchemaType)) {
    errors.push(`${path}.type: must be one of ${TYPES.join(", ")}`);
  }
  if (schema.description !== undefined && typeof schema.description !== "string") {
    errors.push(`${path}.description: must be a string`);
  }
  if (schema.properties !== undefined) {
    if (!isPlainObject(schema.properties)) {
      errors.push(`${path}.properties: must be an object`);
    } else {
      for (const [name, sub] of Object.entries(schema.properties)) {
        errors.push(...checkSchemaDefinition(sub, `${path}.properties.${name}`, depth + 1));
      }
    }
  }
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required) || !schema.required.every((r) => typeof r === "string")) {
      errors.push(`${path}.required: must be an array of strings`);
    }
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== "boolean") {
    errors.push(`${path}.additionalProperties: must be a boolean`);
  }
  if (schema.items !== undefined) errors.push(...checkSchemaDefinition(schema.items, `${path}.items`, depth + 1));
  if (schema.enum !== undefined) {
    const ok =
      Array.isArray(schema.enum) &&
      schema.enum.length > 0 &&
      schema.enum.every((v) => v === null || ["string", "number", "boolean"].includes(typeof v));
    if (!ok) errors.push(`${path}.enum: must be a non-empty array of primitives`);
  }
  for (const key of NON_NEGATIVE_INT) {
    const value = schema[key];
    if (value !== undefined && !(Number.isInteger(value) && (value as number) >= 0)) {
      errors.push(`${path}.${key}: must be a non-negative integer`);
    }
  }
  for (const key of ["minimum", "maximum"] as const) {
    const value = schema[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      errors.push(`${path}.${key}: must be a finite number`);
    }
  }
  return errors;
}

function typeOf(value: unknown): JsonSchemaType | "undefined" | "other" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "number":
      return Number.isFinite(value) ? "number" : "other";
    case "object":
      return "object";
    case "undefined":
      return "undefined";
    default:
      return "other";
  }
}

/** Validates `value` against a (previously checked) schema. Returns error messages; empty when valid. */
export function validateValue(schema: JsonSchema, value: unknown, path = "$"): string[] {
  const errors: string[] = [];
  const actual = typeOf(value);

  if (schema.type) {
    const matches =
      schema.type === actual ||
      (schema.type === "integer" && actual === "number" && Number.isInteger(value)) ||
      (schema.type === "number" && actual === "number");
    if (!matches) {
      return [`${path}: expected ${schema.type}, got ${actual === "number" ? "non-integer number" : actual}`];
    }
  }

  if (schema.enum && !schema.enum.some((option) => option === value)) {
    errors.push(`${path}: must be one of ${schema.enum.map((o) => JSON.stringify(o)).join(", ")}`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${path}: must be at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${path}: must be at most ${schema.maxLength} characters`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: must be <= ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: must contain at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${path}: must contain at most ${schema.maxItems} items`);
    }
    if (schema.items) {
      value.forEach((item, i) => errors.push(...validateValue(schema.items!, item, `${path}[${i}]`)));
    }
  }

  if (isPlainObject(value)) {
    const properties = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key}: is required`);
    }
    for (const [key, sub] of Object.entries(value)) {
      const propSchema = properties[key];
      if (propSchema) {
        errors.push(...validateValue(propSchema, sub, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key}: unknown property`);
      }
    }
  }

  return errors;
}
