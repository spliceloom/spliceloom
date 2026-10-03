# FAQ

### What is Splice?

A package layer for autonomous agents: a registry, a CLI/SDK and a sandboxed runtime for
**skills** — versioned packages of tools with typed inputs/outputs and declared permissions. You
search, install, verify and run skills, and compose them into agents. It is infrastructure, not an
agent, chatbot or LLM framework.

### What is a Splice package (skill)?

A directory with `manifest.json` (identity, version, runtime requirements, permissions, tools and
their JSON schemas), `SKILL.md` (documentation) and tool modules (TypeScript/JavaScript with a
default export). It is published as a deterministic `.tar.gz`. See
[authoring-skills.md](authoring-skills.md) and [spec.md](spec.md).

### Why not just npm?

npm distributes code; Splice distributes *capabilities an agent may call*. The differences are
enforced, not conventions:

- every tool has machine-readable input/output schemas that agents and MCP clients consume;
- every package declares its permissions, installation needs explicit consent, and the runtime
  denies everything undeclared (files, network, environment, child processes);
- installing runs no package code (no install scripts);
- tools execute in a separate restricted process per call, not inside your application.

Splice itself is distributed through npm (`@spliceloom/cli`).

### How does verification work?

Before anything is extracted: the artifact's SHA-256 and size must match the registry metadata,
the archive is decoded safely (no path traversal, links or oversized entries), the package is
validated, and the manifest inside must equal the registry's manifest. `splice verify` also checks
provenance, the direct GitHub Releases URL and your installed copy. After installation,
`splice.lock` records a digest of the extracted files, re-checked before code is loaded.
Details: [trust.md](trust.md).

### Does SHA-256 prove who published a package?

No. It proves you got the exact bytes the registry recorded. Who published is recorded as
provenance by the registry, but packages are **not signed** yet. See
[security.md](security.md#integrity-is-not-authenticity).

### Where are artifacts stored?

As GitHub Release assets in the public repository `spliceloom/splice-artifacts`; metadata
(versions, integrity, provenance, users, tokens as hashes) lives in Cloudflare D1. The registry
Worker serves downloads, and each version record also lists the direct GitHub URL.

### Does Splice require R2?

No. R2 is not used. The storage backend is an interface; GitHub Releases is the production
backend.

### Does Splice require an LLM or an API key?

No. The registry, CLI, SDK and runtime involve no model. The example agents are rule-based and
run without any API key. Agents that *use* Splice may of course use an LLM.

### Can I use Splice with MCP?

Yes. `splice mcp` serves the installed skills over stdio; `splice mcp --http` over Streamable
HTTP with a bearer token. The registry also offers an authenticated discovery-only MCP endpoint.
See [mcp.md](mcp.md).

### Can I use Splice without an agent?

Yes: `splice run` from a terminal or scripts, or the SDK (`splice.run(...)`) from any Node.js
program.

### How are permissions enforced?

By the runtime, not by trusting the package: file access through the Node.js permission model,
child processes/workers/addons/eval denied, a network guard that allows only declared hosts and
refuses private addresses, and an empty environment except declared variables. It is a strong
guardrail inside Node.js, **not** OS-level isolation (no containers/VMs). See
[permissions.md](permissions.md) and [security.md](security.md).

### Can packages access `.env`?

Not unless a package declares a file permission covering it and you accept it. Tools can only
read their own package directory and declared project paths; `.env` files are never packed into
packages; `@splice/files` refuses credential-like names even inside its sandbox. Environment
variables are passed only when declared (`permissions.env`).

### Can packages execute arbitrary processes?

No. Child processes are denied by the runtime, and there is intentionally no official process
execution skill: a child process would escape the sandbox. See
[permissions.md](permissions.md#why-there-is-no-process-execution-skill).

### How do I publish a package?

`splice publish ./my-skill --dry-run` to validate locally, `splice login` with a registry token,
then `splice publish ./my-skill`. Versions are immutable. Accounts are created by a registry admin
(there is no public sign-up yet). See [publishing.md](publishing.md).

### How does `splice.lock` work?

`splice.json` records the ranges you asked for; `splice.lock` records exactly what is installed:
version, SHA-256, size, registry, download URL, granted permissions and a digest of the extracted
files. `splice install` on another machine installs exactly those bytes and fails closed if the
registry serves anything else. `splice update` moves within your ranges. See
[lifecycle.md](lifecycle.md).

### What happens if the registry is down?

Installed packages keep working (`splice run`, `splice mcp`, the SDK). `splice install` can
install locked versions from the verified local cache. Commands that need the registry report
`REGISTRY_UNREACHABLE` (network) or `REGISTRY_UNAVAILABLE` (HTTP 503) with a hint.

### Is Splice publicly launched?

As a developer preview. The registry (`registry.spliceloom.com`), the official skills, the CLI
(`npm install -g @spliceloom/cli`), the SDK (`npm install @spliceloom/sdk`), the website, these docs
and the [source](https://github.com/spliceloom/spliceloom) are public. Accounts for publishing are
created by the registry admin.

### Does Splice have a token?

Not yet. A Splice token is planned; its contract address will be announced only through the
official channels — [spliceloom.com](https://spliceloom.com) and [@spliceloom on X](https://x.com/spliceloom). **Any token that claims to be
Splice before that announcement is not ours.** Splice will never ask for a seed phrase, a private key
or a payment to install, verify or run a skill.
