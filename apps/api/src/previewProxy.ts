/**
 * Development-only reverse proxy.
 *
 * The public preview port is a single origin: the API answers `/api/*` and
 * everything else is forwarded to the Next.js dev server. This keeps the app
 * reachable no matter which port the managed preview settles on, instead of
 * exposing two ports where the public one might land on either process.
 *
 * Enabled only when PREVIEW_UI_URL is set (scripts/start-preview.sh). It is
 * never active in production, where Next.js is the server and no proxy runs.
 */
import type { FastifyInstance } from "fastify";
import net from "node:net";

/** Headers that must not be forwarded verbatim in either direction. */const HOP_BY_HOP = new Set([ 
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "content-length",
  "accept-encoding",
  "content-encoding",
]);

/** Shown while the Next.js dev server is still starting or compiling. */
const UI_WARMING_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>SolRoll — starting…</title>
<meta http-equiv="refresh" content="2"/>
<style>body{background:#0b0f0a;color:#e8e3d3;font:16px/1.6 system-ui,sans-serif;
display:grid;place-items:center;height:100vh;margin:0}div{text-align:center;max-width:32rem}
code{color:#f5c451}</style></head>
<body><div><h1>SolRoll is starting</h1>
<p>The API is up; the web UI is still compiling. This page reloads automatically.</p>
<p>API health: <code>/api/health</code></p></div></body></html>`;

function filterRequestHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (v === undefined || v === null) continue;
    out[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

function filterResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (HOP_BY_HOP.has(key.toLowerCase())) return;
    out[key] = value;
  });
  return out;
}

export function registerPreviewProxy(app: FastifyInstance, uiUrl: string): void {
  const base = uiUrl.replace(/\/+$/, "");

  // Dev-only WebSocket upgrade pass-through. The HTTP fetch proxy above cannot
  // carry an Upgrade handshake, so Next.js HMR (/_next/webpack-hmr) would 404
  // on every page load through the public origin. Raw-pipe those sockets to
  // the UI process instead. Never active in production (no proxy registered).
  app.server.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";
    if (!url.startsWith("/_next/webpack-hmr")) return; // leave anything else to Node
    const target = new URL(base);
    const upstream = net.connect(Number(target.port), target.hostname, () => {
      // Rewrite the request line + Host; forward the WS handshake headers as-is.
      const forwarded = Object.entries(req.headers)
        .filter(([k]) => !"host upgrade connection".split(" ").includes(k.toLowerCase()))
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : v}`);
      const head_ = [
        `${req.method ?? "GET"} ${url} HTTP/1.1`,
        `Host: ${target.host}`,
        ...forwarded,
        "Connection: Upgrade",
        `Upgrade: ${req.headers.upgrade ?? "websocket"}`,
        "\r\n",
      ].join("\r\n");
      upstream.write(head_);
      if (head && head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });

  // OPTIONS is deliberately excluded: @fastify/cors already owns the wildcard
  // OPTIONS route, and registering it twice makes the router throw.
  app.route({
    method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
    url: "/*",
    bodyLimit: 32 * 1024 * 1024,
    handler: async (req, reply) => {
      const target = `${base}${req.raw.url ?? "/"}`;
      const method = (req.raw.method ?? "GET").toUpperCase();
      const hasBody = method !== "GET" && method !== "HEAD";

      const init: RequestInit & { headers: Record<string, string> } = {
        method,
        headers: filterRequestHeaders(req.headers as Record<string, unknown>),
        redirect: "manual",
      };
      if (hasBody) {
        const raw = (req.raw as unknown as { body?: unknown }).body;
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(JSON.stringify(raw ?? {}));
        init.body = buf;
      }

      try {
        const upstream = await fetch(target, init);
        const body = Buffer.from(await upstream.arrayBuffer());
        reply.code(upstream.status);
        for (const [k, v] of Object.entries(filterResponseHeaders(upstream.headers))) {
          reply.header(k, v);
        }
        return reply.send(body);
      } catch (e) {
        // The Next.js dev server may still be compiling (or restarting). Keep
        // the public origin answering so the managed preview never sees a dead
        // port; the page reloads itself once the UI is up.
        app.log.warn({ err: e, target }, "preview proxy: UI not ready yet");
        if (method === "GET" || method === "HEAD") {
          reply.header("content-type", "text/html; charset=utf-8");
          reply.header("cache-control", "no-store");
          return reply.code(200).send(UI_WARMING_HTML);
        }
        return reply.code(503).send({
          error: "ui_unreachable",
          detail: e instanceof Error ? e.message : "unknown",
        });
      }
    },
  });
}
