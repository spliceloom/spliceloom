# Private registry

> **Coming later.** Private registries are planned and **not available yet**. Everything published
> today is public.

## What is available now

- Run your own registry: the registry is part of the source repository and can be deployed to your
  own Cloudflare account or run locally on Node.js with SQLite. Point clients at it with
  `--registry` or `splice config set registry <url>`.
- Restrict who can publish into a namespace with owners, maintainers and scoped tokens.
- Note that reads are anonymous: anyone who can reach your registry can read its packages.

## What is planned

- Private namespaces whose packages require authentication to read.
- Internal skills shared inside an organization ([Organizations](organizations.md)).
- An audit trail of publishes and installs.
- A dashboard (planned at `app.spliceloom.com`) for packages, providers, API keys, activity and
  settings.

This page will document configuration when the features ship.
