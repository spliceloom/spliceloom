/**
 * Human output helpers: aligned tables and compact numbers. Values are formatted, never changed:
 * a missing provider field prints as "—", not 0.
 */
import type { Style } from "./io.js";

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const width = (s: string) => [...s.replace(ANSI, "")].length;

export type Align = "left" | "right";

/** Rows of already-formatted cells → aligned lines (header dimmed). */
export function table(style: Style, headers: string[], rows: string[][], align: Align[] = []): string[] {
  const widths = headers.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i] ?? ""))));
  const pad = (cell: string, i: number) => {
    const fill = " ".repeat(Math.max(0, widths[i]! - width(cell)));
    return align[i] === "right" ? fill + cell : cell + fill;
  };
  const line = (cells: string[]) => `  ${cells.map(pad).join("  ")}`.trimEnd();
  return [style.dim(line(headers)), ...rows.map(line)];
}

const DASH = "—";

function toNumber(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** $1.23M, $45.6K, $812 — for volumes, liquidity, market caps. */
export function usdCompact(v: unknown): string {
  const n = toNumber(v);
  if (n === undefined) return DASH;
  const abs = Math.abs(n);
  const units: Array<[number, string]> = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [size, suffix] of units) if (abs >= size) return `$${(n / size).toFixed(abs / size >= 100 ? 0 : abs / size >= 10 ? 1 : 2)}${suffix}`;
  return `$${n.toFixed(abs >= 100 ? 0 : 2)}`;
}

/** Prices keep their significant digits: $2,703.40, $0.0₅1234 style is avoided for copy-paste. */
export function usdPrice(v: unknown): string {
  const n = toNumber(v);
  if (n === undefined) return DASH;
  const abs = Math.abs(n);
  if (abs >= 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  if (abs >= 1) return `$${n.toFixed(4).replace(/0{1,2}$/, "")}`;
  if (abs === 0) return "$0";
  return `$${n.toPrecision(4)}`;
}

/** +12.3% green / -4.5% red. */
export function pct(style: Style, v: unknown): string {
  const n = toNumber(v);
  if (n === undefined) return DASH;
  const text = `${n > 0 ? "+" : ""}${n.toFixed(Math.abs(n) >= 100 ? 0 : 1)}%`;
  return n > 0 ? style.green(text) : n < 0 ? style.red(text) : text;
}

/** "3h", "2d", "5m" since an ISO time. */
export function age(iso: unknown, now = Date.now()): string {
  if (typeof iso !== "string") return DASH;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return DASH;
  const s = Math.max(0, (now - t) / 1000);
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  if (s < 86_400 * 60) return `${Math.round(s / 86_400)}d`;
  return `${Math.round(s / (86_400 * 30))}mo`;
}

/** ▁▂▃▅▇ line of values (empty for fewer than two points). */
export function sparkline(values: number[]): string {
  if (values.length < 2) return "";
  const bars = "▁▂▃▄▅▆▇█";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values.map((v) => bars[Math.min(bars.length - 1, Math.floor(((v - min) / span) * (bars.length - 1)))]).join("");
}

/**
 * Minimal Markdown for terminal answers: headings and **bold** become bold, [text](url) becomes
 * "text (url)", list markers and tables stay as they are.
 */
export function renderMarkdown(style: Style, text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      let out = heading ? style.bold(heading[1]!) : line;
      out = out.replace(/\*\*([^*]+)\*\*/g, (_, b: string) => style.bold(b));
      out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t: string, u: string) => `${t} ${style.dim(`(${u})`)}`);
      out = out.replace(/(^|\s)\*([^*\s][^*]*)\*(?=\s|$|[.,;:])/g, "$1$2");
      return out;
    })
    .join("\n");
}

export function truncate(s: string | undefined, max: number): string {
  if (!s) return DASH;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
