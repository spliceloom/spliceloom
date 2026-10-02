/**
 * Secret redaction for error messages and logs shown to users, agents and MCP clients.
 *
 * Defense in depth only: Splice never puts credentials into messages on purpose. This catches
 * well-known token formats that might arrive from elsewhere (registry responses, tool logs, a
 * tool echoing its environment) plus exact values the caller knows are secret (e.g. the
 * environment variables a tool was given). It cannot recognize arbitrary secrets.
 */

export const REDACTED = "[REDACTED]";

const PATTERNS: Array<[RegExp, string]> = [
  // PEM private keys (whole block).
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, `-----${REDACTED} PRIVATE KEY-----`],
  // Splice registry tokens: "splice_" + 43 base64url characters (256 bits). Exact length, so MCP
  // tool names such as splice_github_search-repositories are not mistaken for tokens.
  [/\bsplice_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g, `splice_${REDACTED}`],
  // GitHub tokens.
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, REDACTED],
  // Common API keys (OpenAI/Anthropic-style, Slack, AWS access key ids, Google API keys).
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED],
  // JSON Web Tokens.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  // Authorization header values.
  [/\b(authorization|proxy-authorization)(\s*[:=]\s*)("?)(?:Bearer|Basic|Token|Digest)?\s*[^\s"',;]+/gi, `$1$2$3${REDACTED}`],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, `$1 ${REDACTED}`],
  // Cookies.
  [/\b(set-cookie|cookie)(\s*[:=]\s*)[^\r\n]+/gi, `$1$2${REDACTED}`],
  // Credentials in URLs: user:password@host and secret-looking query parameters.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${REDACTED}@`],
  [/([?&](?:access_token|refresh_token|id_token|token|api[_-]?key|apikey|key|secret|client_secret|password|passwd|pwd|sig|signature|auth)=)[^&\s#"']+/gi, `$1${REDACTED}`],
  // KEY=value assignments whose name says "secret" (e.g. echoed .env lines).
  [/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)[A-Z0-9_]*)(\s*=\s*)("?)[^\s"']+/g, `$1$2$3${REDACTED}`],
];

/** Minimum length for exact-value redaction (shorter values would destroy normal text). */
export const MIN_SECRET_VALUE_LENGTH = 6;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replaces known token formats and the given exact secret values with [REDACTED]. */
export function redactSecrets(text: string, secretValues: readonly string[] = []): string {
  let out = text;
  const values = [...new Set(secretValues.filter((v) => typeof v === "string" && v.length >= MIN_SECRET_VALUE_LENGTH))].sort((a, b) => b.length - a.length);
  for (const value of values) out = out.replace(new RegExp(escapeRegExp(value), "g"), REDACTED);
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}
