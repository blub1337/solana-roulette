/**
 * Create the Render web service for the Next.js frontend (idempotent).
 *
 * The production API already lives on Render (`solana-roulette-api`). This
 * brings up its frontend peer, `solana-roulette-web`, from the SAME GitHub repo
 * and branch, with the same monorepo conventions as the API service:
 *
 *   build:  npm ci --include=dev && npm run build:server && npm run build -w apps/web
 *   start:  npm run start -w apps/web        (Next `next start`, binds Render's $PORT)
 *
 * `build:server` compiles the shared workspace packages (their `main` points at
 * `dist/`, which is gitignored) before Next builds — the same prerequisite the
 * API service has.
 *
 * The frontend needs NO production secrets: `apps/web/lib/apiBase.ts` and
 * `apps/web/next.config.mjs` already default to the deployed Render API in
 * production. `NEXT_PUBLIC_API_URL` is still set explicitly here so the target
 * is visible in the dashboard and cannot drift with a code change.
 *
 * Idempotent: if a service with the target name already exists it is reported
 * and nothing is created. Run on its own (Render API calls are not chained here
 * because this is a plain node script, not a Freebuff tool).
 *
 *   node scripts/render-create-web.mjs          # create if missing
 *   node scripts/render-create-web.mjs --force  # error out instead of reusing
 */
const BASE = process.env.RENDER_API_BASE?.trim() || "https://api.render.com/v1";
const OWNER_ID = process.env.RENDER_OWNER_ID?.trim() || "tea-d9fack77f7vs73dufukg";
const NAME = process.env.RENDER_WEB_NAME?.trim() || "solana-roulette-web";
const REPO = process.env.RENDER_REPO?.trim() || "https://github.com/blub1337/solana-roulette";
const BRANCH = process.env.RENDER_BRANCH?.trim() || "main";
const REGION = process.env.RENDER_REGION?.trim() || "frankfurt";
const PLAN = process.env.RENDER_PLAN?.trim() || "free";
const API_URL =
  process.env.RENDER_API_PUBLIC_URL?.trim() || "https://solana-roulette-api-gd7k.onrender.com";
const FORCE = process.argv.includes("--force");

const apiKey = (process.env.RENDER_API_KEY || "").trim();
if (!apiKey) {
  console.error("RENDER_API_KEY is not set — add it in Settings → Environment.");
  process.exit(1);
}

const H = {
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
  Accept: "application/json",
};

async function render(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: H,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 400)}`);
  }
  return json;
}

async function listServices() {
  // Render paginates; walk cursors until exhausted.
  const out = [];
  let cursor = null;
  for (let i = 0; i < 20; i++) {
    const path = `/services?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const page = await render("GET", path);
    const entries = Array.isArray(page) ? page : [page];
    for (const e of entries) {
      const svc = e?.service ?? e;
      if (svc?.id) out.push(svc);
    }
    cursor = entries[entries.length - 1]?.cursor ?? null;
    if (!cursor) break;
  }
  return out;
}

const existing = (await listServices()).find((s) => s.name === NAME);
if (existing) {
  if (FORCE) {
    console.error(`service "${NAME}" already exists: ${existing.id}`);
    process.exit(1);
  }
  console.log(`service "${NAME}" already exists: ${existing.id} ${existing.serviceDetails?.url ?? ""}`);
  process.exit(0);
}

const payload = {
  type: "web_service",
  name: NAME,
  ownerId: OWNER_ID,
  repo: REPO,
  branch: BRANCH,
  autoDeploy: "yes",
  rootDir: "",
  envVars: [{ key: "NEXT_PUBLIC_API_URL", value: API_URL }],
  serviceDetails: {
    env: "node",
    plan: PLAN,
    region: REGION,
    healthCheckPath: "/",
    envSpecificDetails: {
      // The shared packages must be built before Next (their `main` is dist/).
      buildCommand:
        "npm ci --include=dev && npm run build:server && npm run build -w apps/web",
      startCommand: "npm run start -w apps/web",
    },
  },
};

const created = await render("POST", "/services", payload);
const svc = created?.service ?? created;
console.log(JSON.stringify({ id: svc?.id, name: svc?.name, url: svc?.serviceDetails?.url, deployId: created?.deployId }, null, 2));
process.exit(svc?.id ? 0 : 1);
