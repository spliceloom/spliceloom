/**
 * Website and documentation tests:
 * - the Markdown renderer;
 * - every relative link (and #anchor) in the Markdown docs resolves;
 * - every `splice …` command and option shown in the docs exists in the CLI;
 * - the site build against a real (local) registry: registry data, verification, links, SEO files,
 *   and no secrets or admin endpoints in the output;
 * - the npm package contents check.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { COMMAND_OPTIONS, GLOBAL_OPTIONS } from "../../../packages/cli/dist/cli.js";
import { packDirectory } from "../../../packages/core/dist/index.js";
import { openLocalRegistry, serveRegistry, type RunningServer } from "../../registry/dist/node.js";
import type { RegistryService } from "../../registry/dist/index.js";
import { buildSite, DOC_SOURCES, PRIVATE_DOCS, PUBLISHED_DOCS, SKILL_PAGES, type BuildResult } from "../build.ts";
import { renderInline, renderMarkdown, slugify } from "../src/markdown.ts";
import { OFFICIAL_SKILLS } from "../src/registry.ts";
// @ts-expect-error — plain ESM script without type declarations
import { checkPackFiles, isShippedFile } from "../../../scripts/pack-cli.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../../..");

/** Markdown files that make up the documentation. */
function markdownFiles(): string[] {
  const files = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "packages/cli/README.md", "examples/agent/README.md", "examples/agent-composition/README.md"];
  for (const f of readdirSync(join(REPO, "docs"))) if (f.endsWith(".md")) files.push(`docs/${f}`);
  for (const s of readdirSync(join(REPO, "skills"), { withFileTypes: true })) if (s.isDirectory() && existsSync(join(REPO, "skills", s.name, "SKILL.md"))) files.push(`skills/${s.name}/SKILL.md`);
  return files.filter((f) => existsSync(join(REPO, f)));
}

/** Markdown with fenced code blocks removed (links inside code are not links). */
function withoutCode(md: string): string {
  return md.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}

describe("markdown renderer", () => {
  it("renders headings with GitHub-style ids, paragraphs, lists, tables and code", () => {
    const { html, title, headings } = renderMarkdown(
      "# Title\n\nIntro with `code`, **bold**, *em* and [a link](other.md#x).\n\n## Integrity is not authenticity\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n| A | B |\n| --- | --- |\n| `x \\| y` | 2 |\n\n```sh\nsplice init <dir>\n```\n\n> note\n",
    );
    assert.equal(title, "Title");
    assert.deepEqual(headings.map((h) => h.id), ["title", "integrity-is-not-authenticity"]);
    assert.match(html, /<p>Intro with <code>code<\/code>, <strong>bold<\/strong>, <em>em<\/em> and <a href="other\.md#x">a link<\/a>\.<\/p>/);
    assert.match(html, /<ul><li>one<\/li><li>two<ul><li>nested<\/li><\/ul><\/li><\/ul>/);
    assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
    assert.match(html, /<td><code>x \| y<\/code><\/td><td>2<\/td>/);
    assert.match(html, /<pre class="code" data-lang="sh"><code>splice init &lt;dir&gt;<\/code><\/pre>/);
    assert.match(html, /<blockquote><p>note<\/p><\/blockquote>/);
  });

  it("escapes HTML and never passes raw HTML or javascript: links through", () => {
    const html = renderMarkdown('<script>alert(1)</script>\n\n[x](javascript:alert(1)) "quote"').html;
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;/);
    const rewritten = renderInline("[x](javascript:alert(1))", { rewriteLink: (h) => (/^https?:|^#|\.html/.test(h) ? h : null) });
    assert.doesNotMatch(rewritten, /href/);
    assert.equal(renderInline("snake_case_name and _em_"), "snake_case_name and <em>em</em>");
  });

  it("slugifies like GitHub", () => {
    assert.equal(slugify("Installed files (Phase 8)"), "installed-files-phase-8");
    assert.equal(slugify("`splice.lock`"), "splicelock");
    assert.equal(slugify("Why there is no process execution skill"), "why-there-is-no-process-execution-skill");
  });
});

describe("documentation", () => {
  it("every relative link and anchor in the docs resolves", () => {
    const problems: string[] = [];
    for (const file of markdownFiles()) {
      const md = readFileSync(join(REPO, file), "utf8");
      for (const match of withoutCode(md).matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const href = match[1]!;
        if (/^(https?:|mailto:)/.test(href)) continue;
        const [path, anchor] = href.split("#") as [string, string | undefined];
        const target = path === "" ? join(REPO, file) : resolve(dirname(join(REPO, file)), path);
        if (!existsSync(target)) {
          problems.push(`${file}: ${href} (missing file)`);
          continue;
        }
        if (anchor && target.endsWith(".md")) {
          const ids = renderMarkdown(readFileSync(target, "utf8")).headings.map((h) => h.id);
          if (!ids.includes(anchor)) problems.push(`${file}: ${href} (missing anchor #${anchor})`);
        }
      }
    }
    assert.deepEqual(problems, []);
  });

  it("every documented `splice` command and option exists in the CLI", () => {
    const commands = new Set([...Object.keys(COMMAND_OPTIONS), "help"]);
    const problems: string[] = [];
    const checkSegment = (file: string, raw: string) => {
      const segment = raw.trim().replace(/^\$\s+/, "").replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, "");
      if (!/^splice(\s|$)/.test(segment)) return;
      const tokens = segment.split(/\s+/).filter((t) => !/^(#|\/\/)/.test(t));
      const commentAt = tokens.findIndex((t) => t === "#");
      const words = commentAt >= 0 ? tokens.slice(0, commentAt) : tokens;
      const command = words[1];
      // Placeholders (<command>, …) and prose/diagrams ("splice CLI ──▶ …") are not invocations.
      if (command === undefined || (!command.startsWith("-") && !/^[a-z][a-z-]*$/.test(command))) return;
      if (command.startsWith("-")) {
        const name = command.replace(/^--?/, "").split("=")[0]!;
        if (!["h", "v", ...GLOBAL_OPTIONS].includes(name)) problems.push(`${file}: "${segment}" (unknown global option ${command})`);
        return;
      }
      if (!commands.has(command)) {
        problems.push(`${file}: "${segment}" (unknown command ${command})`);
        return;
      }
      const allowed = [...(COMMAND_OPTIONS[command] ?? []), ...GLOBAL_OPTIONS, "h", "v"];
      for (const token of words.slice(2)) {
        if (!token.startsWith("--") || token === "--") continue;
        const name = token.slice(2).split("=")[0]!.replace(/[`'",.)]+$/, "");
        if (name && !allowed.includes(name)) problems.push(`${file}: "${segment}" (option --${name} is not valid for ${command})`);
      }
    };
    for (const file of markdownFiles()) {
      const md = readFileSync(join(REPO, file), "utf8");
      for (const block of md.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
        const text = block[1]!.replace(/\\\n\s*/g, " ");
        for (const line of text.split("\n")) for (const part of line.split(/&&|;|\|\|/)) checkSegment(file, part);
      }
      for (const inline of withoutCodeBlocks(md).matchAll(/`(splice [^`]+)`/g)) checkSegment(file, inline[1]!);
    }
    assert.deepEqual(problems, []);
  });

  it("the site publishes user documentation, never operator/admin documentation", () => {
    for (const slug of PUBLISHED_DOCS) assert.ok(existsSync(join(REPO, DOC_SOURCES[slug] ?? join("docs", `${slug}.md`))), slug);
    for (const slug of PRIVATE_DOCS) assert.ok(!PUBLISHED_DOCS.includes(slug), slug);
    for (const required of ["getting-started", "cli", "sdk", "mcp", "skills", "authoring-skills", "permissions", "security", "architecture", "publishing", "faq", "api", "releasing"]) {
      assert.ok(PUBLISHED_DOCS.includes(required), required);
    }
  });
});

function withoutCodeBlocks(md: string): string {
  return md.replace(/```[\s\S]*?```/g, "");
}

describe("website build against a registry", () => {
  let root: string;
  let service: RegistryService;
  let server: RunningServer;
  let result: BuildResult;
  const read = (rel: string) => readFileSync(join(result.out, rel), "utf8");
  const readDocs = (rel: string) => readFileSync(join(result.docsOut, rel), "utf8");
  const docFile = (slug: string) => (slug === "introduction" ? "index.html" : `${slug}.html`);

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "splice-site-"));
    service = openLocalRegistry(join(root, "registry"));
    const publisher = await service.createUser("splice");
    await service.setNamespaceOwner("splice", "splice");
    for (const id of OFFICIAL_SKILLS) await service.publish((await packDirectory(join(REPO, "skills", id.split("/")[1]!))).bytes, publisher);
    server = await serveRegistry({ service, port: 0 });
    result = await buildSite({ registry: server.url, out: join(root, "dist"), docsOut: join(root, "dist-docs"), siteUrl: "https://example.test", docsUrl: "https://docs.example.test" });
  });

  after(async () => {
    await server.close();
    await service.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("builds the landing page, docs, skill pages and public metadata files", () => {
    for (const file of ["index.html", "404.html", "robots.txt", "sitemap.xml", "favicon.svg", "_redirects", "assets/styles.css", "assets/app.js", "assets/fonts/Geist-Variable.woff2", "assets/fonts/GeistMono-Variable.woff2", "assets/fonts/OFL.txt", "assets/media/hero-1600.mp4", "data/registry.json"]) {
      assert.ok(result.files.includes(file), file);
    }
    // Docs and skill pages live on the docs host: docs at its root (introduction = home), skills under skills/.
    for (const file of ["index.html", "404.html", "robots.txt", "sitemap.xml", "favicon.svg", "_redirects", "assets/styles.css", "assets/app.js", "assets/search-index.json", "assets/fonts/Geist-Variable.woff2"]) assert.ok(result.docsFiles.includes(file), `docs: ${file}`);
    for (const slug of PUBLISHED_DOCS) assert.ok(result.docsFiles.includes(docFile(slug)), slug);
    for (const name of SKILL_PAGES) assert.ok(result.docsFiles.includes(`skills/${name}.html`), name);
    assert.ok(!result.files.some((f) => f.startsWith("docs/") || f.startsWith("skills/")), "no docs pages on the site host");
    // Site pages: skills registry, brand kit, blog; demo videos on both hosts; changelog in the docs.
    for (const file of ["registry.html", "brand.html", "blog.html", "blog/introducing-splice.html", "assets/video/how-it-works.mp4", "assets/video/how-it-works.jpg", "assets/brand/splice-mark.svg", "assets/brand/splice-avatar.png"]) assert.ok(result.files.includes(file), file);
    for (const file of ["changelog.html", "assets/video/tokens.mp4"]) assert.ok(result.docsFiles.includes(file), `docs: ${file}`);
    const home = read("index.html");
    assert.match(home, /class="news-pill" href="https:\/\/docs\.example\.test\/changelog"/);
    assert.match(home, /<section class="section section-rule" id="watch"[\s\S]*?<video controls playsinline preload="none"/);
    assert.match(home, /id="why"[\s\S]*?With Splice/);
    assert.doesNotMatch(home, /<video[^>]*autoplay(?![^>]*hero-video)[^>]*controls/, "demo videos never autoplay");
    assert.match(readDocs("quickstart.html"), /assets\/video\/how-it-works\.mp4/);
    assert.match(readDocs("markets.html"), /assets\/video\/tokens\.mp4[\s\S]*assets\/video\/research\.mp4/);
    const post = read("blog/introducing-splice.html");
    assert.match(post, /<h1 class="display">Introducing Splice<\/h1>/);
    assert.match(post, /href="https:\/\/docs\.example\.test\/quickstart"/, "blog links reach the docs host");
    assert.doesNotMatch(post, /@video/);
    assert.match(read("registry.html"), /data-copy="splice add @splice\/github --accept-permissions"/);
    assert.match(read("registry.html"), /data-copy="splice add @splice\/json"/, "no --accept-permissions when nothing is requested");
    assert.match(read("brand.html"), /#A8C1D9/);
    assert.match(read("sitemap.xml"), /<loc>https:\/\/example\.test\/blog\/introducing-splice<\/loc>/);
    assert.match(read("_redirects"), /^\/docs\/:slug https:\/\/docs\.example\.test\/:slug 301$/m);
    assert.match(read("_redirects"), /^\/skills\/:name https:\/\/docs\.example\.test\/skills\/:name 301$/m);
    const index = read("index.html");
    assert.match(index, /<title>Splice — The Composable Layer for Autonomous Agents<\/title>/);
    assert.match(index, /<meta name="description" content="Splice gives autonomous agents reusable capabilities/);
    assert.match(index, /<meta property="og:site_name" content="Splice">/);
    assert.match(index, /<meta name="twitter:card" content="summary_large_image">/);
    assert.match(index, /<meta property="og:image" content="https:\/\/example\.test\/assets\/og-landing\.png">/);
    assert.match(readDocs("cli.html"), /<meta property="og:image" content="https:\/\/docs\.example\.test\/assets\/og-docs\.png">/);
    assert.ok(result.files.includes("assets/og-landing.png") && result.docsFiles.includes("assets/og-docs.png"), "each host serves its own social image");
    assert.match(index, /<link rel="canonical" href="https:\/\/example\.test\/">/);
    assert.match(index, /<script type="application\/ld\+json">/);
    assert.match(index, /Content-Security-Policy/);
    assert.match(index, /<h1 id="hero-title">The composable layer <br>for autonomous agents\.<\/h1>/);
    // Cinematic hero: a real, muted, looping, inline video (sources set by script), no terminal or providers in it.
    const hero = index.slice(index.indexOf('<section class="hero"'), index.indexOf("</section>", index.indexOf('<section class="hero"')));
    assert.match(hero, /<video class="hero-video"[^>]* muted loop playsinline[^>]*preload="none"/);
    for (const media of ["hero-1600.mp4", "hero-960.mp4", "hero-poster.jpg", "CREDITS.md"]) assert.ok(result.files.includes(`assets/media/${media}`), media);
    assert.match(read("assets/styles.css"), /url\("media\/hero-poster\.jpg"\)/);
    assert.match(hero, /Splice <span aria-hidden="true">\/<\/span> Composable agent infrastructure/);
    assert.match(hero, /Chain ID 4663/);
    assert.doesNotMatch(hero, /data-terminal|p-name|Alchemy|Tavily|Exa|OpenRouter|CoinGecko/, "no terminal or provider names in the hero");
    assert.match(index, /<h2 id="cli-title">From capability to execution\.<\/h2>/);
    assert.match(index, /<h2 id="cap-title">Connect agents to real capabilities\.<\/h2>/);
    assert.match(index, /<h2 id="cta-title">Give your agents capabilities\.<\/h2>/);
    assert.match(index, /The initial onchain environment Splice is built around\./);
    assert.doesNotMatch(index, /Spliceloom|SpliceLoom/, "the brand on the website is Splice (spliceloom only in domain, npm scope, accounts)");
    // The website never names audience segments.
    assert.doesNotMatch(index, /\b(traders?|whales?|degens?|researchers?|investors?)\b/i);
    // Terminal scenes of real CLI output.
    for (const scene of ["chain", "tokens", "stocks", "perps", "defi", "research", "ask"]) assert.ok(index.includes(`data-scene="${scene}"`), scene);
    // No invented metrics, customers or partnership claims; Robinhood independence is stated.
    assert.doesNotMatch(index, /\d[\d,.]*\s*[kKmM]?\+\s*(developers|agents|skills|users|downloads)|testimonial|trusted by|official partner/i);
    assert.match(index, /not affiliated with, endorsed by or sponsored by Robinhood Markets, Inc\./);
    assert.match(index, /Splice is not the blockchain\./);
    // Providers come from the data layer, verified ones only.
    for (const name of ["Alchemy", "QuickNode", "Blockscout", "CoinGecko", "DexScreener", "GeckoTerminal", "GoPlus", "Zerion", "OpenRouter", "Gemini", "Tavily", "Exa", "Firecrawl"]) assert.match(index, new RegExp(`<span class="p-name">${name}</span>`), name);
    assert.doesNotMatch(index, /<span class="p-name">(The Graph|Robinhood)/, "unverified providers are not listed");
    // The terminal shows the registry's real version and hash of @splice/github.
    // The terminal (second section) replays recorded Robinhood Chain output and installs a skill
    // whose version and hash are the registry's (@splice/onchain when published, else @splice/github).
    const installed = result.snapshot.skills.find((s) => s.id === "@splice/onchain") ?? result.snapshot.skills.find((s) => s.id === "@splice/github")!;
    assert.ok(index.includes(`<span class="t-ok">Installed</span> <strong>${installed.id}@${installed.version}</strong>`));
    assert.ok(index.includes(installed.integrity.slice(0, 31)), "terminal hash comes from the registry");
    for (const command of ["splice chain info", "splice block latest", "splice price ETH"]) assert.ok(index.includes(`<span class="t-cmd">${command}</span>`), command);
    assert.match(index, /chainIdMatches/);
    assert.ok(index.indexOf('id="cli"') < index.indexOf('id="platform"'), "the terminal section follows the hero");
    assert.match(index, /<span class="lights" aria-hidden="true"><i><\/i><i><\/i><i><\/i><\/span>/);
    assert.match(index, /href="https:\/\/docs\.example\.test\/quickstart"/, "the landing page links to the docs host");
    const search = JSON.parse(readDocs("assets/search-index.json")) as Array<{ t: string; u: string }>;
    assert.ok(search.some((p) => p.u === "robinhood-chain") && search.some((p) => p.u === "skills/github") && search.some((p) => p.u === ""));
    assert.match(read("robots.txt"), /Sitemap: https:\/\/example\.test\/sitemap\.xml/);
    assert.match(readDocs("robots.txt"), /Sitemap: https:\/\/docs\.example\.test\/sitemap\.xml/);
    assert.match(readDocs("sitemap.xml"), /<loc>https:\/\/docs\.example\.test\/getting-started<\/loc>/);
    assert.match(readDocs("sitemap.xml"), /<loc>https:\/\/docs\.example\.test\/skills\/github<\/loc>/);
    assert.doesNotMatch(readDocs("sitemap.xml") + read("sitemap.xml"), /\.html|#/);
    assert.match(readDocs("cli.html"), /<link rel="canonical" href="https:\/\/docs\.example\.test\/cli">/);
    assert.match(readDocs("index.html"), /<link rel="canonical" href="https:\/\/docs\.example\.test\/">/);
    assert.match(readDocs("cli.html"), /<a class="brand" href="https:\/\/example\.test\/"/, "the docs host links home to the site");
  });

  it("shows official skills from the registry: versions, permissions, tools and real verification results", () => {
    const index = read("index.html");
    for (const skill of result.snapshot.skills) {
      const manifest = JSON.parse(readFileSync(join(REPO, "skills", skill.name, "manifest.json"), "utf8"));
      assert.equal(skill.version, manifest.version, `${skill.id} version comes from the registry`);
      assert.match(index, new RegExp(`data-skill="${skill.id.replace("/", "\\/")}" data-version="${manifest.version.replace(/\./g, "\\.")}"`));
      assert.equal(skill.verification.verified, true, JSON.stringify(skill.verification.checks));
      assert.deepEqual(skill.tools.map((t) => t.name), manifest.tools.map((t: { name: string }) => `${manifest.name}.${t.name}`));
    }
    assert.match(index, /no permissions/);
    assert.match(index, /network: public hosts/);
    assert.match(index, /network: api\.github\.com/);
    assert.match(index, /files: workspace\//);
    assert.match(index, /verified: sha256, size, package, metadata/);
    const data = JSON.parse(read("data/registry.json"));
    assert.equal(data.registry, server.url.replace(/\/$/, ""));
  });

  it("every internal link is a clean URL (no .html, no #) and resolves, including its data-section", () => {
    const problems: string[] = [];
    const hosts = [
      { out: result.out, base: "https://example.test/", files: result.files },
      { out: result.docsOut, base: "https://docs.example.test/", files: result.docsFiles },
    ];
    for (const { out, base: hostBase, files } of hosts)
    for (const file of files.filter((f) => f.endsWith(".html"))) {
      const html = readFileSync(join(out, file), "utf8");
      const label = `${hostBase}${file}`;
      // Header links point at landing-page sections (checked on index.html), not at the current page's.
      const headerTags = new Set((/<header class="site-header[\s\S]*?<\/header>/.exec(html)?.[0] ?? "").match(/<a\b[^>]*>/g) ?? []);
      for (const match of html.matchAll(/<a\b[^>]*>/g)) {
        const tag = match[0];
        let href = /\shref="([^"]*)"/.exec(tag)?.[1]?.replace(/&amp;/g, "&");
        if (href === undefined || /^mailto:/.test(href)) continue;
        // Absolute links to either host must resolve in that host's output.
        let root = dirname(join(out, file));
        const other = hosts.find((h) => href!.startsWith(h.base));
        if (other) {
          root = other.out;
          href = href.slice(other.base.length) || "./";
        } else if (/^https?:/.test(href)) continue;
        else if (href.startsWith("/")) {
          // root-relative (the 404 page, served at any depth)
          root = out;
          href = href.slice(1) || "./";
        }
        if (/#|\.html$/.test(href)) problems.push(`${label}: ${href} (not a clean URL)`);
        // Clean URLs resolve like the host does: cli → cli.html, ./ → index.html.
        const base = resolve(root, href);
        const target = href === "./" || href === "../" || href.endsWith("/") ? join(base, "index.html") : existsSync(`${base}.html`) ? `${base}.html` : base;
        if (!existsSync(target)) {
          problems.push(`${label}: ${href}`);
          continue;
        }
        const section = /\sdata-section="([^"]+)"/.exec(tag)?.[1];
        // data-local sections live on the landing page; elsewhere the link simply opens the page.
        const sectionPage = /\sdata-local/.test(tag) ? null : target;
        if (section && sectionPage && target.endsWith(".html") && !readFileSync(sectionPage, "utf8").includes(`id="${section}"`)) problems.push(`${label}: ${href} → ${section} (section)`);
        const onThisPage = (out === result.out && file === "index.html") || (target === join(out, file) && !headerTags.has(tag));
        if (section && /\sdata-local/.test(tag) && onThisPage && !html.includes(`id="${section}"`)) problems.push(`${label}: ${href} → ${section} (section on this page)`);
      }
      for (const match of html.matchAll(/\ssrc="([^"]+)"/g)) {
        if (!/^(https?:|data:)/.test(match[1]!) && !existsSync(match[1]!.startsWith("/") ? join(out, match[1]!.replace(/\?v=[0-9a-f]+$/, "")) : resolve(dirname(join(out, file)), match[1]!.replace(/\?v=[0-9a-f]+$/, "")))) problems.push(`${label}: src ${match[1]}`);
      }
      // assets carry a content version so a deploy is never hidden by the browser cache
      if (!/assets\/styles\.css\?v=[0-9a-f]{10}"/.test(html) || !/assets\/app\.js\?v=[0-9a-f]{10}"/.test(html)) problems.push(`${label}: unversioned assets`);
    }
    assert.deepEqual(problems, []);
    // Markdown deep links keep their section without a "#".
    assert.match(readDocs("faq.html"), /href="security" data-section="integrity-is-not-authenticity"/);
  });

  it("contains no secrets, tokens, admin endpoints or local paths", () => {
    const problems: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else {
          const text = readFileSync(full, "utf8");
          const rel = relative(result.out, full);
          for (const [label, re] of [
            ["registry token", /splice_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/],
            ["GitHub token", /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_/],
            ["private key", /BEGIN [A-Z ]*PRIVATE KEY/],
            ["admin API", /\/admin\/(users|tokens|artifacts|namespaces)/],
            ["admin token secret", /ADMIN_TOKEN_SHA256|SPLICE_ADMIN_TOKEN|\.dev\.admin-token|registry-admin-token/],
            ["Cloudflare secret", /CLOUDFLARE_API_TOKEN|account_id\s*=|database_id/],
            ["local path", /[A-Z]:\\\\?Users\\\\?|\/home\/[a-z]+\/|\/Users\/[A-Za-z]+\//],
            ["email address", /[A-Za-z0-9._%+-]+@(gmail|yahoo|outlook|hotmail)\.com/],
          ] as const) {
            if (re.test(text)) problems.push(`${rel}: ${label}`);
          }
        }
      }
    };
    walk(result.out);
    walk(result.docsOut);
    assert.deepEqual(problems, []);
  });
});

describe("npm package contents check", () => {
  it("accepts compiled runtime files only", () => {
    assert.equal(isShippedFile("dist/cli.js"), true);
    assert.equal(isShippedFile("dist/cli.d.ts"), true);
    assert.equal(isShippedFile("dist/cli.test.js"), false);
    assert.equal(isShippedFile("dist/cli.js.map"), false);
    assert.equal(isShippedFile("src/cli.ts"), false);
    const good = ["package.json", "README.md", "LICENSE", "dist/bin.js", "dist/cli.js", "node_modules/@spliceloom/runtime/package.json", "node_modules/@spliceloom/runtime/dist/host.mjs"];
    assert.deepEqual(checkPackFiles(good), []);
    const bad = [...good, ".env", "dist/cli.test.js", "src/cli.ts", "apps/registry/.dev.vars", "node_modules/@spliceloom/registry/dist/index.js", "dist/cli.js.map", "backups/d1.sql"];
    const problems = checkPackFiles(bad) as string[];
    for (const path of [".env", "dist/cli.test.js", "src/cli.ts", "apps/registry/.dev.vars", "node_modules/@spliceloom/registry/dist/index.js", "dist/cli.js.map", "backups/d1.sql"]) {
      assert.ok(problems.some((p) => p.includes(path)), `${path} flagged: ${problems.join("; ")}`);
    }
    assert.ok((checkPackFiles(["package.json"]) as string[]).some((p) => /dist\/bin\.js/.test(p)));
  });
});
