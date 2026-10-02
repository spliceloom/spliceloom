# @splice/files

Read, write and list files — **only inside the project's `workspace/` directory** (next to
`splice.json`). Use it to give an agent a scratch space for inputs, notes and results.

**Permissions: `fs.read: ["workspace"]`, `fs.write: ["workspace"]`.** Installing needs
`--accept-permissions`. The directory is created on first use. Everything else on the machine —
including the rest of the project, `splice.json`, `.splice/` and `.env` next to it — is
unreadable for this package: the Node.js permission model enforces the declared paths.

On top of that, the tools refuse:

- absolute paths (`/etc/passwd`, `C:/…`, `~/…`) and `..` segments → `PATH_OUTSIDE_SANDBOX`,
- backslashes, NUL bytes, empty or `.` segments, paths over 512 chars → `INVALID_PATH`,
- symbolic links and Windows junctions/reparse points (never followed; a path whose real
  location is outside `workspace/` is refused),
- hard links: files with more than one link are refused (`HARD_LINK`) — a hard link can alias a
  file outside the sandbox,
- Windows-unsafe names, on every platform (`INVALID_PATH`): reserved device names (`CON`, `NUL`,
  `COM1`, `LPT1`, … with any extension), names ending in a dot or space (`.env.` would open
  `.env` on Windows), `:` (alternate data streams like `a.txt:secret`), 8.3 aliases (`SECRET~1`),
  `< > " | ? *` and control characters; UNC (`//server/share`) and drive-letter paths are
  `PATH_OUTSIDE_SANDBOX`,
- credential-like names anywhere in the path, even inside `workspace/` → `SENSITIVE_PATH`:
  `.env`, `.env.*`, `.envrc`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `*.kdbx`,
  `*.ppk`, `*.asc`, `*.gpg`, `id_rsa`/`id_ed25519`/… , `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`,
  `.docker`, `.npmrc`, `.yarnrc`, `.netrc`, `.pgpass`, `.git-credentials`, `.pypirc`,
  `credentials*`, `secret(s)*`. Listings hide such entries (and count them in `hidden`).

Files are opened first and checked again through the descriptor (regular file, single link, same
file as the in-workspace path) before anything is read or written. Remaining limitation: another
process that modifies the workspace *at the same time* could race a directory swap while a new
file is being created.

No network and no environment variables.

Changes in 0.1.1: Windows name rules, hard-link refusal, descriptor re-check, bounded reads even if
a file grows during the read.

## Tools

### `files.read`

Input: `path` (required, relative to `workspace/`), `encoding` (`utf8` | `base64`, default
`utf8`), `maxBytes` (1–524288, default 262144).
Output: `{ path, size, encoding, content, modifiedAt }`.
Errors: `NOT_FOUND`, `NOT_A_FILE`, `FILE_TOO_LARGE`, plus the path errors above.

### `files.write`

Input: `path`, `content` (≤ 1 MiB decoded), `encoding` (`utf8` | `base64`), `mode`
(`create` — default, fails with `ALREADY_EXISTS` if the file exists — `overwrite`, `append`),
`createDirs` (default `true`).
Output: `{ path, bytes, size, created }`.

### `files.list`

Input: `path` (default `.` = the workspace), `recursive` (default `false`, max depth 16),
`maxEntries` (1–2000, default 500).
Output: `{ path, entries: [{ path, type: "file" | "directory" | "symlink" | "other", size }], truncated, hidden }`,
sorted by name, breadth first.

## Examples

```sh
splice add @splice/files --accept-permissions
splice run files.write path=notes/today.md content="# Notes"
splice run files.read path=notes/today.md
splice run files.list recursive=true
```

See `examples/`.
