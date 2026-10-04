/**
 * HTML templates for the Splice website: landing page, documentation pages, skill pages.
 *
 * Brand: Splice. The `spliceloom` name is used only for the domain, the npm scope (`@spliceloom/*`),
 * and accounts. Product surfaces keep their technical names: the `splice`
 * CLI, the Splice runtime and registry, `@splice/*` official skills, `@spliceloom/*` npm packages.
 * Every number, package, version, hash and provider on these pages comes from the registry snapshot
 * or the code at build time; nothing is invented.
 */
import { escapeHtml } from "./markdown.ts";
import type { ProviderView } from "./providers.ts";
import type { RegistrySnapshot, SkillView } from "./registry.ts";

/** The official $SPLICE contract address, as announced on @spliceloom. */
export const TOKEN_CA = "0xe61717414b34d1f5a1E17F5a91a980A1f4Ef2806";

export const DEFAULT_AGENTS_URL = "https://agents.spliceloom.com";

export interface SiteConfig {
  /** Public base URL of the site (canonical links, sitemap, Open Graph). */
  siteUrl: string;
  /** Public base URL of the documentation host (docs and skill pages live there). */
  docsUrl: string;
  /** Public base URL of the agents host (the agent directory). */
  agentsUrl?: string;
  /** Registry API base URL used for live data in the browser. */
  registry: string;
  /** Public API (live chain data, the token, Ask) used by the live pages in the browser. */
  api?: string;
  /** Link for the GitHub call to action. */
  githubUrl: string;
  /** Content hash of styles.css + app.js, appended as ?v= so a deploy is never hidden by the cache. */
  assetVersion?: string;
}

export interface NavGroup {
  title: string;
  items: Array<{ slug: string; title: string }>;
}

export interface LandingData {
  snapshot: RegistrySnapshot;
  providers: ProviderView[];
  /** Host capabilities skills can declare (BROKER_CAPABILITIES). */
  capabilities: readonly string[];
}

const e = escapeHtml;

/**
 * Three hosts: the site (landing), the docs host (docs and skill pages) and the agents host (the
 * agent directory at its root, logical path `agents`). Templates use logical
 * paths — "" (home), `docs/<slug>`, `skills/<name>`, `assets/…` — and `href` turns them into clean
 * URLs: relative on the same host (`quickstart`, `../skills/json`), absolute across hosts
 * (`https://docs.spliceloom.com/quickstart`). Never `.html` or `#`: sections are reached through
 * `data-section`, scrolled to by app.js without changing the URL.
 */
export type Host = "site" | "docs" | "agents";
export interface PageLoc {
  host: Host;
  /** Directory of the page on its host ("", "skills" or "blog"; one level deep). */
  dir: "" | "skills" | "blog";
  /** Root-relative links (`/assets/…`): for the 404 page, served at any depth. */
  rooted?: boolean;
}

/** The host a logical path belongs to (null: the page's own host) and its path there. */
export function placeOf(path: string): { host: Host | null; local: string } {
  if (path === "docs" || path === "docs/introduction") return { host: "docs", local: "" };
  if (path === "agents") return { host: "agents", local: "" };
  if (path.startsWith("docs/")) return { host: "docs", local: path.slice("docs/".length) };
  if (path.startsWith("skills/")) return { host: "docs", local: path };
  if (path.startsWith("assets/") || path === "favicon.svg") return { host: null, local: path };
  return { host: "site", local: path };
}

const baseOf = (config: SiteConfig, host: Host) => (host === "docs" ? config.docsUrl : host === "agents" ? (config.agentsUrl ?? DEFAULT_AGENTS_URL) : config.siteUrl).replace(/\/$/, "");

export function href(config: SiteConfig, loc: PageLoc, path: string): string {
  const place = placeOf(path);
  const host = place.host ?? loc.host;
  if (host !== loc.host) return `${baseOf(config, host)}/${place.local}`;
  if (loc.rooted) return `/${place.local}`;
  return `${loc.dir ? "../" : ""}${place.local}` || "./";
}

/** Brand mark: two threads woven over and under — a loom crossing. */
export const LOGO = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
<path d="M6 11H8.5M13.5 11H26M6 21H18.5M23.5 21H26" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>
<path d="M11 6V18.5M11 23.5V26M21 6V8.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" opacity=".55"/>
<path d="M21 13.5V26" stroke="var(--accent)" stroke-width="2.4" stroke-linecap="round"/>
</svg>`;

const ARROW = `<svg class="arrow" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M5 11L11 5M6 5h5v5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function head(config: SiteConfig, loc: PageLoc, page: { title: string; description: string; path: string; jsonLd?: unknown; styleHashes?: string[] }): string {
  const canonical = `${baseOf(config, loc.host)}/${page.path}`;
  // Social preview: one image per host (landing / docs), absolute as crawlers require.
  const ogImage = `${baseOf(config, loc.host)}/assets/og-${loc.host === "docs" ? "docs" : "landing"}.png`;
  const ogAlt = loc.host === "docs" ? "Splice Docs — Quickstart, CLI, SDK, MCP, Skills, Security" : "Splice — the composable layer for autonomous agents";
  const a = (path: string) => href(config, loc, path);
  const registryOrigin = new URL(config.registry).origin;
  const apiOrigin = config.api ? ` ${new URL(config.api).origin}` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'${(page.styleHashes ?? []).map((h) => ` '${h}'`).join("")}; img-src 'self' data:; media-src 'self'; font-src 'self'; connect-src 'self' ${e(registryOrigin)}${e(apiOrigin)}; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="strict-origin-when-cross-origin">
<title>${e(page.title)}</title>
<meta name="description" content="${e(page.description)}">
<link rel="canonical" href="${e(canonical)}">
<meta name="theme-color" content="#050505">
<meta name="color-scheme" content="dark">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Splice">
<meta property="og:title" content="${e(page.title)}">
<meta property="og:description" content="${e(page.description)}">
<meta property="og:url" content="${e(canonical)}">
<meta property="og:image" content="${e(ogImage)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${e(ogAlt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${e(ogImage)}">
<meta name="twitter:image:alt" content="${e(ogAlt)}">
<meta name="twitter:site" content="@spliceloom">
<meta name="twitter:title" content="${e(page.title)}">
<meta name="twitter:description" content="${e(page.description)}">
<meta name="splice:registry" content="${e(config.registry)}">
<link rel="icon" href="${a("favicon.svg")}" type="image/svg+xml">
<link rel="preload" href="${a("assets/fonts/Geist-Variable.woff2")}" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="${a("assets/styles.css")}${config.assetVersion ? `?v=${e(config.assetVersion)}` : ""}">
<script src="${a("assets/app.js")}${config.assetVersion ? `?v=${e(config.assetVersion)}` : ""}" defer></script>
${page.jsonLd ? `<script type="application/ld+json">${JSON.stringify(page.jsonLd).replace(/</g, "\\u003c")}</script>` : ""}
</head>`;
}

function header(loc: PageLoc, current: "home" | "docs" | "skills", config: SiteConfig): string {
  const a = (path: string) => href(config, loc, path);
  const home = a("");
  // On the landing page these scroll to its sections (data-local); elsewhere they open the docs page.
  const link = (path: string, label: string, section?: string, active = false) =>
    `<a href="${a(path)}"${section ? ` data-section="${section}" data-local` : ""}${active ? ' aria-current="page"' : ""}>${label}</a>`;
  const docs = current !== "home";
  return `<header class="site-header${docs ? " is-docs" : ""}">
  <div class="shell header-inner">
    <a class="brand" href="${home}" aria-label="Splice home">${LOGO}<span class="wordmark">Splice</span></a>
    <nav class="main-nav" id="main-nav" aria-label="Main">
      ${link("docs/introduction", "Platform", "platform")}
      ${link("docs/skills", "Skills", "skills", current === "skills")}
      ${link("docs/capabilities", "Capabilities", "capabilities")}
      ${link("docs/robinhood-chain", "Robinhood Chain", "robinhood-chain")}
      ${link("docs/security", "Security", "security")}
      ${link("live", "Live")}
      ${link("docs/introduction", "Docs", undefined, current === "docs")}
      <div class="nav-extra"><a class="btn btn-ghost" href="${e(config.githubUrl)}" rel="noopener">GitHub</a><a class="btn btn-solid" href="${a("docs/quickstart")}">Get started</a></div>
    </nav>
    <div class="header-actions">
      ${docs ? `<button class="search-trigger" type="button" data-search-open aria-label="Search documentation"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span>Search</span><kbd>/</kbd></button>` : ""}
      <a class="nav-quiet" href="${e(config.githubUrl)}" rel="noopener">GitHub</a>
      <a class="btn btn-solid btn-sm" href="${a("docs/quickstart")}">Get started</a>
      <button class="menu-toggle" type="button" data-menu-toggle aria-expanded="false" aria-controls="main-nav" aria-label="Open menu"><span></span><span></span></button>
    </div>
  </div>
</header>`;
}

function footer(loc: PageLoc, config: SiteConfig): string {
  const d = (slug: string) => href(config, loc, `docs/${slug}`);
  const home = href(config, loc, "");
  return `<footer class="site-footer">
  <div class="shell">
    <div class="footer-top">
      <div class="footer-brand">
        <a class="brand" href="${home}">${LOGO}<span class="wordmark">Splice</span></a>
        <p>Infrastructure for composing capabilities into autonomous agents.</p>
      </div>
      <nav class="footer-cols" aria-label="Footer">
        <div><h2>Platform</h2><a href="${d("architecture")}">How it works</a><a href="${d("skills")}">Skills</a><a href="${d("capabilities")}">Capabilities</a><a href="${d("security")}">Security</a><a href="${d("public-registry")}">Registry</a></div>
        <div><h2>Developers</h2><a href="${d("quickstart")}">Quickstart</a><a href="${d("cli")}">CLI</a><a href="${d("sdk")}">TypeScript SDK</a><a href="${d("mcp")}">MCP</a><a href="${d("authoring-skills")}">Skill authoring</a></div>
        <div><h2>Tools</h2><a href="${href(config, loc, "live")}">Live chain data</a><a href="${href(config, loc, "stocks")}">Stock token premiums</a><a href="${href(config, loc, "screener")}">New token screener</a><a href="${href(config, loc, "wallet")}">Wallet viewer</a><a href="${href(config, loc, "explain")}">Contract explainer</a><a href="${href(config, loc, "ask")}">Ask</a><a href="${href(config, loc, "token")}">$SPLICE token</a><a href="${href(config, loc, "widgets")}">Widgets</a><a href="${href(config, loc, "bot")}">Telegram bot</a><a href="${href(config, loc, "agents")}">Agent directory</a></div>
        <div><h2>Data</h2><a href="${d("robinhood-chain")}">Robinhood Chain</a><a href="${d("data-providers")}">Providers</a><a href="${d("capabilities")}">Host capabilities</a><a href="${d("api")}">Registry API</a></div>
        <div><h2>Project</h2><a href="${href(config, loc, "blog")}">Blog</a><a href="${href(config, loc, "registry")}">Registry</a><a href="${href(config, loc, "docs/changelog")}">Changelog</a><a href="${href(config, loc, "brand")}">Brand</a><a href="${e(config.githubUrl)}" rel="noopener">GitHub</a><a href="https://x.com/spliceloom" rel="noopener">X (@spliceloom)</a><a href="${d("security")}">Security model</a><a href="${d("faq")}">FAQ</a><a href="${d("introduction")}">Documentation</a></div>
      </nav>
    </div>
    <div class="footer-meta">
      <p>Splice is an independent project. It is not affiliated with, endorsed by or sponsored by Robinhood Markets, Inc.; Robinhood Chain is referenced as a public network that Splice can read data from.</p>
      <p class="footer-notice">Official $SPLICE contract address: <code class="token-ca">${TOKEN_CA}</code> <button type="button" class="copy-inline" data-copy="${TOKEN_CA}">Copy</button><br>This is the only official contract, announced on spliceloom.com and <a href="https://x.com/spliceloom" rel="noopener">@spliceloom on X</a>. Any other token using the Splice name is not ours.</p>
      <p><span>MIT licensed</span><span>Developer preview</span><span>Registry <code>${e(new URL(config.registry).host)}</code></span><span class="health" data-registry-health><i aria-hidden="true"></i><span>Registry status</span></span></p>
    </div>
  </div>
</footer>`;
}

// ------------------------------------------------------------------------------------------ skills

function permissionBadges(skill: SkillView): string {
  const p = skill.permissions;
  const badges: string[] = [];
  if (p.network.includes("*")) badges.push(`<span class="chip chip-warn" title="Any public host; private and local addresses are refused">network: public hosts</span>`);
  for (const host of p.network.filter((h) => h !== "*")) badges.push(`<span class="chip" title="Network access to this host only">network: ${e(host)}</span>`);
  for (const path of p.fs.read.filter((x) => !p.fs.write.includes(x))) badges.push(`<span class="chip" title="Read files under this project path">read: ${e(path)}/</span>`);
  for (const path of p.fs.write) badges.push(`<span class="chip" title="Read and write files under this project path">files: ${e(path)}/</span>`);
  for (const name of p.env) badges.push(`<span class="chip chip-warn" title="Environment variable passed to the tool">env: ${e(name)}</span>`);
  for (const cap of p.capabilities ?? []) badges.push(`<span class="chip chip-cap" title="Host capability through the Splice broker: the host runs it with its own keys">capability: ${e(cap)}</span>`);
  if (badges.length === 0) badges.push(`<span class="chip chip-ok" title="No file, network, environment or capability access">no permissions</span>`);
  return badges.join("");
}

function verificationBadge(skill: SkillView): string {
  const v = skill.verification;
  if (v.checks.length === 0) return `<span class="verify verify-unknown">not verified</span>`;
  const passed = v.checks.filter((c) => c.status === "passed").map((c) => c.id);
  const title = v.checks.map((c) => `${c.id}: ${c.status} — ${c.message}`).join("\n");
  return v.verified
    ? `<span class="verify verify-ok" title="${e(title)}"><span class="dot"></span>verified: ${e(passed.join(", "))}</span>`
    : `<span class="verify verify-fail" title="${e(title)}"><span class="dot"></span>verification failed</span>`;
}

export function skillCard(skill: SkillView, link: (path: string) => string, hasPage: boolean): string {
  const name = hasPage ? `<a href="${link(`skills/${skill.name}`)}">${e(skill.id)}</a>` : e(skill.id);
  return `<article class="skill reveal" data-skill="${e(skill.id)}" data-version="${e(skill.version)}" data-integrity="${e(skill.integrity)}" data-size="${skill.size}">
  <header class="skill-head"><h3 class="mono">${name}</h3><span class="skill-version mono" data-field="version">v${e(skill.version)}</span></header>
  <p class="skill-desc" data-field="description">${e(skill.description)}</p>
  <dl class="skill-facts">
    <div><dt>Tools</dt><dd class="chips">${skill.tools.map((t) => `<code title="${e(t.description)}">${e(t.name)}</code>`).join("")}</dd></div>
    <div><dt>Permissions</dt><dd class="chips">${permissionBadges(skill)}</dd></div>
    <div><dt>Integrity</dt><dd><code class="hash" title="${e(skill.integrity)}">${e(skill.integrity.slice(0, 22))}…</code></dd></div>
  </dl>
  <footer class="skill-foot">
    ${verificationBadge(skill)}
    <button type="button" class="link-button" data-verify-browser>Verify SHA-256 in your browser</button>
    <output class="verify-result" data-verify-result></output>
  </footer>
</article>`;
}

// ------------------------------------------------------------------------------------------ landing content

/** Discover → Install → Grant capabilities → Compose → Run → Agent executes. Commands are real CLI commands. */
const STEPS: Array<[string, string, string]> = [
  ["Discover", "Search the registry. Every tool publishes its schema, permissions and description.", "splice search github"],
  ["Install", "Resolve, download and verify SHA-256 and size before a single file is written.", "splice add @splice/github"],
  ["Grant capabilities", "Files, hosts, environment and host capabilities need explicit consent, pinned in splice.lock.", "--accept-permissions"],
  ["Compose", "Chain structured outputs from one tool into the next — from the SDK or any MCP client.", "splice mcp --project ./agent"],
  ["Run", "Each call runs in its own restricted process. Undeclared access is denied.", "splice run github.search-repositories"],
  ["Agent executes", "The result returns as structured JSON, with its source, time and cache state attached.", "LIVE · CACHED · UNAVAILABLE"],
];

/** Skills presented first on the landing page; the rest of the registry follows. */
const FEATURED_SKILLS = ["@splice/robinhood", "@splice/onchain", "@splice/market", "@splice/web"];

/** The latest release, shown as a pill on the landing page (keep in step with CHANGELOG.md). */
export const WHATS_NEW = { label: "New", text: "Telegram bot · SEC filings · prediction-market odds", path: "bot" };

/** Demo videos (apps/site/public/video): real CLI recordings, no sound. */
export const VIDEOS: Record<string, { title: string; caption: string }> = {
  "how-it-works": { title: "How Splice works", caption: "Install, live data without keys, provider keys, verified skills, MCP and the SDK — real CLI output." },
  tokens: { title: "Tokens", caption: "Every token on Robinhood Chain: trending, new, gainers, details and large trades." },
  research: { title: "Research", caption: "Token reports, comparisons, a new-token radar and live alerts." },
  stocks: { title: "Stock tokens", caption: "Robinhood Stock Tokens from every source, side by side — plus company data and oracle candles." },
  markets: { title: "Markets", caption: "Perps and funding, DeFi, macro, global markets and the dashboard." },
  ask: { title: "Ask", caption: "An AI agent that answers from live data tools, with sources and cost." },
};

/** A demo video: plays on demand (no autoplay, no sound), poster first. */
export function videoFigure(config: SiteConfig, loc: PageLoc, name: string): string {
  const v = VIDEOS[name];
  if (!v) return "";
  const a = (p: string) => href(config, loc, p);
  return `<figure class="video-figure"><video controls playsinline preload="none" poster="${a(`assets/video/${name}.jpg`)}" aria-label="${e(v.title)}"><source src="${a(`assets/video/${name}.mp4`)}" type="video/mp4"></video><figcaption><strong>${e(v.title)}</strong> — ${e(v.caption)}</figcaption></figure>`;
}

/** Why Splice: calling providers directly vs through Splice (implemented behaviour only). */
const WHY_ROWS: Array<[string, string, string]> = [
  ["Keys", "Every agent and tool holds its own API keys.", "Keys stay in the host. A skill asks for a capability and gets the result, never the key."],
  ["Trust", "Install code and hope it is what you expect.", "SHA-256, size, package and provenance are verified before a file is written."],
  ["Isolation", "Tools run with all of your permissions.", "One sandboxed process per call, limited to the files, hosts and capabilities it declared."],
  ["Data", "Numbers without context.", "Every result is LIVE, CACHED, UNAVAILABLE or ERROR, with its source and fetch time."],
  ["Integration", "A new integration for every framework.", "One contract for the CLI, the TypeScript SDK and any MCP client."],
  ["Reproducibility", "Whatever version happens to be latest.", "Exact versions and hashes pinned in splice.lock; installs repeat byte for byte."],
];

/** Capability groups: broker capability prefixes and the provider domains that serve them. */
const CAPABILITY_GROUPS: Array<{ title: string; prefixes: string[]; domains: ProviderView["domain"][]; text: string; list?: string[] }> = [
  { title: "Web", prefixes: ["web."], domains: ["Web"], text: "Search, extraction, site maps and cited answers from the open web." },
  { title: "Market data", prefixes: ["market."], domains: ["Market"], text: "Every token on the chain, trending and new pools, prices, candles and trades, with the source on every value." },
  { title: "Stocks & macro", prefixes: [], domains: ["Stocks", "Macro"], text: "Tokenized US stocks next to the underlying quote, oracle candles, company news and the US macro calendar.", list: ["stock.tokens", "equity.quote", "equity.news", "oracle.candles", "macro.series"] },
  { title: "Perps & DeFi", prefixes: [], domains: ["Perps", "DeFi"], text: "Perpetual markets with open interest and funding, chain TVL, DEX volume, fees and yields.", list: ["perps.markets", "perps.funding", "defi.chain_tvl", "defi.dex_volume", "defi.yields"] },
  { title: "Onchain", prefixes: ["onchain.", "security.", "wallet."], domains: ["Onchain", "Security", "Wallet"], text: "Balances, transactions, blocks, contracts, logs, token risk and portfolios — chain ID verified first." },
  { title: "GitHub", prefixes: ["github."], domains: ["Developer"], text: "Repositories, search, contents, commits, releases and raw files." },
  { title: "AI models", prefixes: ["ai."], domains: ["AI"], text: "Text generation and model listings, run by the host with its own keys." },
];

const ROBINHOOD_FACTS: Array<[string, string]> = [
  ["Network", "Permissionless Layer 2 for financial services and tokenized real-world assets"],
  ["Technology", "Built on Arbitrum Layer 2 infrastructure, about 100 ms blocks"],
  ["Compatibility", "EVM-compatible: standard JSON-RPC, Solidity, existing tooling"],
  ["Chain ID", "4663 (mainnet) · gas paid in ETH"],
  ["Public RPC", "rpc.mainnet.chain.robinhood.com"],
  ["Explorer", "robinhoodchain.blockscout.com"],
];

/**
 * Live data output of the real CLI (`--no-color`), recorded against Robinhood Chain mainnet.
 * Lines are copied verbatim; omitted fields are marked with "…". Re-record when the CLI output changes.
 */
const CHAIN_RECORDING = {
  date: "2026-10-02",
  commands: [
    {
      cmd: "splice chain info",
      status: "chain  ● LIVE  source=alchemy  chain=robinhood(4663)  block=77793171",
      json: ['"name": "Robinhood Chain"', '"chainId": 4663', '"network": "mainnet"', '"verifiedChainId": 4663', '"chainIdMatches": true'],
    },
    {
      cmd: "splice block latest",
      status: "block  ● LIVE  source=alchemy  chain=robinhood(4663)  block=77793174",
      json: ['"number": "77793174"', '"time": "2026-10-02T00:10:10.000Z"', '"baseFeePerGas": "35860000"', '"transactionCount": 23'],
    },
    {
      cmd: "splice price ETH",
      status: "price  ● LIVE  source=coingecko  chain=robinhood(4663)",
      json: ['"asset": "ETH"', '"vs": "usd"', '"price": 2703.4'],
    },
  ],
};

/** `"key": value` with the key, strings and numbers coloured. */
function jsonLine(pair: string): string {
  const [, key, value] = /^("[^"]+"): (.*)$/.exec(pair) ?? ["", pair, ""];
  const kind = value.startsWith('"') ? "tj-s" : "tj-n";
  return `  <span class="tj-k">${e(key!)}</span>: <span class="${kind}">${e(value!)}</span>,`;
}

/** `name  ● LIVE  key=value …` status line of a live data command. */
function statusLine(text: string): string {
  const [left = "", right = ""] = text.split("● LIVE");
  const parts = right.split(/\s+/).filter(Boolean).map((p) => {
    if (!p.includes("=")) return e(p);
    const [k, v] = p.split("=");
    return `<span class="tk">${e(k!)}=</span>${e(v ?? "")}`;
  });
  return `<span class="tl-name">${e(left.trim())}</span>  <span class="t-live">● LIVE</span>  ${parts.join(" ")}  <span class="tk">…</span>`;
}

/**
 * More scenes of real CLI output, recorded on 2026-10-02 (UTC) with `--no-color`. Table rows keep
 * the printed values; some columns are left out to fit, and nothing is re-computed.
 */
const SCENE_RECORDINGS: Array<{ id: string; label: string; cmd: string; status?: string; rows: string[][]; after?: string[] }> = [
  {
    id: "tokens",
    label: "Tokens",
    cmd: "splice tokens trending --limit 5",
    status: "tokens trending  ● LIVE  source=codex  chain=robinhood(4663)",
    rows: [
      ["#", "TOKEN", "PRICE", "1H", "24H", "VOL 24H", "LIQUIDITY", "HOLDERS"],
      ["1", "PONS", "$0.4664", "-7.0%", "-10.6%", "$4.55M", "$1.26M", "101,726"],
      ["2", "CASHCAT", "$0.1657", "+0.0%", "-1.6%", "$2.81M", "$774K", "112,972"],
      ["3", "HOOKR", "$0.01702", "+13.1%", "-15.9%", "$1.33M", "$739K", "7,933"],
      ["4", "SPCX", "$159.0801", "+0.5%", "+6.4%", "$7.11M", "$1.73M", "112,624"],
      ["5", "RBD", "$0.007900", "+7.8%", "-0.3%", "$3.52M", "$65.5K", "7,993"],
    ],
    after: ["ranking: Codex trending score over h24; liquidity > $10,000; tokens flagged as potential scams excluded"],
  },
  {
    id: "stocks",
    label: "Stocks",
    cmd: "splice stock quote TSLA",
    rows: [
      ["robinhood", "token $372.84 / $372.89", "● LIVE"],
      ["finnhub", "$373.07  +5.4%  underlying stock", "● LIVE"],
      ["chainlink", "$372.98  (1m candle 19:31 UTC)", "● LIVE"],
      ["dex", "$372.59  24h +4.4%  liquidity $337K", "● LIVE"],
      ["codex", "$371.9486", "● LIVE"],
      ["defillama", "$372.125  confidence 0.995", "● LIVE"],
    ],
    after: ["Sources are shown separately and never averaged."],
  },
  {
    id: "perps",
    label: "Perps",
    cmd: "splice perps --limit 5",
    status: "perps markets  ● LIVE  source=lighter  · Lighter on Robinhood Chain · 85 markets · $650M 24h volume",
    rows: [
      ["MARKET", "PRICE", "24H", "VOL 24H", "OPEN INT"],
      ["BTC", "$84,077.00", "-0.6%", "$133M", "$24.7M"],
      ["ETH", "$2,664.66", "-1.2%", "$80.7M", "$30.8M"],
      ["XAU", "$4,151.91", "-0.7%", "$80.2M", "$13.8M"],
      ["SPY", "$770.06", "+0.7%", "$79.9M", "$48.7M"],
      ["QQQ", "$750.03", "+1.0%", "$76.7M", "$34.2M"],
    ],
  },
  {
    id: "defi",
    label: "DeFi",
    cmd: "splice defi",
    rows: [
      ["TVL", "$1.04B", "1d +2.7%", "7d +4.2%", "30d +38.6%"],
      ["DEX volume", "$1.53B 24h", "1d +1.6%", "$9.46B 7d", "113 DEXes"],
      ["Fees", "$4.92M 24h", "$34.9M 7d", "", "219 protocols"],
      ["Stablecoins", "$1.07B", "7d +0.3%", "", ""],
    ],
    after: ["source: defillama"],
  },
  {
    id: "research",
    label: "Research",
    cmd: "splice report PONS",
    rows: [
      ["▲ WARN", "top 10 holders own 50.8% (incl. pools/contracts)", "(goplus holders)"],
      ["• info", "LP tokens locked: 0.0%", "(goplus lp_holders)"],
      ["✓ ok", "verified source on Blockscout (PonsLauncherToken)", "(blockscout smart-contracts)"],
    ],
    after: ["price $0.4623 · vol 24h $4.50M · liquidity $1.24M · holders 101,696 · age 24d", "0 danger · 1 warnings · flags come from the named provider fields"],
  },
  {
    id: "ask",
    label: "Ask",
    cmd: 'splice ask "How does BTC and ETH funding on Lighter Robinhood compare to Binance?"',
    rows: [
      ["✓ perps_funding", "venue=robinhood search=BTC", "→ LIVE lighter"],
      ["✓ perps_funding", "venue=robinhood search=ETH", "→ LIVE lighter"],
      ["BTC", "Lighter 0.0096%", "Binance 0.004917%"],
      ["ETH", "Lighter 0.0096%", "Binance -0.002178%"],
    ],
    after: ["4 tool calls · sources: lighter · model openai/gpt-4o-mini · cost 0.002029 USD"],
  },
];

/** Aligned table rows with +/− percentages coloured. */
function sceneTable(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => [...(r[i] ?? "")].length)));
  // Tables with a header row right-align numbers; key/value scenes stay left-aligned.
  const header = rows.length > 2 && rows[0]!.every((c) => c === "" || c === "#" || /^[A-Z0-9 ]+$/.test(c));
  return rows.map((r, n) => {
    const cells = r.map((c, i) => {
      const numeric = header && n > 0 && /^[+\-]?\$?[\d,.]+[%KMB]?$/.test(c);
      const padded = numeric ? c.padStart(widths[i]!) : c.padEnd(widths[i]!);
      const html = e(padded);
      if (/^\s*\+[\d.]/.test(padded)) return `<span class="t-up">${html}</span>`;
      if (/^\s*-[\d.]/.test(padded)) return `<span class="t-down">${html}</span>`;
      if (/● LIVE|→ LIVE/.test(c)) return `<span class="t-live">${html}</span>`;
      if (c.startsWith("▲")) return `<span class="t-warn">${html}</span>`;
      if (c.startsWith("✓")) return `<span class="t-up">${html}</span>`;
      return header && n === 0 ? `<span class="tk">${html}</span>` : html;
    });
    return `  ${cells.join("  ")}`.trimEnd();
  });
}

function terminalSession(skills: SkillView[]): string {
  const skill = skills.find((s) => s.id === "@splice/onchain") ?? skills.find((s) => s.id === "@splice/github");
  const line = (kind: string, html: string) => `<span class="t-line tl-${kind}" data-kind="${kind}">${html}</span>`;
  const cmd = (text: string) => line("cmd", `<span class="t-path" aria-hidden="true">~/agent</span> <span class="t-prompt" aria-hidden="true">❯</span> <span class="t-cmd">${e(text)}</span>`);
  const sceneLines = (s: (typeof SCENE_RECORDINGS)[number]) => [
    cmd(s.cmd),
    ...(s.status ? [line("live", statusLine(s.status))] : []),
    ...sceneTable(s.rows).map((html) => line("out", html)),
    ...(s.after ?? []).map((a) => line("dim", `  ${e(a)}`)),
  ];
  const chainLines = [
    cmd("npm install -g @spliceloom/cli"),
    ...CHAIN_RECORDING.commands.flatMap((c) => [cmd(c.cmd), line("live", statusLine(c.status)), line("out", "{"), ...c.json.map((j) => line("out", jsonLine(j))), line("dim", "  …"), line("out", "}")]),
    ...(skill
      ? [
          cmd(`splice add ${skill.id} --accept-permissions`),
          line("dim", `Resolving ${e(skill.id)}...`),
          line("dim", `Downloading ${e(skill.id)}@${e(skill.version)}...`),
          line("dim", `Verifying ${e(skill.integrity.slice(0, 31))}…`),
          line("ok", `<span class="t-ok">Installed</span> <strong>${e(skill.id)}@${e(skill.version)}</strong>`),
          line("out", `  permissions: ${e(skill.permissionSummary.join("; "))}`),
          line("out", `  tools: ${e(skill.tools.map((t) => t.name).join(", "))}`),
        ]
      : []),
  ];
  const scenes = [{ id: "chain", label: "Chain", lines: chainLines }, ...SCENE_RECORDINGS.map((s) => ({ id: s.id, label: s.label, lines: sceneLines(s) }))];
  return `<div class="terminal" data-terminal>
  <div class="terminal-bar"><span class="lights" aria-hidden="true"><i></i><i></i><i></i></span><span class="terminal-title mono">~/agent — splice — robinhood(4663)</span><button type="button" class="terminal-replay" data-terminal-replay>Replay</button></div>
  <div class="t-tabs mono" role="tablist" aria-label="Terminal scenes">${scenes.map((s, i) => `<button type="button" role="tab" class="t-tab${i === 0 ? " is-active" : ""}" data-scene-tab="${s.id}" aria-selected="${i === 0}">${e(s.label)}</button>`).join("")}</div>
  <pre class="terminal-body" aria-label="Splice CLI sessions: Robinhood Chain data, tokens, stock tokens, perps, DeFi, a token report and an AI question">${scenes.map((s, i) => `<code class="t-scene${i === 0 ? " is-active" : ""}" data-scene="${s.id}">${s.lines.join("")}</code>`).join("")}</pre>
</div>
<p class="terminal-caption mono">Output recorded live on ${CHAIN_RECORDING.date} from Robinhood Chain mainnet and the providers named in each result (fields trimmed: …). Package version and SHA-256 from the registry at build time.</p>`;
}

// ------------------------------------------------------------------------------------------ landing

export function renderLanding(config: SiteConfig, data: LandingData, skillPages: string[]): string {
  const loc: PageLoc = { host: "site", dir: "" };
  const link = (path: string) => href(config, loc, path);
  const { snapshot, providers } = data;
  const skills = snapshot.skills;
  const featured = FEATURED_SKILLS.map((id) => skills.find((s) => s.id === id)).filter((s): s is SkillView => s !== undefined);
  const foundation = skills.filter((s) => !FEATURED_SKILLS.includes(s.id));
  const files = skills.find((s) => s.id === "@splice/files");
  const registryHost = new URL(config.registry).host;
  const registryBase = config.registry.replace(/\/$/, "");
  const docs = (slug: string) => link(`docs/${slug}`);
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "Splice",
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Windows, macOS, Linux",
    description: "Infrastructure for composing capabilities into autonomous agents: a verified package registry, a sandboxed runtime, a capability broker and real data providers.",
    url: config.siteUrl,
    license: "https://opensource.org/licenses/MIT",
    publisher: { "@type": "Organization", name: "Splice", url: config.siteUrl, sameAs: ["https://x.com/spliceloom", config.githubUrl] },
  };
  const capabilityGroup = (group: (typeof CAPABILITY_GROUPS)[number]) => {
    const caps = group.list ?? data.capabilities.filter((c) => group.prefixes.some((p) => c.startsWith(p)));
    const names = providers.filter((p) => group.domains.includes(p.domain)).map((p) => `<span class="p-name">${e(p.name)}</span>`);
    return `<article class="cap reveal"><h3>${e(group.title)}</h3><p>${e(group.text)}</p><p class="cap-list mono">${caps.map((c) => e(c)).join(" · ")}</p><p class="cap-providers"><span class="mono">via</span> ${names.join(", ")}</p></article>`;
  };
  return `${head(config, loc, {
    title: "Splice — The Composable Layer for Autonomous Agents",
    description: "Splice gives autonomous agents reusable capabilities, real-world data, tools and services through a verified, permissioned package ecosystem.",
    path: "",
    jsonLd,
  })}
<body class="home">
<a class="skip-link" href="./" data-section="main" data-local>Skip to content</a>
${header(loc, "home", config)}
<main id="main">

  <section class="hero" aria-labelledby="hero-title">
    <div class="hero-media" aria-hidden="true">
      <video class="hero-video" data-hero-video muted loop playsinline disablepictureinpicture preload="none" data-video-lg="assets/media/hero-1600.mp4" data-video-sm="assets/media/hero-960.mp4"></video>
      <div class="hero-shade"></div>
    </div>
    <div class="shell hero-inner">
      <a class="news-pill" href="${link(WHATS_NEW.path)}"><span class="mono">${e(WHATS_NEW.label)}</span>${e(WHATS_NEW.text)} ${ARROW}</a>
      <p class="hero-eyebrow mono">Splice <span aria-hidden="true">/</span> Composable agent infrastructure</p>
      <h1 id="hero-title">The composable layer <br>for autonomous agents.</h1>
      <p class="hero-lead">Splice gives agents access to real capabilities through a secure, composable package ecosystem — so developers can discover, install, and run the tools and data their agents need.</p>
      <div class="cta-row">
        <a class="btn btn-solid" href="${docs("quickstart")}">Get started</a>
        <a class="btn btn-ghost" href="${docs("skills")}" data-section="skills" data-local>Explore skills</a>
      </div>
    </div>
    <div class="shell hero-meta mono">
      <span>Built for the open web and onchain environments</span>
      <span>Robinhood Chain · EVM · Chain ID 4663</span>
    </div>
  </section>

  <section class="section section-cli" id="cli" aria-labelledby="cli-title">
    <div class="shell split split-cli">
      <div class="split-copy">
        <p class="kicker">Developer experience</p>
        <h2 id="cli-title">From capability to execution.</h2>
        <p>One install for Robinhood Chain from your terminal: every token, stock tokens, perps, DeFi and global markets, research reports and live alerts — then hand the same capabilities to your agents.</p>
        <ul class="ticks">
          <li>Chain ID 4663 is verified live before any data is returned.</li>
          <li>Every result names its source and fetch time; sources are never averaged.</li>
          <li>Skills are verified (SHA-256, size, provenance) before a file is written.</li>
        </ul>
        <ul class="cmd-list mono" aria-label="CLI commands">
          <li>splice dash</li><li>splice tokens trending</li><li>splice tokens new</li><li>splice stock quote TSLA</li><li>splice perps</li><li>splice defi</li><li>splice report &lt;token&gt;</li><li>splice radar</li><li>splice watch &lt;token&gt;</li><li>splice wallet inspect</li><li>splice global</li><li>splice ask</li>
        </ul>
        <p class="note">Node.js 22.18 or newer. <a href="${docs("installation")}">Installation guide</a>.</p>
      </div>
      <div class="split-visual reveal">${terminalSession(skills)}</div>
    </div>
  </section>

  <section class="section section-rule" id="watch" aria-labelledby="watch-title">
    <div class="shell">
      <div class="section-head split-head">
        <div><p class="kicker">Watch</p><h2 id="watch-title">See it work in 90 seconds.</h2></div>
        <p class="section-lead">Install, live data with no key, verified skills, MCP and the SDK — recorded from the real CLI. Each feature has its own walkthrough in the docs.</p>
      </div>
      <div class="watch reveal">${videoFigure(config, loc, "how-it-works")}</div>
      <p class="more">${[["markets", "Tokens & research"], ["stock-tokens", "Stock tokens"], ["markets", "Perps, DeFi & macro"], ["ask", "Ask"]].map(([slug, label]) => `<a class="text-link" href="${docs(slug!)}">${e(label!)} ${ARROW}</a>`).join("")}</p>
    </div>
  </section>

  <section class="section section-rule" id="platform" aria-labelledby="platform-title">
    <div class="shell statement">
      <p class="kicker">What is Splice</p>
      <h2 id="platform-title">Agents are only as useful as what they can reach.</h2>
      <div class="statement-body">
        <p class="section-lead">Reading chain state, searching the web, opening a repository, calling a model — each depends on APIs, keys, limits and permissions. Splice is the layer between agents and those capabilities: built once as packages, verified on install, and reused by any agent.</p>
        <dl class="terms">
          <div><dt>Skills</dt><dd>Versioned packages of tools with typed inputs and outputs, published to a public registry.</dd></div>
          <div><dt>Capabilities</dt><dd>What a skill is allowed to use — files, hosts, data — declared up front and granted explicitly.</dd></div>
          <div><dt>Splice</dt><dd>The CLI and runtime that installs, verifies and runs skills for agents, through the CLI, SDK or MCP.</dd></div>
        </dl>
      </div>
    </div>
  </section>

  <section class="section section-panel" id="why" aria-labelledby="why-title">
    <div class="shell">
      <div class="section-head split-head">
        <div><p class="kicker">Why Splice</p><h2 id="why-title">The difference is in the details.</h2></div>
        <p class="section-lead">What changes when an agent reaches tools and data through Splice instead of wiring each provider by hand.</p>
      </div>
      <div class="why-table reveal" role="table" aria-label="Without Splice and with Splice">
        <div class="why-row why-head" role="row"><span role="columnheader"></span><span role="columnheader">Wiring providers yourself</span><span role="columnheader">With Splice</span></div>
        ${WHY_ROWS.map(([k, without, withS]) => `<div class="why-row" role="row"><span class="why-k mono" role="rowheader">${e(k)}</span><span class="why-no" role="cell">${e(without)}</span><span class="why-yes" role="cell">${e(withS)}</span></div>`).join("\n        ")}
      </div>
    </div>
  </section>

  <section class="section" id="how" aria-labelledby="how-title">
    <div class="shell">
      <div class="section-head">
        <p class="kicker">How it works</p>
        <h2 id="how-title">From a search to an agent acting on the result.</h2>
      </div>
      <ol class="steps">
        ${STEPS.map(([title, text, cmd], i) => `<li class="reveal"><span class="step mono">${String(i + 1).padStart(2, "0")}</span><h3>${e(title)}</h3><p>${e(text)}</p><code>${e(cmd)}</code></li>`).join("\n        ")}
      </ol>
    </div>
  </section>

  <section class="section section-panel" id="skills" aria-labelledby="skills-title">
    <div class="shell">
      <div class="section-head split-head">
        <div><p class="kicker">Skills</p><h2 id="skills-title">Capabilities, packaged and verified.</h2></div>
        <p class="section-lead">Read from the registry API. Versions, tools and permissions come from each package's published manifest; the verification status is the result of <code>splice verify</code> at build time. <span class="data-status" data-registry-status>Snapshot from ${e(snapshot.generatedAt.slice(0, 10))}.</span></p>
      </div>
      <div class="skill-grid">
        ${featured.map((s) => skillCard(s, link, skillPages.includes(s.name))).join("\n        ")}
      </div>
      ${
        foundation.length > 0
          ? `<h3 class="subhead mono">Foundation skills</h3>
      <div class="skill-grid skill-grid-3">
        ${foundation.map((s) => skillCard(s, link, skillPages.includes(s.name))).join("\n        ")}
      </div>`
          : ""
      }
      <p class="more"><a class="text-link" href="${docs("skills")}">Official skills ${ARROW}</a><a class="text-link" href="${docs("authoring-skills")}">Write your own ${ARROW}</a></p>
    </div>
  </section>

  <section class="section section-rule" id="capabilities" aria-labelledby="cap-title">
    <div class="shell">
      <div class="section-head split-head">
        <div><p class="kicker">Capability layer</p><h2 id="cap-title">Connect agents to real capabilities.</h2></div>
        <p class="section-lead">A skill asks for a capability, never a vendor. The host routes it to a configured provider, keeps the keys to itself, and attaches provenance. Results are live, cached, unavailable or an error — never an invented value.</p>
      </div>
      <div class="cap-grid">
        ${CAPABILITY_GROUPS.map(capabilityGroup).join("\n        ")}
        <article class="cap reveal"><h3>Files</h3><p>Read and write inside declared project paths only. Granted as a file permission, not routed to a provider.</p>${files ? `<p class="cap-list mono">${files.tools.map((t) => e(t.name)).join(" · ")}</p>` : ""}<p class="cap-providers"><span class="mono">via</span> the local sandbox</p></article>
      </div>
      <p class="more"><a class="text-link" href="${docs("capabilities")}">Host capabilities ${ARROW}</a><a class="text-link" href="${docs("data-providers")}">Provider reference ${ARROW}</a></p>
    </div>
  </section>

  <section class="section" id="robinhood-chain" aria-labelledby="rh-title">
    <div class="shell rh">
      <div class="rh-copy">
        <p class="kicker">Robinhood Chain</p>
        <h2 id="rh-title">The initial onchain environment Splice is built around.</h2>
        <p>Robinhood Chain is a permissionless, EVM-compatible Layer 2 for financial services and tokenized real-world assets. Splice reads it through standard JSON-RPC and explorer APIs — verifying chain ID 4663 first — and exposes balances, transactions, tokens, contracts and markets as capabilities.</p>
        <p class="callout"><strong>Splice is not the blockchain.</strong> Robinhood Chain is the network; Splice is the layer that turns its public data into permissioned, verifiable capabilities for agents.</p>
        <p class="note">Network facts from Robinhood's public documentation (<a href="https://docs.robinhood.com/chain/connecting/" rel="noopener">docs.robinhood.com</a>). Splice is independent and not affiliated with or endorsed by Robinhood.</p>
        <p class="more"><a class="text-link" href="${docs("robinhood-chain")}">Robinhood Chain in Splice ${ARROW}</a></p>
      </div>
      <dl class="fact-list reveal">
        ${ROBINHOOD_FACTS.map(([k, v]) => `<div><dt class="mono">${e(k)}</dt><dd>${e(v)}</dd></div>`).join("")}
      </dl>
    </div>
  </section>

  <section class="section section-rule" id="tools" aria-labelledby="tools-title">
    <div class="shell">
      <div class="section-head split-head">
        <div><p class="kicker">On the web</p><h2 id="tools-title">Use it without installing anything.</h2></div>
        <p class="section-lead">The same data the CLI, SDK and MCP servers return, in the browser and in Telegram. Every panel names its source and how fresh it is.</p>
      </div>
      <div class="cap-grid">
        <article class="cap reveal"><h3>Live chain</h3><p>Robinhood Chain right now: TVL, stock tokens, perps, DeFi protocols, prediction-market odds and the newest pools.</p><a class="text-link" href="${link("live")}">Open /live ${ARROW}</a></article>
        <article class="cap reveal"><h3>Stock tokens</h3><p>The DEX price of each stock token next to its reference price, with the premium or discount, and the company's latest SEC filings.</p><a class="text-link" href="${link("stocks")}">Open /stocks ${ARROW}</a></article>
        <article class="cap reveal"><h3>New token screener</h3><p>The newest pools with automated security flags, liquidity, volume and age. Filter by liquidity or hide flagged tokens.</p><a class="text-link" href="${link("screener")}">Open /screener ${ARROW}</a></article>
        <article class="cap reveal"><h3>Contract explainer</h3><p>A contract's verified functions and security flags, explained in plain English.</p><a class="text-link" href="${link("explain")}">Open /explain ${ARROW}</a></article>
        <article class="cap reveal"><h3>Wallet viewer</h3><p>What any address holds, what it is worth where a price source lists the token, and its recent transfers.</p><a class="text-link" href="${link("wallet")}">Open /wallet ${ARROW}</a></article>
        <article class="cap reveal"><h3>Ask</h3><p>Questions in plain English, answered from live data with every tool call and source shown.</p><a class="text-link" href="${link("ask")}">Open /ask ${ARROW}</a></article>
        <article class="cap reveal"><h3>$SPLICE</h3><p>Live price from the pool, candles, trades, holders, burns and an on-chain transparency panel.</p><a class="text-link" href="${link("token")}">Open /token ${ARROW}</a></article>
        <article class="cap reveal"><h3>Telegram bot</h3><p>All of the above as commands, plus alerts sent to your chat: price levels, large trades, burns, new tokens.</p><a class="text-link" href="${link("bot")}">Meet the bot ${ARROW}</a></article>
      </div>
    </div>
  </section>

  <section class="section section-panel" id="security" aria-labelledby="security-title">
    <div class="shell">
      <div class="section-head split-head">
        <div><p class="kicker">Security</p><h2 id="security-title">Trust that is checked, not assumed.</h2></div>
        <p class="section-lead">These mechanisms are implemented and covered by tests. What is not guaranteed today is listed next to them.</p>
      </div>
      <div class="sec-grid">
        <article class="reveal"><h3>Integrity and signatures</h3><p>SHA-256 and size are checked before anything is extracted; publisher signatures (Ed25519) are verified locally and the signer is pinned in <code>splice.lock</code>. Published versions are immutable.</p></article>
        <article class="reveal"><h3>Explicit permissions</h3><p>File paths, network hosts, environment variables and host capabilities need consent; the grant is pinned in <code>splice.lock</code>.</p></article>
        <article class="reveal"><h3>Sandbox</h3><p>One process per call on the Node.js permission model: no child processes, workers, native addons or <code>eval</code>.</p></article>
        <article class="reveal"><h3>Network guard</h3><p>Declared hosts only. Private, loopback, link-local and metadata addresses are refused at DNS time; redirects are re-checked.</p></article>
        <article class="reveal"><h3>Provider isolation</h3><p>Provider keys stay in the host. A broker checks each capability call's grant, budget and arguments; keys are redacted from results.</p></article>
        <article class="reveal"><h3>Provenance</h3><p>Publisher, time and artifact hash recorded write-once; data results carry source, block and fetch time.</p></article>
      </div>
      <div class="limits reveal">
        <h3 class="mono">Not guaranteed today</h3>
        <ul>
          <li>Unsigned packages — they still install by default (use <code>--require-signed</code>), and the list of signing keys comes from the registry.</li>
          <li>OS-level isolation — the sandbox is the Node.js permission model plus an in-process network guard, not a VM or container.</li>
          <li>Provider correctness — Splice reports what providers return, with provenance; it does not re-verify third-party data.</li>
        </ul>
        <a class="text-link" href="${docs("security")}">Read the security model ${ARROW}</a>
      </div>
    </div>
  </section>

  <section class="section" id="developers" aria-labelledby="dev-title">
    <div class="shell">
      <div class="section-head"><p class="kicker">For developers</p><h2 id="dev-title">Four ways in. One package layer.</h2></div>
      <div class="dev-grid">
        <article class="reveal"><header><h3 class="mono">splice</h3><span>CLI</span></header><p>Install, verify and run skills from a terminal or CI. Reproducible with <code>splice.lock</code>.</p>
<pre class="code"><code>splice init
splice add @splice/json
splice run json.parse text='{"ok":true}'</code></pre><a class="text-link" href="${docs("cli")}">CLI guide ${ARROW}</a></article>
        <article class="reveal"><header><h3 class="mono">@spliceloom/sdk</h3><span>TypeScript SDK</span></header><p>Discover and run tools from TypeScript. Tool failures are data, not exceptions.</p>
<pre class="code"><code>const splice = new Splice({ project: "./agent" });
await splice.add("@splice/json");
await splice.run("json.parse", { text: "[1,2]" });</code></pre><a class="text-link" href="${docs("sdk")}">SDK guide ${ARROW}</a></article>
        <article class="reveal"><header><h3 class="mono">splice mcp</h3><span>Model Context Protocol</span></header><p>Serve installed skills to any MCP client over stdio or authenticated HTTP.</p>
<pre class="code"><code>claude mcp add splice -- \\
  splice mcp --project ./agent</code></pre><a class="text-link" href="${docs("mcp")}">MCP guide ${ARROW}</a></article>
        <article class="reveal"><header><h3 class="mono">registry</h3><span>Public API</span></header><p>Read-only JSON over HTTPS with CORS: search, versions, metadata and artifacts.</p>
<pre class="code"><code>curl ${e(registryBase)}/packages/search?q=github
curl ${e(registryBase)}/packages/splice/github</code></pre><a class="text-link" href="${docs("api")}">Registry API ${ARROW}</a></article>
      </div>
      <p class="note">Registry: <code>${e(registryHost)}</code>. Private registries and organizations are planned — <a href="${docs("private-registry")}">see the plans</a>.</p>
    </div>
  </section>

  <section class="section cta" aria-labelledby="cta-title">
    <div class="shell cta-inner">
      <h2 id="cta-title">Give your agents capabilities.</h2>
      <div class="cta-row center">
        <a class="btn btn-solid" href="${docs("quickstart")}">Get started</a>
        <a class="btn btn-ghost" href="${docs("introduction")}">Read the docs</a>
      </div>
      <pre class="code code-cta"><code><span class="t-prompt">$</span> npm install -g @spliceloom/cli</code></pre>
    </div>
  </section>
</main>
${footer(loc, config)}
<script type="application/json" id="registry-snapshot">${JSON.stringify({ registry: snapshot.registry, generatedAt: snapshot.generatedAt, skills: skills.map((s) => ({ id: s.id, version: s.version, integrity: s.integrity, size: s.size })) }).replace(/</g, "\\u003c")}</script>
</body>
</html>
`;
}

// ------------------------------------------------------------------------------------------ docs

export interface DocPageOptions {
  slug: string;
  title: string;
  description: string;
  html: string;
  nav: NavGroup[];
  headings: Array<{ level: number; text: string; id: string }>;
  section: "docs" | "skills";
  aside?: string;
  /** Demo videos shown after the page's first paragraph. */
  videos?: string[];
}

/** Inserts HTML after the first paragraph of rendered Markdown (or at the top). */
function afterFirstParagraph(html: string, insert: string): string {
  if (!insert) return html;
  const at = html.indexOf("</p>");
  return at < 0 ? insert + html : html.slice(0, at + 4) + insert + html.slice(at + 4);
}

/** Where a docs-host page lives: docs at the root (introduction is the home page), skills under skills/. */
export function docLoc(section: "docs" | "skills", slug: string): { loc: PageLoc; path: string; self: string } {
  if (section === "skills") return { loc: { host: "docs", dir: "skills" }, path: `skills/${slug}`, self: slug };
  return slug === "introduction" ? { loc: { host: "docs", dir: "" }, path: "", self: "./" } : { loc: { host: "docs", dir: "" }, path: slug, self: slug };
}

export function renderDocPage(config: SiteConfig, options: DocPageOptions): string {
  const { loc, path, self } = docLoc(options.section, options.slug);
  const link = (target: string) => href(config, loc, target);
  const key = options.section === "skills" ? `skills/${options.slug}` : options.slug;
  const flat = options.nav.flatMap((g) => g.items.map((i) => ({ ...i, group: g.title })));
  const index = flat.findIndex((i) => i.slug === key);
  const current = flat[index];
  const prev = index > 0 ? flat[index - 1] : undefined;
  const next = index >= 0 && index < flat.length - 1 ? flat[index + 1] : undefined;
  const hrefOf = (slug: string) => link(slug.startsWith("skills/") ? slug : `docs/${slug}`);
  const toc = options.headings.filter((h) => h.level === 2);
  return `${head(config, loc, { title: `${options.title} — Splice Docs`, description: options.description, path })}
<body class="doc" data-search-index="${link("assets/search-index.json")}">
<a class="skip-link" href="${e(self)}" data-section="main" data-local>Skip to content</a>
${header(loc, options.section === "skills" ? "skills" : "docs", config)}
<div class="shell doc-layout">
  <aside class="doc-sidebar" id="doc-sidebar" aria-label="Documentation">
    <button class="search-field" type="button" data-search-open><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span>Search docs</span><kbd>/</kbd></button>
    <nav class="doc-nav">
    ${options.nav
      .map(
        (g) =>
          `<div class="nav-group"><h2>${e(g.title)}</h2><ul>${g.items
            .map((i) => `<li><a href="${hrefOf(i.slug)}"${i.slug === key ? ' aria-current="page"' : ""}>${e(i.title)}</a></li>`)
            .join("")}</ul></div>`,
      )
      .join("\n    ")}
    </nav>
  </aside>
  <main id="main" class="doc-main">
    <div class="doc-topbar">
      <button class="sidebar-toggle" type="button" data-sidebar-toggle aria-expanded="false" aria-controls="doc-sidebar">Menu</button>
      <nav class="breadcrumbs mono" aria-label="Breadcrumb"><a href="${link("docs/introduction")}">Docs</a>${current ? `<span aria-hidden="true">/</span><span>${e(current.group)}</span>` : ""}<span aria-hidden="true">/</span><span aria-current="page">${e(options.title)}</span></nav>
    </div>
    ${options.aside ?? ""}
    <article class="prose">${afterFirstParagraph(options.html, (options.videos ?? []).map((v) => videoFigure(config, loc, v)).join(""))}</article>
    <nav class="pager" aria-label="Previous and next page">
      ${prev ? `<a class="pager-prev" href="${hrefOf(prev.slug)}"><span class="mono">Previous</span><strong>${e(prev.title)}</strong></a>` : "<span></span>"}
      ${next ? `<a class="pager-next" href="${hrefOf(next.slug)}"><span class="mono">Next</span><strong>${e(next.title)}</strong></a>` : "<span></span>"}
    </nav>
  </main>
  <aside class="doc-toc" aria-label="On this page">${toc.length > 1 ? `<h2 class="mono">On this page</h2><ul>${toc.map((h) => `<li><a href="${e(self)}" data-section="${e(h.id)}" data-local>${e(h.text)}</a></li>`).join("")}</ul>` : ""}</aside>
</div>
<div class="search-dialog" data-search-dialog hidden>
  <div class="search-panel" role="dialog" aria-modal="true" aria-label="Search documentation">
    <input type="search" class="search-input" data-search-input placeholder="Search the documentation" aria-label="Search the documentation" autocomplete="off" spellcheck="false">
    <ul class="search-results" data-search-results role="listbox"></ul>
    <p class="search-hint mono"><kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Enter</kbd> open · <kbd>Esc</kbd> close</p>
  </div>
</div>
${footer(loc, config)}
</body>
</html>
`;
}

/** The 404 page of a host; served at any depth, so its links are root-relative. */
export function renderNotFound(config: SiteConfig, host: Host = "site"): string {
  const loc: PageLoc = { host, dir: "", rooted: true };
  return `${head(config, loc, { title: "Not found — Splice", description: "This page does not exist.", path: "404" })}
<body class="plain">
${header(loc, "home", config)}
<main id="main" class="section"><div class="shell narrow"><p class="kicker mono">404</p><h1 class="display">Page not found.</h1><p class="lead">This page does not exist. Start from the <a href="${href(config, loc, "")}">home page</a> or the <a href="${href(config, loc, "docs/introduction")}">documentation</a>.</p></div></main>
${footer(loc, config)}
</body>
</html>
`;
}

// ------------------------------------------------------------------------------------------ site pages

/** A plain site-host page (blog, registry, brand) with the shared header and footer. */
function sitePage(config: SiteConfig, loc: PageLoc, page: { title: string; description: string; path: string; bodyClass?: string; jsonLd?: unknown; styleHashes?: string[] }, main: string): string {
  const self = page.path.split("/").pop() || "./";
  return `${head(config, loc, { title: page.title, description: page.description, path: page.path, ...(page.jsonLd ? { jsonLd: page.jsonLd } : {}), ...(page.styleHashes ? { styleHashes: page.styleHashes } : {}) })}
<body class="plain ${page.bodyClass ?? ""}">
<a class="skip-link" href="${e(self)}" data-section="main" data-local>Skip to content</a>
${header(loc, "home", config)}
<main id="main">
${main}
</main>
${footer(loc, config)}
</body>
</html>
`;
}

export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  date: string;
  html: string;
}

/** Blog post: Markdown rendered by the build; "@video name" paragraphs become demo videos. */
export function renderBlogPost(config: SiteConfig, post: BlogPost): string {
  const loc: PageLoc = { host: "site", dir: "blog" };
  const html = post.html.replace(/<p>@video ([\w-]+)<\/p>/g, (_, name: string) => videoFigure(config, loc, name));
  const jsonLd = { "@context": "https://schema.org", "@type": "BlogPosting", headline: post.title, description: post.description, datePublished: post.date, author: { "@type": "Organization", name: "Splice" }, publisher: { "@type": "Organization", name: "Splice", url: config.siteUrl } };
  return sitePage(config, loc, { title: `${post.title} — Splice`, description: post.description, path: `blog/${post.slug}`, bodyClass: "blog", jsonLd }, `
  <article class="section article">
    <div class="shell narrow">
      <p class="kicker"><a href="${href(config, loc, "blog")}">Blog</a> · <time datetime="${e(post.date)}">${e(new Date(post.date + "T00:00:00Z").toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" }))}</time></p>
      <h1 class="display">${e(post.title)}</h1>
      <p class="lead">${e(post.description)}</p>
      <div class="prose">${html}</div>
    </div>
  </article>`);
}

export function renderBlogIndex(config: SiteConfig, posts: BlogPost[]): string {
  const loc: PageLoc = { host: "site", dir: "" };
  return sitePage(config, loc, { title: "Blog — Splice", description: "Releases and notes from the Splice team.", path: "blog", bodyClass: "blog" }, `
  <section class="section">
    <div class="shell narrow">
      <p class="kicker">Blog</p>
      <h1 class="display">News and releases.</h1>
      <ul class="post-list">
        ${posts.map((p) => `<li><a href="${href(config, loc, `blog/${p.slug}`)}"><time class="mono" datetime="${e(p.date)}">${e(p.date)}</time><strong>${e(p.title)}</strong><span>${e(p.description)}</span></a></li>`).join("\n        ")}
      </ul>
    </div>
  </section>`);
}

/** The skills registry, from the registry snapshot taken at build time (refreshed live in the page). */
export function renderRegistry(config: SiteConfig, snapshot: RegistrySnapshot, skillPages: string[]): string {
  const loc: PageLoc = { host: "site", dir: "" };
  const link = (p: string) => href(config, loc, p);
  const cards = snapshot.skills.map((s) => {
    const install = `splice add ${s.id}${s.permissionSummary[0]?.startsWith("none") ? "" : " --accept-permissions"}`;
    const text = [s.id, s.description, ...s.tools.map((t) => t.name)].join(" ").toLowerCase();
    return `<div class="registry-item" data-filter-text="${e(text)}">${skillCard(s, link, skillPages.includes(s.name))}<div class="install-row"><code>${e(install)}</code><button type="button" class="copy-inline" data-copy="${e(install)}">Copy</button></div></div>`;
  });
  return sitePage(config, loc, { title: "Skills registry — Splice", description: "Every official Splice skill: versions, tools, permissions and verification results from the public registry.", path: "registry", bodyClass: "registry-page" }, `
  <section class="section">
    <div class="shell">
      <div class="section-head split-head">
        <div><p class="kicker">Registry</p><h1 class="display">Skills, verified.</h1></div>
        <p class="section-lead">Every official skill in the public registry at <code>${e(new URL(snapshot.registry).host)}</code>: version, tools, the permissions it asks for and the result of <code>splice verify</code>. <span class="data-status" data-registry-status>Snapshot from ${e(snapshot.generatedAt.slice(0, 10))}.</span></p>
      </div>
      <label class="registry-search"><span class="mono">Search</span><input type="search" placeholder="tokens, github, files…" data-registry-filter autocomplete="off" spellcheck="false"></label>
      <div class="skill-grid registry-grid">
        ${cards.join("\n        ")}
      </div>
      <p class="empty-note" data-registry-empty hidden>No skill matches that search.</p>
      <p class="more"><a class="text-link" href="${link("docs/skills")}">Official skills ${ARROW}</a><a class="text-link" href="${link("docs/authoring-skills")}">Write and publish your own ${ARROW}</a><a class="text-link" href="${link("docs/api")}">Registry API ${ARROW}</a></p>
    </div>
  </section>
<script type="application/json" id="registry-snapshot">${JSON.stringify({ registry: snapshot.registry, generatedAt: snapshot.generatedAt, skills: snapshot.skills.map((s) => ({ id: s.id, version: s.version, integrity: s.integrity, size: s.size })) }).replace(/</g, "\\u003c")}</script>`);
}

/** Brand kit: logo files, colours, typography and naming. */
export function renderBrand(config: SiteConfig): string {
  const loc: PageLoc = { host: "site", dir: "" };
  const a = (p: string) => href(config, loc, p);
  const colors: Array<[string, string, string]> = [["Ink", "#050505", "Backgrounds"], ["Surface", "#0B0C0D", "Panels, cards"], ["Bone", "#EDEBE7", "Text, the mark"], ["Steel", "#A8C1D9", "Accent, the woven thread"], ["Deep steel", "#6F93B6", "Secondary accent"], ["Grey", "#A4A8AD", "Secondary text"]];
  const files: Array<[string, string, string]> = [
    ["assets/brand/splice-mark.svg", "Mark — light, for dark backgrounds", "SVG"],
    ["assets/brand/splice-mark-dark.svg", "Mark — dark, for light backgrounds", "SVG"],
    ["assets/brand/splice-avatar.png", "Avatar, 1000 × 1000", "PNG"],
    ["assets/brand/splice-banner.png", "Banner, 1600 × 560", "PNG"],
    ["assets/brand/splice-social.png", "Social card, 1280 × 640", "PNG"],
  ];
  return sitePage(config, loc, { title: "Brand — Splice", description: "The Splice logo, colours, typography and how to write the name.", path: "brand", bodyClass: "brand-page" }, `
  <section class="section">
    <div class="shell">
      <p class="kicker">Brand</p>
      <h1 class="display">The Splice brand.</h1>
      <p class="lead">Logo files, colours and type for articles, videos and integrations. Use them as provided — please do not redraw, recolour or stretch the mark.</p>

      <div class="brand-hero reveal">
        <div class="brand-tile dark"><svg viewBox="0 0 32 32" aria-hidden="true"><use href="#brand-mark"/></svg><span>Splice</span></div>
        <div class="brand-tile light"><svg viewBox="0 0 32 32" aria-hidden="true"><use href="#brand-mark-dark"/></svg><span>Splice</span></div>
      </div>

      <h2 class="subhead mono">Downloads</h2>
      <ul class="brand-files">
        ${files.map(([p, label, kind]) => `<li><a href="${a(p)}" download><span>${e(label)}</span><span class="mono">${e(kind)} ↓</span></a></li>`).join("\n        ")}
      </ul>

      <h2 class="subhead mono">Colours</h2>
      <div class="swatches">
        ${colors.map(([name, hex, use]) => `<div class="swatch"><svg class="swatch-chip" viewBox="0 0 10 10" preserveAspectRatio="none" aria-hidden="true"><rect width="10" height="10" fill="${hex}"/></svg><strong>${e(name)}</strong><code>${hex}</code><span>${e(use)}</span></div>`).join("\n        ")}
      </div>

      <h2 class="subhead mono">Typography</h2>
      <div class="type-specimen">
        <div><p class="spec-sans">Geist</p><span>Headlines and text · SIL Open Font License</span></div>
        <div><p class="spec-mono">Geist Mono</p><span>Commands, code and labels · SIL Open Font License</span></div>
      </div>

      <h2 class="subhead mono">Naming</h2>
      <dl class="terms naming">
        <div><dt>Splice</dt><dd>The product and the brand. Always one word, capital S.</dd></div>
        <div><dt>splice</dt><dd>The command: <code>splice add</code>, <code>splice ask</code>.</dd></div>
        <div><dt>spliceloom</dt><dd>Only in addresses: spliceloom.com, the <code>@spliceloom</code> npm scope, and the GitHub and X accounts. Not a product name.</dd></div>
        <div><dt>Avoid</dt><dd>“SpliceLoom”, “Splice Loom”, “SPLICE” in running text.</dd></div>
      </dl>
    </div>
  </section>
<svg class="svg-defs" width="0" height="0" aria-hidden="true">
  <symbol id="brand-mark" viewBox="0 0 32 32"><path d="M6 11H8.5M13.5 11H26M6 21H18.5M23.5 21H26" stroke="#EDEBE7" stroke-width="2.4" stroke-linecap="round" fill="none"/><path d="M11 6V18.5M11 23.5V26M21 6V8.5" stroke="#EDEBE7" stroke-opacity=".55" stroke-width="2.4" stroke-linecap="round" fill="none"/><path d="M21 13.5V26" stroke="#A8C1D9" stroke-width="2.4" stroke-linecap="round" fill="none"/></symbol>
  <symbol id="brand-mark-dark" viewBox="0 0 32 32"><path d="M6 11H8.5M13.5 11H26M6 21H18.5M23.5 21H26" stroke="#0B0C0D" stroke-width="2.4" stroke-linecap="round" fill="none"/><path d="M11 6V18.5M11 23.5V26M21 6V8.5" stroke="#0B0C0D" stroke-opacity=".5" stroke-width="2.4" stroke-linecap="round" fill="none"/><path d="M21 13.5V26" stroke="#6F93B6" stroke-width="2.4" stroke-linecap="round" fill="none"/></symbol>
</svg>`);
}

// ------------------------------------------------------------------------------- live data pages
// These pages are rendered empty and filled in the browser from the public API (api.spliceloom.com).
// Every value shown carries its source and fetch time; a failed source is shown as unavailable.

const stat = (key: string, label: string) => `<div class="stat-card" data-stat="${key}"><span class="mono">${e(label)}</span><strong data-value>—</strong><small data-note></small></div>`;

/** The one inline <style> element Lightweight Charts 5.2.1 injects (allowed by hash, nothing else inline). */
const LWC_STYLE_HASH = "sha256-3pRED1tOXas1FXFoPb9TGCjmYe9XQsmO9OV23khV2nY=";

/** $SPLICE: a trading-terminal view — live price from the pool, candles, trades, holders and burns. */
export function renderToken(config: SiteConfig): string {
  const loc: PageLoc = { host: "site", dir: "" };
  const kv = (key: string, label: string) => `<div class="kv" data-kv="${key}"><span>${e(label)}</span><strong data-value>—</strong></div>`;
  const side = (key: string, label: string) => `<div class="side-stat" data-stat="${key}"><span>${e(label)}</span><strong data-value>—</strong><small data-note></small></div>`;
  return sitePage(config, loc, { title: "$SPLICE token — Splice", description: "The official $SPLICE contract on Robinhood Chain: live price, candles, trades, holders and burns, each with its source.", path: "token", bodyClass: "live-page token-page", styleHashes: [LWC_STYLE_HASH] }, `
  <section class="section token-terminal" data-live="token" data-api="${e(config.api ?? "")}">
    <div class="shell wide">
      <header class="term-head">
        <div class="term-id">
          <div class="term-mark" aria-hidden="true">${LOGO}</div>
          <div>
            <h1><span>$SPLICE</span> <small>Splice</small></h1>
            <div class="term-ca"><code>${TOKEN_CA.slice(0, 6)}…${TOKEN_CA.slice(-4)}</code><button type="button" class="copy-inline" data-copy="${TOKEN_CA}">Copy CA</button><span class="mono muted">Robinhood Chain</span><a class="mono" href="https://x.com/spliceloom" rel="noopener">X</a></div>
          </div>
        </div>
        <div class="term-mc"><span>Market cap</span><strong data-mc>—</strong></div>
        <div class="term-kvs">
          ${kv("price", "Price")}
          ${kv("liq", "Liquidity")}
          ${kv("vol", "24h Vol")}
          ${kv("holders", "Holders")}
        </div>
        <span class="live-dot mono" data-live-dot>connecting…</span>
      </header>

      <div class="term-grid">
        <div class="term-main">
          <div class="live-card chart-card">
            <div class="chart-head">
              <div class="tf-switch" role="group" aria-label="Candle interval">
                <button type="button" class="tf" data-tf="60" aria-pressed="true">1m</button><button type="button" class="tf" data-tf="300" aria-pressed="false">5m</button><button type="button" class="tf" data-tf="900" aria-pressed="false">15m</button><button type="button" class="tf" data-tf="3600" aria-pressed="false">1H</button><button type="button" class="tf" data-tf="14400" aria-pressed="false">4H</button><button type="button" class="tf" data-tf="86400" aria-pressed="false">1D</button>
              </div>
              <div class="tf-switch" role="group" aria-label="Chart value"><button type="button" class="tf" data-mode="price" aria-pressed="false">Price</button><button type="button" class="tf" data-mode="mc" aria-pressed="true">MC</button></div>
              <button type="button" class="tf tf-log" data-log aria-pressed="false">log</button>
            </div>
            <div class="chart-wrap"><div class="chart-legend mono" data-chart-ohlc></div><div class="tv-chart" data-tv-chart aria-label="$SPLICE candles" role="img"></div><div class="chart-empty muted" data-chart-empty>Loading chart…</div></div>
            <p class="card-source mono" data-chart-source></p>
          </div>

          <div class="live-card tabs-card">
            <div class="tabs" role="tablist">
              <button type="button" role="tab" class="tab" data-tab="trades" aria-selected="true">Trades <span class="live-dot mono" data-trades-live></span></button>
              <button type="button" role="tab" class="tab" data-tab="holders" aria-selected="false">Holders <span class="mono muted" data-holders-count></span></button>
              <button type="button" role="tab" class="tab" data-tab="burn" aria-selected="false">Burn</button>
            </div>
            <div class="tab-panel" data-panel="trades">
              <table class="trades-table"><thead><tr><th>Age</th><th>Type</th><th>Price</th><th>Amount</th><th>Total USD</th><th>Trader</th></tr></thead><tbody data-trades><tr><td colspan="6" class="muted">Loading…</td></tr></tbody></table>
              <p class="card-source mono" data-trades-source></p>
            </div>
            <div class="tab-panel" data-panel="holders" hidden>
              <ul class="holder-list" data-holders><li class="muted">Loading…</li></ul>
              <p class="card-source mono" data-holders-source></p>
            </div>
            <div class="tab-panel" data-panel="burn" hidden>
              <div class="burn-head"><div><span class="mono">Burned</span><strong data-burn-total>—</strong></div><div class="burn-pct"><strong data-burn-pct>—</strong><span class="mono">of total supply</span></div></div>
              <svg class="burn-bar" viewBox="0 0 1000 14" preserveAspectRatio="none" aria-hidden="true"><rect class="track" width="1000" height="14" rx="7"/><rect class="fill" data-burn-fill width="0" height="14" rx="7"/></svg>
              <ul class="burn-addresses" data-burn-addresses></ul>
              <p class="fine">Burned = the $SPLICE balance of the dead address and the zero address, read with <code>balanceOf</code> at the latest block.</p>
            </div>
          </div>
        </div>

        <aside class="term-side">
          <div class="live-card">
            <div class="win-tabs" role="tablist" aria-label="Window">
              <button type="button" class="win" data-win="m5" aria-selected="false"><span>5m</span><strong data-change="m5">—</strong></button>
              <button type="button" class="win" data-win="h1" aria-selected="false"><span>1h</span><strong data-change="h1">—</strong></button>
              <button type="button" class="win" data-win="h4" aria-selected="false"><span>4h</span><strong data-change="h4">—</strong></button>
              <button type="button" class="win" data-win="h24" aria-selected="true"><span>24h</span><strong data-change="h24">—</strong></button>
            </div>
            <div class="win-stats">
              <div><span>Vol</span><strong data-win-vol>—</strong></div>
              <div><span>Buys</span><strong class="up" data-win-buys>—</strong></div>
              <div><span>Sells</span><strong class="down" data-win-sells>—</strong></div>
              <div><span>Net</span><strong data-win-net>—</strong></div>
            </div>
            <svg class="flow-bar" viewBox="0 0 1000 8" preserveAspectRatio="none" aria-hidden="true"><rect class="sell" width="1000" height="8" rx="4"/><rect class="buy" data-flow-buy width="0" height="8" rx="4"/></svg>
            <p class="card-source mono" data-win-source></p>
          </div>

          <div class="live-card transparency-card">
            <h2>Transparency <span class="mono muted">read from the contract</span></h2>
            <div class="tp-dev"><span>Dev wallet (deployer)</span><strong data-tp-dev>—</strong></div>
            <code class="tp-addr" data-tp-dev-addr></code>
            <svg class="tp-bar" viewBox="0 0 1000 10" preserveAspectRatio="none" aria-hidden="true"><rect class="tp-curve" data-tp-bar-curve x="0" width="0" height="10"/><rect class="tp-holders" data-tp-bar-holders x="0" width="0" height="10"/><rect class="tp-burn" data-tp-bar-burn x="0" width="0" height="10"/></svg>
            <ul class="tp-legend">
              <li><i class="tp-curve"></i><span>Launch curve (pool)</span><strong data-tp-curve>—</strong></li>
              <li><i class="tp-holders"></i><span>Holders</span><strong data-tp-holders>—</strong></li>
              <li><i class="tp-burn"></i><span>Burned</span><strong data-tp-burn>—</strong></li>
            </ul>
            <p class="fine">Live from the token contract: <code>deployer()</code> and <code>curve()</code>, then <code>balanceOf</code>. The curve is the Pons launch pool; its source is not verified on Blockscout, so this page makes no claim about how its liquidity can be used.</p>
          </div>

          <div class="live-card side-grid">
            ${side("fdvUsd", "FDV")}
            ${side("liquidityUsd", "Liquidity")}
            ${side("txns24", "Trades 24h")}
            ${side("uniqueBuyers24", "Unique buyers 24h")}
            ${side("burned", "Burned")}
            ${side("totalSupply", "Total supply")}
          </div>

          <div class="live-card contract-card">
            <span class="mono">Official contract</span>
            <code class="token-ca">${TOKEN_CA}</code>
            <button type="button" class="copy-inline" data-copy="${TOKEN_CA}">Copy</button>
            <p class="fine">The only official $SPLICE contract, announced on spliceloom.com and @spliceloom. Any other token using the Splice name is not ours.</p>
          </div>

          <details class="live-card sources-card">
            <summary class="mono">Sources</summary>
            <ul class="source-list" data-sources><li class="muted">Loading live data…</li></ul>
          </details>
        </aside>
      </div>
      <p class="fine">Live: price, liquidity and new trades are read from the pool on Robinhood Chain every few seconds (reserves, swap events, Chainlink ETH/USD). Candle history and 24h activity come from Codex (refreshed every 30–60 minutes); the current candle is updated from the live price. Market cap = price × total supply (1,000,000,000). Charts by <a href="https://www.tradingview.com/" rel="noopener">TradingView</a> Lightweight Charts. Market data is not financial advice.</p>
    </div>
  </section>
<script src="${href(config, loc, "assets/vendor/lightweight-charts-5.2.1.js")}" defer></script>`);
}
/** Robinhood Chain right now: TVL, stock tokens, perps, protocols and new pools. */
export function renderLive(config: SiteConfig): string {
  const loc: PageLoc = { host: "site", dir: "" };
  const table = (key: string, title: string, cols: string[]) => `<div class="live-card" data-table="${key}"><h2>${e(title)}</h2><table><thead><tr>${cols.map((c) => `<th>${e(c)}</th>`).join("")}</tr></thead><tbody><tr><td colspan="${cols.length}" class="muted">Loading…</td></tr></tbody></table><p class="card-source mono" data-source></p></div>`;
  return sitePage(config, loc, { title: "Robinhood Chain live — Splice", description: "Robinhood Chain right now: TVL, stock tokens, perpetuals, DeFi protocols, prediction-market odds and new pools, live from public sources through Splice.", path: "live", bodyClass: "live-page" }, `
  <section class="section" data-live="chain" data-api="${e(config.api ?? "")}">
    <div class="shell">
      <div class="section-head split-head">
        <div><p class="kicker">Live</p><h1 class="display">Robinhood Chain, right now.</h1></div>
        <p class="section-lead">The same data the <code>splice</code> CLI, SDK and MCP servers return, each panel labelled with its source and fetch time. Refreshes every few minutes.</p>
      </div>
      <div class="live-card tvl-card" data-panel="tvl">
        <div class="tvl-head"><div><span class="mono">Total value locked</span><strong data-tvl>—</strong></div><div class="tvl-changes"><span data-change="1d">1d —</span><span data-change="7d">7d —</span><span data-change="30d">30d —</span></div></div>
        <svg class="tvl-chart" data-tvl-chart viewBox="0 0 1000 220" preserveAspectRatio="none" aria-label="TVL over the last 30 days" role="img"></svg>
        <p class="card-source mono" data-source></p>
      </div>
      <div class="live-grid">
        ${table("gainers", "Stock tokens · top gainers 24h", ["Token", "Price", "24h", "Volume"])}
        ${table("losers", "Stock tokens · top losers 24h", ["Token", "Price", "24h", "Volume"])}
        ${table("perps", "Perpetuals · by volume", ["Market", "Mark", "24h", "Open interest"])}
        ${table("protocols", "DeFi protocols · by TVL", ["Protocol", "Category", "TVL", "7d"])}
      </div>
      ${table("odds", "Prediction markets · Fed, inflation, stocks", ["Event", "Odds", "Volume 24h", "Ends"])}
      <p class="fine">Odds are prices of Polymarket contracts read as probabilities. For events with price levels, the levels nearest 50% are shown. They are market prices, not a forecast by Splice, and not financial advice.</p>
      ${table("newPools", "Newest pools", ["Pool", "DEX", "Liquidity", "Created"])}
      <p class="fine">New pools are listed automatically from public market data. They are not reviewed or endorsed by Splice; many new tokens are risky. Run <code>splice report &lt;token&gt;</code> for security checks. Not financial advice.</p>
      <p class="more"><a class="text-link" href="${href(config, loc, "ask")}">Ask a question about this data ${ARROW}</a><a class="text-link" href="${href(config, loc, "docs/robinhood-chain")}">Robinhood Chain data in the CLI ${ARROW}</a></p>
    </div>
  </section>`);
}

/** Robinhood stock tokens: DEX price vs Robinhood's reference price for the token. */
export function renderStocks(config: SiteConfig): string {
  const loc: PageLoc = { host: "site", dir: "" };
  return sitePage(config, loc, { title: "Stock token premiums — Splice", description: "Robinhood stock tokens on Robinhood Chain: the DEX price next to Robinhood's reference price, with the premium or discount for each, and the company's latest SEC filings.", path: "stocks", bodyClass: "live-page" }, `
  <section class="section" data-live="stocks" data-api="${e(config.api ?? "")}">
    <div class="shell">
      <div class="section-head split-head">
        <div><p class="kicker">Stock tokens</p><h1 class="display">Premium or discount?</h1></div>
        <p class="section-lead">Each Robinhood stock token trades in a DEX pool on Robinhood Chain. This table puts that price next to Robinhood's own reference price for the token and shows the gap. Below it: the latest SEC filings of the company behind each token.</p>
      </div>
      <div class="live-card" data-table="premiums"><table><thead><tr><th>Token</th><th>DEX price</th><th>Reference</th><th>Premium</th><th>24h</th><th>Volume 24h</th><th>Liquidity</th></tr></thead><tbody><tr><td colspan="7" class="muted">Loading…</td></tr></tbody></table><p class="card-source mono" data-source></p></div>
      <p class="fine">Premium = DEX price ÷ reference price − 1. While Robinhood quotes a token tightly (bid and ask within 2%), the reference is the middle of that quote. When the US market is closed the quote widens, so the reference becomes the stock's last close (Finnhub) × the token's multiplier, marked "last close". Only tokens at the contract address Robinhood lists are shown; DEX prices come from the deepest pool per token. Not financial advice.</p>
      <div class="live-card" data-table="filings">
        <h2>SEC filings of the company behind the token</h2>
        <div class="pick" data-filings-pick role="group" aria-label="Stock token"></div>
        <table><thead><tr><th>Filed</th><th>Form</th><th>What it is</th><th>Document</th></tr></thead><tbody><tr><td colspan="4" class="muted">Loading…</td></tr></tbody></table>
        <p class="card-source mono" data-source></p>
      </div>
      <p class="fine">Filings come from SEC EDGAR for the ticker's registrant: current reports (8-K, with the reported items), quarterly and annual reports, ownership filings. Insider forms (3, 4, 5, 144) are counted instead of listed. A stock token is not the stock: read Robinhood's terms for what the token gives you.</p>
      <p class="more"><a class="text-link" href="${href(config, loc, "docs/stock-tokens")}">splice stock quote: six sources side by side ${ARROW}</a><a class="text-link" href="${href(config, loc, "live")}">Robinhood Chain live ${ARROW}</a></p>
    </div>
  </section>`);
}

/** New pools on Robinhood Chain with automated security flags. */
export function renderScreener(config: SiteConfig): string {
  const loc: PageLoc = { host: "site", dir: "" };
  return sitePage(config, loc, { title: "New token screener — Splice", description: "The newest pools on Robinhood Chain with automated GoPlus security flags, liquidity, volume and age.", path: "screener", bodyClass: "live-page" }, `
  <section class="section" data-live="screener" data-api="${e(config.api ?? "")}">
    <div class="shell">
      <div class="section-head split-head">
        <div><p class="kicker">Screener</p><h1 class="display">New tokens, checked.</h1></div>
        <p class="section-lead">The newest pools on Robinhood Chain, each with automated security flags from GoPlus. The web version of <code>splice radar</code>.</p>
      </div>
      <div class="screener-filters">
        <label class="registry-search"><span class="mono">Min liquidity</span><input type="number" min="0" step="1000" value="0" inputmode="numeric" data-screener-liq aria-label="Minimum liquidity in USD"></label>
        <label class="check"><input type="checkbox" data-screener-clean> <span>Hide tokens with danger flags</span></label>
      </div>
      <div class="live-card" data-table="screener"><table><thead><tr><th>Token</th><th>Age</th><th>Liquidity</th><th>Volume 24h</th><th>Buys / sells</th><th>Security</th></tr></thead><tbody><tr><td colspan="6" class="muted">Loading…</td></tr></tbody></table><p class="card-source mono" data-source></p></div>
      <p class="fine">Tokens are listed automatically from public market data and are not reviewed or endorsed by Splice. Flags are automated checks (honeypot, taxes, mint function, hidden owner, unverified source) and can miss risks; most new tokens are high risk. Click an address to see its contract explained. Not financial advice.</p>
    </div>
  </section>`);
}

/** Any wallet on Robinhood Chain: holdings, values where priced, recent transfers. */
export function renderWallet(config: SiteConfig): string {
  const loc: PageLoc = { host: "site", dir: "" };
  return sitePage(config, loc, { title: "Wallet viewer — Splice", description: "Look up any wallet on Robinhood Chain: ETH and token holdings, values where a price source lists the token, and recent transfers.", path: "wallet", bodyClass: "live-page" }, `
  <section class="section" data-live="wallet" data-api="${e(config.api ?? "")}">
    <div class="shell">
      <p class="kicker">Wallet</p>
      <h1 class="display">Look up any wallet.</h1>
      <p class="lead">Holdings, values and recent transfers of an address on Robinhood Chain. Read-only: nothing to connect or sign.</p>
      <form class="lookup-form" data-lookup-form>
        <input type="text" name="address" placeholder="0x… wallet address" autocomplete="off" spellcheck="false" maxlength="42" required pattern="0x[0-9a-fA-F]{40}" aria-label="Wallet address">
        <button class="btn btn-solid" type="submit">Look up</button>
      </form>
      <div data-wallet-result hidden>
        <div class="stat-grid stat-grid-4">
          ${stat("value", "Priced value")}
          ${stat("eth", "ETH")}
          ${stat("tokens", "Tokens held")}
          ${stat("risk", "Address flags")}
        </div>
        <div class="live-grid token-grid">
          <div class="live-card" data-table="holdings"><h2>Holdings</h2><table><thead><tr><th>Token</th><th>Amount</th><th>Price</th><th>Value</th></tr></thead><tbody></tbody></table><p class="card-source mono" data-source></p></div>
          <div class="live-card" data-table="transfers"><h2>Recent transfers</h2><table><thead><tr><th>Time</th><th>Dir</th><th>Token</th><th>Amount</th><th>With</th></tr></thead><tbody></tbody></table><p class="card-source mono" data-source></p></div>
        </div>
      </div>
      <p class="fine" data-wallet-note>Values use DefiLlama prices, the $SPLICE pool price and the Chainlink ETH/USD price. Tokens no price source lists are shown without a value, so "priced value" can be lower than the wallet's real worth. Not financial advice.</p>
    </div>
  </section>`);
}

/** Contract explainer: verified interface + automated flags, explained in plain English. */
export function renderExplain(config: SiteConfig): string {
  const loc: PageLoc = { host: "site", dir: "" };
  return sitePage(config, loc, { title: "Contract explainer — Splice", description: "Paste a contract address on Robinhood Chain and get its verified functions, automated security flags and a plain-English explanation.", path: "explain", bodyClass: "live-page" }, `
  <section class="section" data-live="explain" data-api="${e(config.api ?? "")}">
    <div class="shell narrow">
      <p class="kicker">Contract explainer</p>
      <h1 class="display">What does this contract do?</h1>
      <p class="lead">Paste a contract address on Robinhood Chain. Splice reads its verified interface and automated security flags, then explains them in plain English.</p>
      <form class="lookup-form" data-lookup-form>
        <input type="text" name="address" placeholder="0x… contract address" autocomplete="off" spellcheck="false" maxlength="42" required pattern="0x[0-9a-fA-F]{40}" aria-label="Contract address">
        <button class="btn btn-solid" type="submit">Explain</button>
      </form>
      <div class="ask-examples"><button type="button" class="chip" data-explain-example="${TOKEN_CA}">$SPLICE token contract</button></div>
      <div class="ask-result" data-explain-result hidden>
        <div class="explain-head"><strong data-explain-name>—</strong><span class="chips" data-explain-badges></span></div>
        <div class="chips" data-explain-flags></div>
        <div class="prose ask-answer" data-explain-text></div>
        <details class="explain-fns"><summary class="mono">Functions <span data-explain-count></span></summary><ul class="mono" data-explain-fns></ul></details>
        <p class="card-source mono" data-explain-meta></p>
      </div>
      <p class="fine">The explanation is generated by an AI model from the contract's verified interface (function and event names) and GoPlus flags. It is not a review of the source code and not an audit, and it can be wrong. Unverified contracts cannot be explained. Not financial advice.</p>
    </div>
  </section>`);
}

/** Embeddable $SPLICE card (served under /embed/, which may be framed by other sites). */
export function renderEmbed(config: SiteConfig): string {
  const base = config.siteUrl.replace(/\/$/, "");
  const v = config.assetVersion ? `?v=${e(config.assetVersion)}` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src ${e(new URL(config.api ?? base).origin)}; base-uri 'none'; form-action 'none'">
<meta name="robots" content="noindex">
<title>$SPLICE — Splice</title>
<link rel="icon" href="../favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="../assets/styles.css${v}">
<script src="../assets/app.js${v}" defer></script>
</head>
<body class="embed-body">
<a class="embed-card" href="${base}/token" target="_blank" rel="noopener" data-live="embed" data-api="${e(config.api ?? "")}">
  <div class="embed-top"><span class="embed-mark">${LOGO}</span><strong>$SPLICE</strong><span class="live-dot mono" data-embed-live>live</span></div>
  <div class="embed-price"><strong data-embed-price>—</strong><span class="chip-change" data-embed-change>24h —</span></div>
  <svg class="embed-spark" data-embed-spark viewBox="0 0 300 60" preserveAspectRatio="none" aria-hidden="true"></svg>
  <div class="embed-stats"><span>MC <b data-embed-mc>—</b></span><span>Liq <b data-embed-liq>—</b></span><span>Holders <b data-embed-holders>—</b></span></div>
  <div class="embed-foot mono">Live from Robinhood Chain · spliceloom.com</div>
</a>
</body>
</html>
`;
}

/** How to embed the $SPLICE card. */
/**
 * The agents host: official skills from the registry (rendered at build time) and the open-source
 * directory (filled in the browser from the public API).
 */
export function renderAgents(config: SiteConfig, snapshot: RegistrySnapshot, skillPages: string[]): string {
  const loc: PageLoc = { host: "agents", dir: "" };
  const link = (p: string) => href(config, loc, p);
  const cards = snapshot.skills.map((s) => {
    const install = `splice add ${s.id}${s.permissionSummary[0]?.startsWith("none") ? "" : " --accept-permissions"}`;
    return `<div class="registry-item">${skillCard(s, link, skillPages.includes(s.name))}<div class="install-row"><code>${e(install)}</code><button type="button" class="copy-inline" data-copy="${e(install)}">Copy</button></div></div>`;
  });
  return sitePage(config, loc, { title: "Agent directory — Splice", description: "Skills, agents and MCP servers in one place: verified Splice skills you can install, an open-source directory from GitHub, and free publishing to the Splice registry.", path: "", bodyClass: "live-page registry-page" }, `
  <section class="section" data-live="agents" data-api="${e(config.api ?? "")}">
    <div class="shell">
      <div class="section-head split-head">
        <div><p class="kicker">Agent directory</p><h1 class="display">Capabilities for agents, in one place.</h1></div>
        <p class="section-lead">Verified skills you can install with one command, an open-source directory of agents, MCP servers and skills, and free publishing to the Splice registry. Browsing needs no account, and nothing here costs anything.</p>
      </div>

      <h2 class="subhead mono">Open-source directory</h2>
      <div class="screener-filters">
        <div class="tf-switch" data-agents-tabs role="group" aria-label="Category"></div>
        <label class="registry-search"><span class="mono">Search</span><input type="search" placeholder="name, topic, language…" data-agents-filter autocomplete="off" spellcheck="false" aria-label="Search the directory"></label>
      </div>
      <div class="live-card" data-table="agents"><table><thead><tr><th>Repository</th><th>What it is</th><th>Stars</th><th>Language</th><th>License</th><th>Updated</th></tr></thead><tbody><tr><td colspan="6" class="muted">Loading…</td></tr></tbody></table><p class="card-source mono" data-source></p></div>
      <p class="fine">Repositories are listed automatically from GitHub by topic and stars and refreshed every few hours. They are not reviewed or endorsed by Splice: read the code and its license before you run it.</p>

      <h2 class="subhead mono">On Splice · official skills</h2>
      <p class="section-lead">Each one is signed, checked by <code>splice verify</code>, and declares the permissions it needs before it runs.</p>
      <div class="skill-grid registry-grid">
        ${cards.join("\n        ")}
      </div>

      <h2 class="subhead mono">Publish yours</h2>
      <p class="section-lead">Publishing to the Splice registry is free. While the registry is in developer preview, publisher accounts are issued on request: open an issue on GitHub and you get a token for your own namespace.</p>
      <div class="cap-grid agents-steps">
        <article class="cap"><h3>1. Write</h3><p>A skill is a folder with a manifest, its tools and the permissions it needs.</p><a class="text-link" href="${link("docs/creating-a-skill")}">Creating a skill ${ARROW}</a></article>
        <article class="cap"><h3>2. Check</h3><p>Validate and package it locally. Nothing leaves your machine.</p><pre class="code"><code>cd my-skill
splice publish --dry-run</code></pre></article>
        <article class="cap"><h3>3. Publish</h3><p>The first publish claims your namespace; versions are immutable.</p><pre class="code"><code>splice login
splice publish ./my-skill</code></pre></article>
        <article class="cap"><h3>4. Sign</h3><p>Sign versions with your own key so installs can verify who published them.</p><pre class="code"><code>splice keys generate
splice publish --sign</code></pre></article>
      </div>
      <p class="more"><a class="text-link" href="${link("docs/publishing")}">Publishing guide ${ARROW}</a><a class="text-link" href="${link("docs/signing")}">Package signing ${ARROW}</a><a class="text-link" href="${e(config.githubUrl)}/issues" rel="noopener">Request a publisher account ${ARROW}</a></p>
    </div>
  </section>`);
}

/** The Telegram bot: what it answers and which alerts it sends. */
export function renderBot(config: SiteConfig): string {
  const loc: PageLoc = { host: "site", dir: "" };
  const BOT = "https://t.me/spliceloombot";
  const group = (title: string, rows: Array<[string, string]>) =>
    `<div class="live-card"><h2>${e(title)}</h2><table><thead><tr><th>Command</th><th>What you get</th></tr></thead><tbody>${rows.map(([c, d]) => `<tr><td class="strong mono">${e(c)}</td><td>${e(d)}</td></tr>`).join("")}</tbody></table></div>`;
  return sitePage(config, loc, { title: "Telegram bot — Splice", description: "The Splice Telegram bot: live Robinhood Chain data as commands, and alerts for price levels, large trades, burns and new tokens.", path: "bot", bodyClass: "live-page" }, `
  <section class="section">
    <div class="shell">
      <div class="section-head split-head">
        <div><p class="kicker">Telegram bot</p><h1 class="display">Splice, in your chat.</h1></div>
        <p class="section-lead">Press Start and it introduces itself by your name. It answers from the same live data as this site, names the source of every number, and can message your chat when something happens. Free, and it works in groups.</p>
      </div>
      <p class="more"><a class="btn btn-solid" href="${BOT}" rel="noopener">Open @spliceloombot</a></p>
      <div class="bot-grid">
        ${group("$SPLICE", [["/splice", "Price, market cap, liquidity, volume, holders, burned"], ["/holders", "Top holders and the dev wallet"], ["/burned", "How much is burned so far"], ["/ca", "The official contract address"]])}
        ${group("Robinhood Chain", [["/tvl", "Total value locked and its change"], ["/perps", "Perpetual markets by volume"], ["/new", "Newest tokens with security flags"], ["/odds", "Prediction-market odds: Fed, inflation, stock events"]])}
        ${group("Stock tokens", [["/stocks", "Every stock token: premium or discount against the reference price"], ["/stock NVDA", "One stock token: token and underlying quote"], ["/filings NVDA", "The company's latest SEC filings"]])}
        ${group("Any address", [["/check 0x…", "Verified-source status and security flags of a token contract"], ["/wallet 0x…", "What a wallet holds"], ["/ask <question>", "A question in plain English, answered with sources"]])}
        ${group("Alerts, sent to your chat", [["/alert above 0.00002", "$SPLICE price crosses a level (also: below)"], ["/whales on 100", "$SPLICE trades of $100 or more"], ["/burns on", "Every new $SPLICE burn"], ["/radar on 10000", "New tokens with $10,000+ liquidity"], ["/alerts", "Your alerts; remove one with /alertoff"]])}
      </div>
      <p class="fine">Alerts are checked every 2 minutes; up to 10 per chat. /ask is limited to 10 questions per chat per day. Security flags are automated checks, not an audit. New tokens are listed automatically and are not reviewed or endorsed by Splice. Market data, not financial advice.</p>
      <p class="more"><a class="text-link" href="${href(config, loc, "docs/web-tools")}">How the bot and the web tools work ${ARROW}</a><a class="text-link" href="${href(config, loc, "live")}">Robinhood Chain live ${ARROW}</a></p>
    </div>
  </section>`);
}

export function renderWidgets(config: SiteConfig): string {
  const loc: PageLoc = { host: "site", dir: "" };
  const base = config.siteUrl.replace(/\/$/, "");
  const snippet = `<iframe src="${base}/embed/splice" width="340" height="260" style="border:0" loading="lazy" title="$SPLICE live price"></iframe>`;
  return sitePage(config, loc, { title: "Widgets — Splice", description: "Embed a live $SPLICE price card on your own site with one line of HTML.", path: "widgets", bodyClass: "live-page" }, `
  <section class="section">
    <div class="shell narrow">
      <p class="kicker">Widgets</p>
      <h1 class="display">Put $SPLICE on your site.</h1>
      <p class="lead">A live price card you can embed anywhere with one line of HTML. It updates itself from Robinhood Chain and links back to the token page.</p>
      <div class="widget-preview"><iframe src="${href(config, loc, "embed/splice")}" width="340" height="260" loading="lazy" title="$SPLICE live price"></iframe></div>
      <h2 class="subhead mono">Embed code</h2>
      <div class="install-row"><code>${e(snippet)}</code><button type="button" class="copy-inline" data-copy="${e(snippet)}">Copy</button></div>
      <p class="fine">The card is served by spliceloom.com, sets no cookies and loads no third-party scripts. Market data is not financial advice.</p>
    </div>
  </section>`);
}
/** Ask: the research agent in the browser, rate-limited, every answer with its tool calls and sources. */
export function renderAsk(config: SiteConfig): string {
  const loc: PageLoc = { host: "site", dir: "" };
  const examples = ["What is the total value locked on Robinhood Chain?", "Which Robinhood stock tokens moved the most today?", "Top perpetual markets on Robinhood Chain by volume", "Show me the $SPLICE token supply and holders"];
  return sitePage(config, loc, { title: "Ask — Splice", description: "Ask questions about Robinhood Chain in plain English. Splice answers from live data and shows every tool call and source.", path: "ask", bodyClass: "live-page" }, `
  <section class="section" data-live="ask" data-api="${e(config.api ?? "")}">
    <div class="shell narrow">
      <p class="kicker">Ask</p>
      <h1 class="display">Ask Robinhood Chain anything.</h1>
      <p class="lead">The agent behind <code>splice ask</code>, in your browser. It calls Splice's read-only data tools, shows each call with its status, and answers with its sources.</p>
      <form class="ask-form" data-ask-form>
        <label class="visually-hidden" for="ask-q">Question</label>
        <textarea id="ask-q" name="q" rows="2" maxlength="300" placeholder="Ask about tokens, stock tokens, perps, DeFi or wallets…" required></textarea>
        <div class="ask-actions"><span class="mono" data-ask-count>0 / 300</span><button class="btn btn-solid" type="submit">Ask</button></div>
      </form>
      <div class="holder-box" data-holder>
        <button type="button" class="btn btn-ghost btn-sm" data-holder-connect>Connect wallet</button>
        <span class="mono" data-holder-status>Holders of 100,000+ $SPLICE get 50 questions a day. Signing a message only: no transaction, no gas.</span>
      </div>
      <div class="ask-examples">${examples.map((q) => `<button type="button" class="chip" data-ask-example="${e(q)}">${e(q)}</button>`).join("")}</div>
      <div class="ask-result" data-ask-result hidden>
        <ul class="ask-calls mono" data-ask-calls></ul>
        <div class="prose ask-answer" data-ask-answer></div>
        <p class="card-source mono" data-ask-meta></p>
      </div>
      <p class="fine">Free questions are limited per visitor and per day. For unlimited questions, run <code>npm install -g @spliceloom/cli</code> and <code>splice ask</code> with your own keys. Answers come from live data and can still be wrong; not financial advice. Questions are processed by the AI model provider and are not stored by Splice.</p>
    </div>
  </section>`);
}
