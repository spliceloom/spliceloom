/**
 * Local preview server for the built site (static files only, loopback only).
 *
 *   node apps/site/serve.ts [dir] [--port 4321]
 */
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
};

export function startServer(dir: string, port = 4321) {
  const root = resolve(dir);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let path = decodeURIComponent(url.pathname);
      // Clean URLs, like the production host: /docs/cli serves docs/cli.html; *.html redirects there.
      if (path.endsWith(".html")) {
        const clean = path === "/index.html" || path.endsWith("/index.html") ? path.slice(0, -"index.html".length) : path.slice(0, -".html".length);
        res.writeHead(308, { location: clean + url.search }).end();
        return;
      }
      if (path.endsWith("/")) path += "index.html";
      else if (!extname(path)) path += ".html";
      const file = normalize(join(root, path));
      if (file !== root && !file.startsWith(root + sep)) throw Object.assign(new Error("forbidden"), { status: 403 });
      const info = await stat(file).catch(() => null);
      const target = info?.isFile() ? file : join(root, "404.html");
      const body = await readFile(target);
      res.writeHead(info?.isFile() ? 200 : 404, {
        "content-type": TYPES[extname(target)] ?? "application/octet-stream",
        "x-content-type-options": "nosniff",
        "referrer-policy": "strict-origin-when-cross-origin",
        "x-frame-options": "DENY",
      });
      res.end(body);
    } catch (error) {
      if (res.headersSent) res.destroy();
      else res.writeHead((error as { status?: number }).status ?? 500).end();
    }
  });
  return new Promise<{ url: string; close: () => Promise<void> }>((resolvePromise) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      resolvePromise({ url: `http://127.0.0.1:${actual}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const portIndex = args.indexOf("--port");
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 4321;
  const dir = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--port") ?? join(dirname(fileURLToPath(import.meta.url)), "dist");
  const { url } = await startServer(dir, port);
  console.log(`Splice site preview: ${url}  (serving ${resolve(dir)}; Ctrl+C to stop)`);
}
