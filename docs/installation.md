# Installation

Requirements: **Node.js 22.18 or newer** on Windows, macOS or Linux. Splice has no runtime
dependencies beyond Node.js.

## From npm

The CLI is published as `@spliceloom/cli` and installs the `splice` command:

```sh
npm install -g @spliceloom/cli
splice --version
```

> **npm:** `npm install -g @spliceloom/cli` installs the `splice` command (Node.js >= 22.18; a
> developer preview). The scoped name is used because the unscoped npm name `splice`
> belongs to an unrelated package. Installing from source, below, is for contributors.

### Windows PowerShell

If PowerShell says `splice.ps1 cannot be loaded because running scripts is disabled on this
system`, the execution policy blocks the script shim that npm creates for every global command
(`npm` itself included). Either run the `.cmd` shim, which the policy does not affect:

```powershell
splice.cmd --version
```

or allow local scripts for your user once, then open a new terminal:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

In PowerShell, escape double quotes inside arguments: `splice run json.parse 'text={\"ok\":true}'`.

## From source

```sh
git clone https://github.com/spliceloom/spliceloom.git && cd spliceloom
npm install && npm run build
npm link -w @spliceloom/cli      # makes `splice` available globally
splice --version
```

Without `npm link` you can run the CLI directly with `node packages/cli/dist/bin.js`.

## The SDK

Applications use the TypeScript SDK, `@spliceloom/sdk` (see [SDK](sdk.md)). It is not on npm
yet; use it from a source checkout of
[github.com/spliceloom/spliceloom](https://github.com/spliceloom/spliceloom) (`npm install && npm run build`,
then depend on `packages/sdk`).

## Check the installation

```sh
splice --help
splice config get registry
splice chain info
```

`splice config get registry` shows which registry the CLI uses (default:
`https://registry.spliceloom.com`). `splice chain info` reads Robinhood Chain live without
any key.

## Add provider keys

Many features work without keys. The rest need a provider key — most have free tiers:

```sh
splice setup --init     # creates ~/.splice/.env with every variable name, no values
splice setup            # what works now, what each key unlocks, where to create it
```

Open `~/.splice/.env` (Windows: `notepad $HOME\.splice\.env`; macOS/Linux: `nano ~/.splice/.env`),
paste your keys after the `=` signs and save. Keys there work from every folder; a `.env.local` in
the current folder or real environment variables take precedence. `splice providers` checks every
configured provider live. Values are never printed. Details:
[Environment variables](environment-variables.md); a tour of every feature: [Quickstart](quickstart.md).

## Uninstall

```sh
npm uninstall -g @spliceloom/cli
```

Splice keeps user data in `~/.splice` (provider keys in `.env`, saved registry tokens, the verified
artifact cache, the watchlist and user configuration); delete that folder to remove it. Projects keep their own `splice.json`,
`splice.lock` and `.splice/` folder.
