/**
 * Builds the Splice website (static files, no runtime dependencies) for two hosts:
 *   apps/site/dist       the site — landing page (spliceloom.com)
 *   apps/site/dist-docs  the docs host — docs and skill pages (docs.spliceloom.com)
 *
 *   node apps/site/build.ts [--registry <url>] [--out <dir>] [--docs-out <dir>] [--site-url <url>]
 *                           [--docs-url <url>] [--snapshot <file>] [--no-verify]
 *
 * Registry data (official skills: versions, permissions, tools, verification) is read from the
 * public registry API at build time — see src/registry.ts. `--snapshot` reuses a registry.json
 * written by an earlier build (for offline builds); it never invents data.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderMarkdown } from "./src/markdown.ts";
import { docLoc, href, placeOf, renderDocPage, renderLanding, renderNotFound, type NavGroup, type SiteConfig } from "./src/pages.ts";
import { loadProviders } from "./src/providers.ts";
import { loadSnapshot, type RegistrySnapshot, type SkillView } from "./src/registry.ts";
import { BROKER_CAPABILITIES } from "../../packages/spec/dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../..");

export const PRODUCTION_REGISTRY = "https://registry.spliceloom.com";
/** Primary domain (Worker custom domain; see apps/site/wrangler.jsonc). */
export const DEFAULT_SITE_URL = "https://spliceloom.com";
/** Documentation host (Worker custom domain; see apps/site/wrangler.docs.jsonc). */
export const DEFAULT_DOCS_URL = "https://docs.spliceloom.com";
export const GITHUB_URL = "https://github.com/spliceloom/spliceloom";

/** Documentation pages published on the website, grouped for navigation. */
export const DOC_NAV: NavGroup[] = [
  { title: "Getting started", items: [{ slug: "introduction", title: "Introduction" }, { slug: "installation", title: "Installation" }, { slug: "quickstart", title: "Quickstart" }, { slug: "getting-started", title: "Walkthrough" }, { slug: "creating-a-skill", title: "First skill" }] },
  { title: "Core concepts", items: [{ slug: "packages", title: "Skills" }, { slug: "capabilities", title: "Capabilities" }, { slug: "data-providers", title: "Providers" }, { slug: "architecture", title: "Architecture" }, { slug: "runtime", title: "Runtime" }, { slug: "permissions", title: "Permissions" }, { slug: "provenance", title: "Provenance" }] },
  { title: "Developers", items: [{ slug: "cli", title: "CLI" }, { slug: "ask", title: "Ask (AI agent)" }, { slug: "sdk", title: "SDK" }, { slug: "mcp", title: "MCP" }, { slug: "authoring-skills", title: "Skill authoring" }, { slug: "spec", title: "Manifest" }, { slug: "composition", title: "Composition" }, { slug: "testing", title: "Testing" }, { slug: "lifecycle", title: "Lockfile & updates" }] },
  { title: "Providers", items: [{ slug: "providers-ai", title: "AI" }, { slug: "providers-github", title: "GitHub" }, { slug: "providers-web", title: "Web" }, { slug: "providers-market", title: "Market data" }, { slug: "providers-onchain", title: "Onchain" }, { slug: "markets", title: "Tokens, global & dashboard" }, { slug: "stock-tokens", title: "Stock tokens & rankings" }, { slug: "robinhood-chain", title: "Robinhood Chain" }] },
  { title: "Security", items: [{ slug: "security", title: "Trust model" }, { slug: "sandbox", title: "Sandbox" }, { slug: "network-security", title: "Network security" }, { slug: "trust", title: "Verification" }] },
  { title: "Registry", items: [{ slug: "public-registry", title: "Public registry" }, { slug: "publishing", title: "Publishing" }, { slug: "private-registry", title: "Private registry" }, { slug: "organizations", title: "Organizations" }, { slug: "releasing", title: "Releasing the CLI" }] },
  { title: "Reference", items: [{ slug: "api", title: "Registry API" }, { slug: "environment-variables", title: "Environment variables" }, { slug: "overview", title: "Project history" }, { slug: "faq", title: "FAQ" }] },
  {
    title: "Official skills",
    items: [
      { slug: "skills", title: "Overview" },
      { slug: "skills/json", title: "@splice/json" },
      { slug: "skills/http", title: "@splice/http" },
      { slug: "skills/files", title: "@splice/files" },
      { slug: "skills/github", title: "@splice/github" },
      { slug: "skills/web", title: "@splice/web" },
      { slug: "skills/market", title: "@splice/market" },
      { slug: "skills/onchain", title: "@splice/onchain" },
      { slug: "skills/robinhood", title: "@splice/robinhood" },
    ],
  },
];

/** Pages rendered but not in the navigation (kept so existing links resolve). */
const EXTRA_DOCS: string[] = [];
/** Operator documentation (admin API, deployment, local setup) stays in the repository only. */
export const PRIVATE_DOCS = ["auth", "registry", "deployment", "local-development"];

export const PUBLISHED_DOCS = [...DOC_NAV.flatMap((g) => g.items.map((i) => i.slug)).filter((s) => !s.startsWith("skills/")), ...EXTRA_DOCS];
export const SKILL_PAGES = ["json", "http", "files", "github", "web", "market", "onchain", "robinhood"];

/**
 * Link rewriting for rendered Markdown: `.md` → clean URLs on the docs host (`security`,
 * `../skills/json`, no `.html`); `#anchors` become a `section` (data-section) so URLs never carry a
 * `#`; repository-only targets become plain text. `link` maps a logical path (`docs/<slug>`,
 * `skills/<name>`) to an href from the current page; `self` is the page's own href.
 */
export function linkRewriter(from: "docs" | "skills", self: string, link: (path: string) => string) {
  return (href: string): string | { href: string; section?: string } | null => {
    if (/^(https?:|mailto:)/.test(href)) return href;
    const [path, anchor] = href.split("#") as [string, string | undefined];
    const target = (url: string) => (anchor ? { href: url, section: anchor } : url);
    if (path === "") return target(self);
    const docMatch = from === "docs" ? /^(?:\.\/)?([\w-]+)\.md$/.exec(path) ?? /^\.\.\/docs\/([\w-]+)\.md$/.exec(path) : /^\.\.\/\.\.\/docs\/([\w-]+)\.md$/.exec(path);
    if (docMatch) return PUBLISHED_DOCS.includes(docMatch[1]!) ? target(link(`docs/${docMatch[1]}`)) : null;
    const skillMatch = /^(?:\.\.\/)+skills\/([\w-]+)\/SKILL\.md$/.exec(path);
    if (skillMatch) return SKILL_PAGES.includes(skillMatch[1]!) ? target(link(`skills/${skillMatch[1]}`)) : null;
    return null; // repository files (examples/, packages/, LICENSE, …) are not part of the site
  };
}

/** Searchable plain text of a Markdown page (no code blocks, tables or markup). */
function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .split("\n")
    .filter((l) => !l.startsWith("#") && !l.startsWith("|"))
    .join(" ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function descriptionOf(markdown: string): string {
  const para = markdown
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith("#") && !p.startsWith("```") && !p.startsWith("|") && !p.startsWith(">") && !p.startsWith("-"));
  const text = (para ?? "Splice documentation").replace(/\s+/g, " ").replace(/[`*_]/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  return text.length > 160 ? `${text.slice(0, 157).replace(/\s+\S*$/, "")}…` : text;
}

function skillAside(skill: SkillView | undefined): string {
  if (!skill) return "";
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  return `<div class="skill-meta" data-skill="${esc(skill.id)}" data-version="${esc(skill.version)}" data-integrity="${esc(skill.integrity)}" data-size="${skill.size}">
  <dl>
    <div><dt>Latest</dt><dd data-field="version">v${esc(skill.version)}</dd></div>
    <div><dt>Permissions</dt><dd>${skill.permissionSummary.map(esc).join("<br>")}</dd></div>
    <div><dt>SHA-256</dt><dd><code>${esc(skill.integrity)}</code></dd></div>
    <div><dt>Verification</dt><dd>${skill.verification.checks.length ? (skill.verification.verified ? "passed (" + skill.verification.checks.filter((c) => c.status === "passed").map((c) => c.id).join(", ") + ")" : "failed") : "not run"}</dd></div>
    <div><dt>Install</dt><dd><code>splice add ${esc(skill.id)}${skill.permissionSummary[0]?.startsWith("none") ? "" : " --accept-permissions"}</code></dd></div>
  </dl>
  <button type="button" class="link-button" data-verify-browser>Verify SHA-256 in your browser</button>
  <output class="verify-result" data-verify-result></output>
</div>`;
}

interface BuildArgs {
  registry: string;
  out: string;
  docsOut: string;
  siteUrl: string;
  docsUrl: string;
  snapshot?: string;
  verify: boolean;
}

function parseArgs(argv: string[]): BuildArgs {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const args: BuildArgs = {
    registry: get("--registry") ?? process.env.SPLICE_REGISTRY ?? PRODUCTION_REGISTRY,
    out: resolve(get("--out") ?? join(here, "dist")),
    docsOut: resolve(get("--docs-out") ?? join(here, "dist-docs")),
    siteUrl: get("--site-url") ?? process.env.SITE_URL ?? DEFAULT_SITE_URL,
    docsUrl: get("--docs-url") ?? process.env.DOCS_URL ?? DEFAULT_DOCS_URL,
    verify: !argv.includes("--no-verify"),
  };
  const snapshot = get("--snapshot");
  if (snapshot) args.snapshot = resolve(snapshot);
  return args;
}

export interface BuildResult {
  /** The site (landing) output. */
  out: string;
  files: string[];
  /** The docs host output (docs and skill pages). */
  docsOut: string;
  docsFiles: string[];
  snapshot: RegistrySnapshot;
}

export interface BuildOptions {
  registry: string;
  out: string;
  docsOut: string;
  siteUrl: string;
  docsUrl: string;
  snapshot?: RegistrySnapshot;
  verify?: boolean;
}

/** Writes files under one output directory and records their paths. */
function outputDir(out: string) {
  const files: string[] = [];
  rmSync(out, { recursive: true, force: true });
  const write = (rel: string, content: string) => {
    const full = join(out, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    files.push(rel);
  };
  const copy = (from: string, rel: string) => {
    mkdirSync(dirname(join(out, rel)), { recursive: true });
    copyFileSync(from, join(out, rel));
    files.push(rel);
  };
  return { files, write, copy };
}

/** Styles, script, fonts, favicon and headers: each host serves its own copy. */
function copyCommonAssets(target: ReturnType<typeof outputDir>): void {
  for (const asset of ["styles.css", "app.js"]) target.copy(join(here, "public", asset), `assets/${asset}`);
  target.copy(join(here, "public", "favicon.svg"), "favicon.svg");
  // HTTP headers for static hosts that read a _headers file (Cloudflare, Netlify): frame-ancestors etc.
  target.copy(join(here, "public", "_headers"), "_headers");
  for (const font of readdirSync(join(here, "public", "fonts"))) target.copy(join(here, "public", "fonts", font), `assets/fonts/${font}`);
}

const sitemap = (base: string, paths: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${paths.map((p) => `  <url><loc>${base}/${p}</loc></url>`).join("\n")}\n</urlset>\n`;

export async function buildSite(options: BuildOptions): Promise<BuildResult> {
  const snapshot = options.snapshot ?? (await loadSnapshot(options.registry, { verify: options.verify ?? true }));
  const assetHash = createHash("sha256");
  for (const name of ["styles.css", "app.js"]) assetHash.update(readFileSync(join(here, "public", name)));
  const config: SiteConfig = { siteUrl: options.siteUrl, docsUrl: options.docsUrl, registry: snapshot.registry, githubUrl: GITHUB_URL, assetVersion: assetHash.digest("hex").slice(0, 10) };
  const siteBase = options.siteUrl.replace(/\/$/, "");
  const docsBase = options.docsUrl.replace(/\/$/, "");

  // ---- the site: landing page, hero media, registry snapshot
  const site = outputDir(options.out);
  site.write("index.html", renderLanding(config, { snapshot, providers: loadProviders(), capabilities: BROKER_CAPABILITIES }, SKILL_PAGES));
  site.write("404.html", renderNotFound(config, "site"));
  copyCommonAssets(site);
  // Hero video (licensed stock footage, graded; see public/media/CREDITS.md) and its poster.
  for (const media of readdirSync(join(here, "public", "media"))) site.copy(join(here, "public", "media", media), `assets/media/${media}`);
  site.write("data/registry.json", JSON.stringify(snapshot, null, 2) + "\n");
  // Earlier docs URLs on the site (spliceloom.com/docs/…, /skills/…) move to the docs host.
  site.write("_redirects", [`/docs ${docsBase}/ 301`, `/docs/introduction ${docsBase}/ 301`, `/docs/:slug ${docsBase}/:slug 301`, `/skills/:name ${docsBase}/skills/:name 301`, ""].join("\n"));
  site.write("robots.txt", `User-agent: *\nAllow: /\n\nSitemap: ${siteBase}/sitemap.xml\n`);
  site.write("sitemap.xml", sitemap(siteBase, [""]));

  // ---- the docs host: docs at the root (introduction is its home page), skill pages under skills/
  const docs = outputDir(options.docsOut);
  const searchIndex: Array<{ t: string; u: string; g: string; h: string[]; x: string }> = [];
  const groupOf = (key: string) => DOC_NAV.find((g) => g.items.some((i) => i.slug === key))?.title ?? "Docs";
  const fileOf = (path: string) => (path === "" ? "index.html" : `${path}.html`);
  const docPaths: string[] = [];
  for (const slug of PUBLISHED_DOCS) {
    const source = readFileSync(join(REPO, "docs", `${slug}.md`), "utf8");
    const { loc, path, self } = docLoc("docs", slug);
    const rendered = renderMarkdown(source, { rewriteLink: linkRewriter("docs", self, (target) => href(config, loc, target)) });
    searchIndex.push({ t: rendered.title || slug, u: path, g: groupOf(slug), h: rendered.headings.filter((h) => h.level === 2).map((h) => `${h.text}#${h.id}`), x: plainText(source).slice(0, 600) });
    docs.write(fileOf(path), renderDocPage(config, { slug, title: rendered.title || slug, description: descriptionOf(source), html: rendered.html, nav: DOC_NAV, headings: rendered.headings, section: "docs" }));
    if (!EXTRA_DOCS.includes(slug)) docPaths.push(path);
  }
  for (const name of SKILL_PAGES) {
    const source = readFileSync(join(REPO, "skills", name, "SKILL.md"), "utf8");
    const { loc, path, self } = docLoc("skills", name);
    const rendered = renderMarkdown(source, { rewriteLink: linkRewriter("skills", self, (target) => href(config, loc, target)) });
    const skill = snapshot.skills.find((s) => s.name === name);
    searchIndex.push({ t: rendered.title || name, u: path, g: "Official skills", h: rendered.headings.filter((h) => h.level === 2).map((h) => `${h.text}#${h.id}`), x: plainText(source).slice(0, 600) });
    docs.write(fileOf(path), renderDocPage(config, { slug: name, title: rendered.title || name, description: skill?.description ?? descriptionOf(source), html: rendered.html, nav: DOC_NAV, headings: rendered.headings, section: "skills", aside: skillAside(skill) }));
    docPaths.push(path);
  }
  docs.write("404.html", renderNotFound(config, "docs"));
  copyCommonAssets(docs);
  docs.write("assets/search-index.json", JSON.stringify(searchIndex));
  // docs.<domain>/docs/<page> and /introduction land on the clean docs URL.
  docs.write("_redirects", ["/introduction / 301", "/docs / 301", "/docs/introduction / 301", "/docs/:slug /:slug 301", ""].join("\n"));
  docs.write("robots.txt", `User-agent: *\nAllow: /\n\nSitemap: ${docsBase}/sitemap.xml\n`);
  docs.write("sitemap.xml", sitemap(docsBase, docPaths));

  return { out: options.out, files: site.files.sort(), docsOut: options.docsOut, docsFiles: docs.files.sort(), snapshot };
}

/** Where a logical page path is published (for tests and tooling): host and file. */
export function publishedFile(path: string): { host: "site" | "docs"; file: string } {
  const place = placeOf(path);
  const local = place.local;
  return { host: place.host ?? "site", file: local === "" ? "index.html" : `${local}.html` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  let snapshot: RegistrySnapshot | undefined;
  if (args.snapshot) {
    if (!existsSync(args.snapshot)) throw new Error(`snapshot not found: ${args.snapshot}`);
    snapshot = JSON.parse(readFileSync(args.snapshot, "utf8")) as RegistrySnapshot;
  }
  const buildOptions: BuildOptions = { registry: args.registry, out: args.out, docsOut: args.docsOut, siteUrl: args.siteUrl, docsUrl: args.docsUrl, verify: args.verify };
  if (snapshot) buildOptions.snapshot = snapshot;
  let result: BuildResult;
  try {
    result = await buildSite(buildOptions);
  } catch (error) {
    // The site never falls back to invented data: without registry data there is no build.
    const err = error as { message?: string; hint?: string };
    console.error(`site build failed: could not load registry data from ${args.registry}: ${err.message ?? String(error)}`);
    if (err.hint) console.error(`hint: ${err.hint}`);
    console.error("Retry later, point --registry at another registry, or reuse a previous build's data with --snapshot apps/site/dist/data/registry.json.");
    process.exit(1);
  }
  console.log(`built ${result.files.length} files into ${result.out} (${args.siteUrl})`);
  console.log(`built ${result.docsFiles.length} files into ${result.docsOut} (${args.docsUrl})`);
  console.log(`registry data: ${result.snapshot.registry} (${result.snapshot.generatedAt})`);
  for (const s of result.snapshot.skills) console.log(`  ${s.id}@${s.version}  ${s.verification.checks.length ? (s.verification.verified ? "verified" : "VERIFICATION FAILED") : "not verified"}`);
}
