/**
 * A small Markdown renderer for the Splice docs (no dependencies). It supports the subset the docs
 * use: headings (with GitHub-style ids), paragraphs, fenced code, tables, nested lists, block
 * quotes, rules, inline code, links, bold and italics. All text is HTML-escaped; raw HTML in
 * Markdown is not passed through.
 */

export interface RenderOptions {
  /**
   * Maps a link target to an href, or null to render the link text without a link. A `section`
   * is rendered as `data-section` (the site scrolls to it without putting a `#` in the URL).
   */
  rewriteLink?: (href: string) => string | { href: string; section?: string } | null;
}

export interface Heading {
  level: number;
  text: string;
  id: string;
}

export interface Rendered {
  html: string;
  title: string;
  headings: Heading[];
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** GitHub-compatible heading slug. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

/** Plain text of inline Markdown (for titles and ids). */
function plain(text: string): string {
  return text.replace(/`([^`]+)`/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1");
}

export function renderInline(text: string, options: RenderOptions = {}): string {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    // Inline code (backslash escapes are literal inside).
    const code = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest);
    if (code) {
      out.push(`<code>${escapeHtml(code[2]!.replace(/^ (.*) $/, "$1"))}</code>`);
      i += code[0].length;
      continue;
    }
    // Links: [text](href) — nested brackets in the text are not needed by the docs.
    const link = /^\[((?:[^\[\]]|\[[^\]]*\])+)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      const inner = renderInline(link[1]!, options);
      const rewritten = options.rewriteLink ? options.rewriteLink(link[2]!) : link[2]!;
      if (rewritten === null) out.push(`<span class="link-text">${inner}</span>`);
      else {
        const target = typeof rewritten === "string" ? { href: rewritten } : rewritten;
        const external = /^https?:\/\//.test(target.href);
        const section = target.section ? ` data-section="${escapeHtml(target.section)}"` : "";
        out.push(`<a href="${escapeHtml(target.href)}"${section}${external ? ' rel="noopener" target="_blank"' : ""}>${inner}</a>`);
      }
      i += link[0].length;
      continue;
    }
    const bold = /^\*\*(?=\S)([\s\S]*?\S)\*\*/.exec(rest);
    if (bold) {
      out.push(`<strong>${renderInline(bold[1]!, options)}</strong>`);
      i += bold[0].length;
      continue;
    }
    // *em* anywhere; _em_ only at word boundaries (so snake_case stays literal).
    const afterWord = i > 0 && /\w/.test(text[i - 1]!);
    const italic = /^\*(?=[^\s*])([^*]*?[^\s*])\*/.exec(rest) ?? (afterWord ? null : /^_(?=\S)([^_]*?\S)_(?!\w)/.exec(rest));
    if (italic) {
      out.push(`<em>${renderInline(italic[1]!, options)}</em>`);
      i += italic[0].length;
      continue;
    }
    if (rest.startsWith("\\") && rest.length > 1 && /[\\`*_\[\]()#|>-]/.test(rest[1]!)) {
      out.push(escapeHtml(rest[1]!));
      i += 2;
      continue;
    }
    out.push(escapeHtml(text[i]!));
    i++;
  }
  return out.join("");
}

interface ListItem {
  lines: string[];
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const LIST_ITEM = /^(\s*)([-*]|\d+[.)])\s+(.*)$/;

function splitTableRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  let inCode = false;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c === "`") inCode = !inCode;
    if (c === "\\" && body[i + 1] === "|") {
      current += "|";
      i++;
    } else if (c === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
    } else current += c;
  }
  cells.push(current.trim());
  return cells;
}

export function renderMarkdown(source: string, options: RenderOptions = {}): Rendered {
  const headings: Heading[] = [];
  const usedIds = new Map<string, number>();
  const html = renderBlocks(source.replace(/\r\n?/g, "\n").split("\n"), options, headings, usedIds);
  const title = headings.find((h) => h.level === 1)?.text ?? headings[0]?.text ?? "";
  return { html, title, headings };
}

function renderBlocks(lines: string[], options: RenderOptions, headings: Heading[], usedIds: Map<string, number>): string {
  const out: string[] = [];
  let i = 0;
  const inline = (t: string) => renderInline(t, options);

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (trimmed === "") {
      i++;
      continue;
    }

    // Fenced code.
    const fence = /^(\s*)(```+|~~~+)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const marker = fence[2]!;
      const indent = fence[1]!.length;
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(marker)) {
        body.push(lines[i]!.slice(Math.min(indent, indentOf(lines[i]!))));
        i++;
      }
      i++;
      const lang = fence[3] ? ` data-lang="${escapeHtml(fence[3])}"` : "";
      out.push(`<pre class="code"${lang}><code>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    // Headings.
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(trimmed);
    if (heading) {
      const level = heading[1]!.length;
      const text = plain(heading[2]!);
      let id = slugify(text);
      const seen = usedIds.get(id) ?? 0;
      usedIds.set(id, seen + 1);
      if (seen > 0) id = `${id}-${seen}`;
      headings.push({ level, text, id });
      out.push(`<h${level} id="${escapeHtml(id)}">${inline(heading[2]!)}</h${level}>`);
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      out.push("<hr>");
      i++;
      continue;
    }

    // Block quote.
    if (trimmed.startsWith(">")) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith(">")) {
        body.push(lines[i]!.trim().replace(/^>\s?/, ""));
        i++;
      }
      out.push(`<blockquote>${renderBlocks(body, options, headings, usedIds)}</blockquote>`);
      continue;
    }

    // Table: header row followed by a separator row.
    if (trimmed.startsWith("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1]!)) {
      const header = splitTableRow(line);
      const align = splitTableRow(lines[i + 1]!).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : ""));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        rows.push(splitTableRow(lines[i]!));
        i++;
      }
      const cell = (tag: string, text: string, col: number) => `<${tag}${align[col] ? ` style="text-align:${align[col]}"` : ""}>${inline(text)}</${tag}>`;
      out.push(
        `<div class="table-wrap"><table><thead><tr>${header.map((h, c) => cell("th", h, c)).join("")}</tr></thead><tbody>${rows
          .map((r) => `<tr>${header.map((_, c) => cell("td", r[c] ?? "", c)).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }

    // Lists (nested by indentation; continuation lines belong to the current item).
    const first = LIST_ITEM.exec(line);
    if (first) {
      const baseIndent = first[1]!.length;
      const ordered = /\d/.test(first[2]!);
      const items: ListItem[] = [];
      while (i < lines.length) {
        const current = lines[i]!;
        const m = LIST_ITEM.exec(current);
        if (m && m[1]!.length === baseIndent && /\d/.test(m[2]!) === ordered) {
          items.push({ lines: [m[3]!] });
          i++;
          continue;
        }
        if (current.trim() === "") {
          // A blank line ends the list unless the next line continues it (indented or next item).
          const next = lines[i + 1];
          if (next !== undefined && (indentOf(next) > baseIndent || (LIST_ITEM.exec(next)?.[1]!.length === baseIndent && next.trim() !== ""))) {
            items.at(-1)!.lines.push("");
            i++;
            continue;
          }
          break;
        }
        if (indentOf(current) > baseIndent) {
          items.at(-1)!.lines.push(current.slice(Math.min(indentOf(current), baseIndent + 2)));
          i++;
          continue;
        }
        break;
      }
      const tag = ordered ? "ol" : "ul";
      const start = ordered && first[2] !== "1." && first[2] !== "1)" ? ` start="${Number.parseInt(first[2]!, 10)}"` : "";
      out.push(
        `<${tag}${start}>${items
          .map((item) => {
            const [head, ...more] = item.lines;
            const task = /^\[( |x)\]\s+/.exec(head!);
            const headText = task ? head!.slice(task[0].length) : head!;
            const checkbox = task ? `<input type="checkbox" disabled${task[1] === "x" ? " checked" : ""}> ` : "";
            const nested = more.some((l) => l.trim() !== "") ? renderBlocks(more, options, headings, usedIds) : "";
            // Continuation lines of the first paragraph are joined to it.
            if (nested && !/^\s*([-*]|\d+[.)]|```|\|)/.test(more.find((l) => l.trim() !== "") ?? "")) {
              const paragraphEnd = more.findIndex((l) => l.trim() === "");
              const cont = (paragraphEnd === -1 ? more : more.slice(0, paragraphEnd)).map((l) => l.trim()).join(" ");
              const remaining = paragraphEnd === -1 ? [] : more.slice(paragraphEnd);
              return `<li>${checkbox}${inline(`${headText} ${cont}`.trim())}${remaining.some((l) => l.trim() !== "") ? renderBlocks(remaining, options, headings, usedIds) : ""}</li>`;
            }
            return `<li>${checkbox}${inline(headText)}${nested}</li>`;
          })
          .join("")}</${tag}>`,
      );
      continue;
    }

    // Paragraph: until a blank line or another block starts.
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      const t = l.trim();
      if (t === "" || /^(#{1,6}\s|```|~~~|>|\|)/.test(t) || LIST_ITEM.test(l) || /^(-{3,}|\*{3,})$/.test(t)) break;
      para.push(t);
      i++;
    }
    if (para.length === 0) {
      // A line no rule consumed: render it as a paragraph so the loop always advances.
      para.push(trimmed);
      i++;
    }
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}
