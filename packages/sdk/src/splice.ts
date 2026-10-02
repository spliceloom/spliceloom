import { resolve as resolvePath } from "node:path";
import {
  ArtifactCache,
  CoreError,
  RegistryClient,
  SpliceProject,
  getToken,
  publishPackage,
  resolveRegistry,
  verifyPackage,
  type VerificationReport,
  type AddOptions,
  type AddResult,
  type FetchLike,
  type InstalledPackage,
  type OutdatedPackage,
  type PublishOptions,
  type PublishResult,
  type UpdateOptions,
  type UpdateResult,
} from "@spliceloom/core";
import { SpliceRuntime, type CapabilityBroker, type LoadedPackage, type ToolResult } from "@spliceloom/runtime";
import { SpliceData, createCapabilityBroker, type CallOptions, type SpliceDataOptions } from "@spliceloom/data";
import {
  describeTools,
  parsePackageRef,
  type Manifest,
  type PackageResponse,
  type SearchResult,
  type ToolDescriptor,
  type VersionResponse,
  type WhoamiResponse,
} from "@spliceloom/spec";
import { ProjectPackageManager, ProjectSkillLoader, RegistryPackageResolver } from "./defaults.js";
import type { PackageManager, PackageResolver, SkillLoader, SkillRuntime } from "./interfaces.js";

export interface SpliceOptions {
  /**
   * Registry URL or alias (`local`, `production`). When omitted it is resolved like the CLI does:
   * SPLICE_REGISTRY → splice.json "registry" → ~/.splice/config.json → the configured default.
   */
  registry?: string;
  /** Project directory (contains splice.json). Default: `process.cwd()`. */
  project?: string;
  /** Registry token for publish/whoami. Default: SPLICE_TOKEN or the credential saved by `splice login`. */
  token?: string;
  /** Environment used for registry/credential resolution and passed (filtered) to tools. Default: process.env. */
  env?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  /**
   * Local artifact cache directory (content-addressed by SHA-256; artifacts only, never
   * credentials). Default: `<SPLICE_HOME>/cache/artifacts`. `false` disables the cache.
   */
  cache?: string | false;
  /**
   * Live data providers (Robinhood Chain RPC, Blockscout, CoinGecko, GoPlus, Zerion, …). Keys are
   * read only from the provider environment variables (process env, then .env.local / .env).
   */
  data?: SpliceDataOptions;
  /**
   * Host capability broker for skills that declare `permissions.capabilities`. Default: the live
   * data layer above (created on first use, with the host's provider keys). `false` disables it:
   * capability calls then answer CAPABILITY_UNAVAILABLE.
   */
  broker?: CapabilityBroker | false;
  /** Replace default components (advanced / tests). */
  resolver?: PackageResolver;
  packages?: PackageManager;
  loader?: SkillLoader;
  runtime?: SkillRuntime;
}

export interface PackageInfo {
  package: PackageResponse;
  /** The version selected by the requested range (latest by default). */
  version: VersionResponse;
  tools: ToolDescriptor[];
}

/** A loaded, validated, installed skill package. */
export class Skill {
  readonly id: string;
  readonly version: string;
  readonly manifest: Manifest;
  readonly dir: string;
  readonly tools: ToolDescriptor[];

  constructor(
    readonly pkg: LoadedPackage,
    private readonly runtime: SkillRuntime,
  ) {
    this.id = pkg.id;
    this.version = pkg.manifest.version;
    this.manifest = pkg.manifest;
    this.dir = pkg.dir;
    this.tools = describeTools(pkg.manifest);
  }

  /** Finds a tool by `hello`, `example.hello`, `@splice/example.hello` or its MCP name. */
  tool(name: string): ToolDescriptor | undefined {
    return this.tools.find((t) => t.tool === name || t.name === name || t.qualifiedName === name || t.mcpName === name);
  }

  /**
   * Runs a tool in the sandbox. Tool-level failures (invalid input, permission denied, timeout, …)
   * are returned as `{ ok: false, error }`, never thrown.
   */
  async run(name: string, input: unknown = {}): Promise<ToolResult> {
    const descriptor = this.tool(name);
    // Unknown names go to the runtime unchanged so it reports TOOL_NOT_FOUND consistently.
    return this.runtime.execute(this.pkg, descriptor?.tool ?? name, input);
  }
}

/**
 * Splice SDK entry point.
 *
 * ```ts
 * const splice = new Splice({ registry: "https://splice-registry.example.dev", project: "./agent" });
 * await splice.init();
 * await splice.add("@splice/example");
 * const skill = await splice.load("@splice/example");
 * const result = await skill.run("example.hello", { name: "Dim" });
 * ```
 */
export class Splice {
  readonly projectDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly options: SpliceOptions;
  private clientPromise: Promise<RegistryClient> | undefined;
  private runtimePromise: Promise<SkillRuntime> | undefined;
  readonly resolver: PackageResolver;
  readonly packages: PackageManager;
  readonly loader: SkillLoader;

  constructor(options: SpliceOptions = {}) {
    this.options = options;
    this.env = options.env ?? process.env;
    this.projectDir = resolvePath(options.project ?? process.cwd());
    const client = () => this.registry();
    const project = () => SpliceProject.require(this.projectDir);
    const cache = options.cache === false ? null : options.cache ? new ArtifactCache(resolvePath(options.cache)) : ArtifactCache.forHome(this.env);
    this.resolver = options.resolver ?? new RegistryPackageResolver(client);
    this.packages = options.packages ?? new ProjectPackageManager(project, client, cache);
    this.loader = options.loader ?? new ProjectSkillLoader(project);
  }

  /**
   * The runtime used by loaded skills. The default sandbox resolves declared file permissions
   * relative to the project root (the directory containing splice.json, which may be a parent
   * of `project`).
   */
  runtime(): Promise<SkillRuntime> {
    this.runtimePromise ??= this.options.runtime
      ? Promise.resolve(this.options.runtime)
      : SpliceProject.require(this.projectDir).then((p) => {
          const runtimeOptions: ConstructorParameters<typeof SpliceRuntime>[0] = { projectRoot: p.root, env: this.env };
          // Skills reach host capabilities only through this broker; the data layer is created lazily.
          if (this.options.broker !== false) runtimeOptions.broker = this.options.broker ?? createCapabilityBroker(() => this.data);
          return new SpliceRuntime(runtimeOptions);
        });
    return this.runtimePromise;
  }

  // ------------------------------------------------------------------ live data

  private dataLayer: SpliceData | undefined;

  /**
   * The live data layer (providers, chains, stocks, indexing, …). Every call goes to real
   * providers and returns LIVE / CACHED / UNAVAILABLE / ERROR with provenance — never invented data.
   */
  get data(): SpliceData {
    this.dataLayer ??= new SpliceData({ env: this.env, cwd: this.projectDir, ...this.options.data });
    return this.dataLayer;
  }

  /** On-chain data (Robinhood Chain by default). */
  get onchain() {
    const d = this.data;
    return {
      ...d.onchain,
      /** `splice.onchain.block()` = latest block; `block(77149369)` or `block("0x…hash")`. */
      block: (id: string | number = "latest", options?: CallOptions) => d.onchain.block(id, options),
    };
  }

  /** Market data (CoinGecko). */
  get market() {
    return this.data.market;
  }

  /** Security data (GoPlus). */
  get security() {
    return this.data.security;
  }

  /** Wallet intelligence (RPC, Blockscout, Zerion, GoPlus). */
  get wallet() {
    return this.data.wallet;
  }

  /** AI completions and model lists from real providers (OpenRouter; Gemini when configured). */
  get ai() {
    return this.data.ai;
  }

  /** Read-only GitHub data (REST API with GITHUB_TOKEN or anonymously; public raw files). */
  get github() {
    return this.data.github;
  }

  /** Web search, page extraction, site maps, similar pages, cited answers (Tavily, Exa, Firecrawl). */
  get web() {
    return this.data.web;
  }

  /** Every Robinhood Chain token (Codex): rankings, search, details, trades, charts, whales, prices. */
  get tokens() {
    return this.data.tokens;
  }

  /** Token research reports (Codex + GoPlus + Blockscout), each flag naming its source. */
  get research() {
    return this.data.research;
  }

  /** Robinhood Stock Tokens: list, per-source quotes, rankings. */
  get stocks() {
    return this.data.stocks;
  }

  /** Perpetual and spot markets on Lighter (Robinhood Chain deployment by default), funding rates. */
  get perps() {
    return this.data.perps;
  }

  /** Robinhood Chain DeFi from DefiLlama: TVL, protocols, DEX volume, fees, stablecoins, yields, prices. */
  get defi() {
    return this.data.defi;
  }

  /** Global crypto market, Fear & Greed, top coins, US equities (CoinGecko, alternative.me, Chainlink). */
  get global() {
    return this.data.global;
  }

  /** US companies (Finnhub): quote, profile, news, earnings, market status. */
  get equities() {
    return this.data.equities;
  }

  /** Market news (Finnhub). */
  get news() {
    return this.data.news;
  }

  /** US macro series (FRED). */
  get macro() {
    return this.data.macro;
  }

  /** Chainlink oracle prices, candles and feed catalog. */
  get oracle() {
    return this.data.oracle;
  }

  /** Provider health (live checks) and last known status. */
  get providers() {
    return this.data.providers;
  }

  // ------------------------------------------------------------------ registry

  /** Registry client for the configured registry. */
  registry(): Promise<RegistryClient> {
    this.clientPromise ??= (async () => {
      const found = await SpliceProject.find(this.projectDir);
      const projectRegistry = found ? (await found.readConfig()).registry : undefined;
      const { url } = await resolveRegistry({ override: this.options.registry, env: this.env, projectRegistry });
      return new RegistryClient(url, this.options.fetch);
    })();
    return this.clientPromise;
  }

  async registryUrl(): Promise<string> {
    return (await this.registry()).baseUrl;
  }

  async search(query: string, options: { limit?: number } = {}): Promise<SearchResult[]> {
    return (await (await this.registry()).search(query, options.limit ?? 20)).results;
  }

  /** Registry metadata, the selected version and its tool descriptors (from the published manifest). */
  async info(ref: string): Promise<PackageInfo> {
    const { id, version } = await this.resolver.resolve(ref);
    const client = await this.registry();
    const [pkg, selected] = await Promise.all([client.getPackage(id), client.getVersion(id, version)]);
    return { package: pkg, version: selected, tools: describeTools(selected.manifest) };
  }

  resolve(ref: string): Promise<{ id: string; version: string }> {
    return this.resolver.resolve(ref);
  }

  private async token(): Promise<string | null> {
    if (this.options.token) return this.options.token;
    return (await getToken(await this.registryUrl(), this.env))?.token ?? null;
  }

  async whoami(): Promise<WhoamiResponse> {
    const token = await this.token();
    if (!token) throw new CoreError("NOT_LOGGED_IN", `No registry token for ${await this.registryUrl()}.`, { hint: "Pass `token` or run `splice login`." });
    return (await this.registry()).whoami(token);
  }

  /**
   * Verifies a published version without installing it: artifact SHA-256 and size, package
   * validity, registry metadata vs. the manifest inside the artifact, provenance, the direct
   * artifact URL, and — when installed in this project — the installed files. Verification
   * failures are reported in the result (`verified: false`), not thrown.
   */
  async verify(ref: string): Promise<VerificationReport> {
    const options: { project?: SpliceProject } = {};
    const project = await SpliceProject.find(this.projectDir);
    if (project) options.project = project;
    return verifyPackage(await this.registry(), ref, options);
  }

  async publish(dir: string, options: PublishOptions = {}): Promise<PublishResult> {
    return publishPackage(await this.registry(), resolvePath(this.projectDir, dir), options.dryRun ? null : await this.token(), options);
  }

  // ------------------------------------------------------------------ project

  /** Creates splice.json in the project directory if needed. */
  async init(): Promise<{ root: string; created: boolean }> {
    const options: { registry?: string } = {};
    if (this.options.registry) options.registry = this.options.registry;
    const { project, created } = await SpliceProject.init(this.projectDir, options);
    return { root: project.root, created };
  }

  /**
   * Resolves, downloads, verifies (SHA-256 + validation) and installs a package. Runs no package code.
   * `@ns/name` installs the newest stable version; `@ns/name@<range>` keeps the locked version when
   * it satisfies the range.
   */
  add(ref: string, options?: AddOptions): Promise<AddResult> {
    parsePackageRef(ref);
    return this.packages.add(ref, options);
  }

  /**
   * Installs the project exactly as recorded in splice.lock (versions and SHA-256; fails closed with
   * LOCK_MISMATCH when the registry serves anything else), plus splice.json packages not locked yet.
   * Offline, locked versions are installed from the verified local cache.
   */
  install(options?: AddOptions): Promise<AddResult[]> {
    return this.lifecycle("install").call(this.packages, options);
  }

  /** Locked versions vs. the newest registry versions (in range and overall). Read-only. */
  outdated(ids: string[] = []): Promise<OutdatedPackage[]> {
    return this.lifecycle("outdated").call(this.packages, ids);
  }

  /**
   * Updates packages (all, or `ids`) to the newest version allowed by their splice.json range.
   * Every update is verified and swapped in atomically; a failure keeps the previous version.
   */
  update(ids: string[] = [], options?: UpdateOptions): Promise<UpdateResult[]> {
    return this.lifecycle("update").call(this.packages, ids, options);
  }

  private lifecycle<K extends "install" | "outdated" | "update">(name: K): NonNullable<PackageManager[K]> {
    const method = this.packages[name];
    if (!method) throw new CoreError("INVALID_CONFIG", `The configured package manager does not implement ${name}().`);
    return method as NonNullable<PackageManager[K]>;
  }

  remove(id: string): Promise<{ id: string; version: string | null }> {
    return this.packages.remove(id);
  }

  list(): Promise<InstalledPackage[]> {
    return this.packages.list();
  }

  /** Loads an installed package (`@ns/name` or unambiguous short name). */
  async load(ref: string): Promise<Skill> {
    return new Skill(await this.loader.load(ref), await this.runtime());
  }

  /** Every tool of every installed package, or only those of `ref` (`@ns/name` or short name). */
  async tools(ref?: string): Promise<ToolDescriptor[]> {
    if (ref !== undefined) return describeTools((await this.loader.load(ref)).manifest);
    return (await this.loader.installed()).flatMap((pkg) => describeTools(pkg.manifest));
  }

  /** Runs `example.hello` / `@splice/example.hello`. */
  async run(toolRef: string, input: unknown = {}): Promise<ToolResult> {
    const dot = toolRef.lastIndexOf(".");
    if (dot <= 0) throw new CoreError("NOT_INSTALLED", `Invalid tool reference "${toolRef}". Expected <package>.<tool>.`);
    const skill = await this.load(toolRef.slice(0, dot));
    return skill.run(toolRef.slice(dot + 1), input);
  }
}
