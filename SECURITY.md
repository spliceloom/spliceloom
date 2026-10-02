# Security policy

## Reporting a vulnerability

Please report vulnerabilities **privately** — do not open a public issue. Use GitHub's private
vulnerability reporting: **[Report a vulnerability](https://github.com/spliceloom/spliceloom/security/advisories/new)**
(Security tab → "Report a vulnerability"). Include the affected versions, reproduction steps and
impact.

Do not include real credentials in reports. If you believe a token or key was exposed, say so and
it will be revoked and rotated.

## Supported versions

| Component | Supported |
| --- | --- |
| `@spliceloom/cli` | the latest release on npm |
| Registry (`registry.spliceloom.com`) | the deployed version |
| Official skills (`@splice/*`) | the latest version of each skill |

## Scope

- the `splice` CLI, SDK, runtime/sandbox, data layer and MCP servers (`packages/*`);
- the registry (`apps/registry`) and its public API;
- the official skills (`skills/*`, `@splice/*` packages);
- the website and docs (`apps/site`).

Third-party skills published by other users are the responsibility of their publishers; reports
about malicious packages are welcome.

## What Splice guarantees — and what it does not

Read the [security model](https://docs.spliceloom.com/security). In short: artifact integrity
(SHA-256, immutable versions, verified before extraction) is enforced; publisher authenticity is not
(no package signatures yet); the runtime restricts tools with the Node.js permission model and an
in-process network guard, which is not OS-level isolation; provider keys stay in the host process and
are redacted from results.
