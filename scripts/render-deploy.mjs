/**
 * Trigger a Render deploy for the API service and report its status.
 *
 *   node scripts/render-deploy.mjs start          # POST a new deploy, print id
 *   node scripts/render-deploy.mjs status [id]    # print state of that deploy
 *
 * Split into two commands because a Render deploy takes minutes, longer than a
 * single terminal invocation may run. The API key is read from the environment
 * and never printed.
 */
const BASE = process.env.RENDER_API_BASE?.trim() || "https://api.render.com/v1";
const SERVICE_ID = process.env.RENDER_SERVICE_ID?.trim() || "srv-darfjqt9fdbs739de5eg";
const apiKey = (process.env.RENDER_API_KEY || "").trim();
if (!apiKey) {
  console.error("RENDER_API_KEY is not set — add it in Settings → Environment.");
  process.exit(1);
}

const render = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 300) }; }
  return { ok: res.ok, status: res.status, json };
};

const [cmd, id] = process.argv.slice(2);

if (cmd === "start") {
  const dep = await render(`/services/${SERVICE_ID}/deploys`, { method: "POST", body: "{}" });
  if (!dep.ok) {
    console.error(`deploy trigger failed (HTTP ${dep.status}): ${JSON.stringify(dep.json).slice(0, 300)}`);
    process.exit(1);
  }
  const created = dep.json?.deploy ?? dep.json;
  console.log(created?.id ?? "no id returned");
  process.exit(created?.id ? 0 : 1);
}

if (cmd === "status") {
  // Render wraps single resources in { "<kind>": { ... } }.
  const unwrap = (j) => j?.deploy ?? j;
  if (!id) {
    const list = await render(`/services/${SERVICE_ID}/deploys?limit=1`);
    const entries = Array.isArray(list.json) ? list.json : [list.json];
    const first = unwrap(entries[0]);
    console.log(`${first?.id} ${first?.status}`);
    process.exit(0);
  }
  const st = await render(`/services/${SERVICE_ID}/deploys/${id}`);
  const d = unwrap(st.json);
  console.log(`${d?.id} ${d?.status} ${d?.finishedAt ?? ""}`.trim());
  process.exit(0);
}

if (cmd === "raw") {
  // Read-only diagnostic: print the JSON for any GET path, e.g.
  //   node scripts/render-deploy.mjs raw /services/<id>/events?limit=30
  if (!id) {
    console.error("usage: node scripts/render-deploy.mjs raw <path>");
    process.exit(1);
  }
  const res = await render(id);
  console.log(JSON.stringify(res.json, null, 2));
  process.exit(res.ok ? 0 : 1);
}

console.error("usage: node scripts/render-deploy.mjs start|status [deployId]|raw <path>");
process.exit(1);
