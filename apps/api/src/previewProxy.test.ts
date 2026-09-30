/**
 * Preview proxy (dev only).
 *
 * The fix under test: when the Next.js dev server is not answering yet, a GET
 * must still return a 200 page so the managed preview never sees a dead port.
 * Before this, the proxy returned 502 and a slow compile looked like a failed
 * dev server.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import Fastify from "fastify";
import { registerPreviewProxy } from "./previewProxy.js";

const UI = "http://127.0.0.1:3001";

async function appWithUpstream(handler: (url: string) => Response | Promise<Response>) {
  const upstream = vi.fn(async (input: RequestInfo | URL) => handler(String(input)));
  vi.stubGlobal("fetch", upstream);
  const app = Fastify();
  registerPreviewProxy(app, UI);
  await app.ready();
  return { app, upstream };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("preview proxy", () => {
  it("forwards a UI request and mirrors the upstream status and body", async () => {
    const { app, upstream } = await appWithUpstream(
      () => new Response("<html>roulette</html>", { status: 200, headers: { "content-type": "text/html" } })
    );
    const res = await app.inject({ method: "GET", url: "/pool/0" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("roulette");
    expect(res.headers["content-type"]).toContain("text/html");
    expect(upstream).toHaveBeenCalledWith(`${UI}/pool/0`, expect.objectContaining({ method: "GET" }));
  });

  it("answers 200 with a self-refreshing page while the UI is still compiling", async () => {
    const { app } = await appWithUpstream(() => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:3001");
    });
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    // The page tells the browser to come back on its own.
    expect(res.body).toContain("http-equiv=\"refresh\"");
    expect(res.body).toContain("SolRoll is starting");
  });

  it("returns 503 (not a page) for writes while the UI is down", async () => {
    const { app } = await appWithUpstream(() => {
      throw new Error("connect ECONNREFUSED");
    });
    const res = await app.inject({ method: "POST", url: "/api-ish", payload: { a: 1 } });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe("ui_unreachable");
  });

  it("never forwards hop-by-hop headers upstream", async () => {
    const { app, upstream } = await appWithUpstream(
      () => new Response("ok", { status: 200 })
    );
    await app.inject({ method: "GET", url: "/", headers: { connection: "keep-alive" } });
    const init = upstream.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("connection");
  });
});
