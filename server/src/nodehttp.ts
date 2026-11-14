// Node http ↔ Fetch 适配：把 Node 的 IncomingMessage 转成 fetch Request 交给业务 handler，
// 再把 Response 写回 Node。另在 /ui/ 同源托管前端静态文件（与 API 同源，无需跨域配置）。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { promises as fs } from "node:fs";
import * as path from "node:path";

const MAX_BODY_BYTES = 32 * 1024 * 1024; // 上报与表单请求体上限（视频不走请求体）

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

type FetchHandler = (req: Request, env: unknown) => Promise<Response>;

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

async function serveStatic(staticDir: string, urlPath: string, res: ServerResponse): Promise<boolean> {
  // 只服务 /ui/*；/ui 重定向到 /ui/
  if (urlPath === "/ui") {
    res.writeHead(302, { Location: "/ui/" });
    res.end();
    return true;
  }
  if (!urlPath.startsWith("/ui/")) return false;
  let rel = decodeURIComponent(urlPath.slice("/ui/".length));
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  const resolved = path.normalize(path.join(staticDir, rel));
  if (!resolved.startsWith(staticDir)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("禁止访问");
    return true;
  }
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new Error("not a file");
    const ext = path.extname(resolved).toLowerCase();
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[ext] ?? "application/octet-stream",
      "Content-Length": String(stat.size),
      "Cache-Control": "no-store",
    });
    const stream = (await import("node:fs")).createReadStream(resolved);
    stream.pipe(res);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("页面不存在");
  }
  return true;
}

export function createHttpServer(
  fetchHandler: FetchHandler,
  env: unknown,
  opts: { staticDir: string },
): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // 用 Host 头拼完整 URL：签名下载链接取 url.origin，必须带真实端口
      const host = req.headers.host || "127.0.0.1";
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (req.method === "GET" && url.pathname === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "GET" && (await serveStatic(opts.staticDir, url.pathname, res))) return;

      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      }
      let body: Buffer | undefined;
      if (req.method !== "GET" && req.method !== "HEAD") {
        const buf = await readBody(req);
        if (buf === null) {
          res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "请求体过大" }));
          return;
        }
        if (buf.length > 0) body = buf;
      }
      const request = new Request(url.toString(), {
        method: req.method,
        headers,
        body: body as unknown as BodyInit | undefined,
      });
      const response = await fetchHandler(request, env);

      const outHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        outHeaders[k] = v;
      });
      res.writeHead(response.status, outHeaders);
      if (!response.body) {
        res.end();
        return;
      }
      const nodeStream = Readable.fromWeb(response.body as never);
      nodeStream.on("error", () => {
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
      });
      nodeStream.pipe(res);
    } catch (e) {
      console.error("http handler error", e);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      }
      res.end(JSON.stringify({ ok: false, error: "服务端内部错误" }));
    }
  });
  return server;
}
