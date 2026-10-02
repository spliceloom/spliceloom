#!/usr/bin/env node
/** Local development registry (Node.js + SQLite + file-system artifacts). */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { hashToken } from "./auth.js";
import { FsArtifactStore, createSqliteDatabase, serveRegistry } from "./node.js";
import { dataDir } from "./paths.js";
import { localRateLimits } from "./ratelimit.js";
import { RegistryService } from "./service.js";

const dir = dataDir();
const port = Number(process.env.PORT ?? "8787");
const host = process.env.HOST ?? "127.0.0.1";
// The plaintext admin token is only hashed here and never kept or logged.
const adminToken = process.env.SPLICE_ADMIN_TOKEN;

mkdirSync(dir, { recursive: true });
const db = createSqliteDatabase(join(dir, "registry.db"));
const service = new RegistryService(db, new FsArtifactStore(join(dir, "artifacts")));
const options: Parameters<typeof serveRegistry>[0] = { service, port, host, rateLimits: localRateLimits(db) };
if (adminToken) options.adminTokenHash = await hashToken(adminToken);
const running = await serveRegistry(options);

console.log(`Splice registry (local) listening on ${running.url}`);
console.log(`data: ${dir}`);
console.log(`admin API: ${adminToken ? "enabled (SPLICE_ADMIN_TOKEN)" : "disabled"}`);

const shutdown = () => {
  running
    .close()
    .then(() => service.close())
    .then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
