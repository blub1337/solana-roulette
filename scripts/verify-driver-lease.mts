/**
 * LIVE verification of the settlement-driver single-writer lease.
 *
 *   npx tsx scripts/verify-driver-lease.mts
 *
 * Two independent checks against the REAL audit database in DATABASE_URL:
 *
 *   A. Lease mechanics — two leases on one private scope must not both hold it,
 *      and leadership must hand over on release.
 *   B. Live arbitration — while the running API (the preview) is driving, a
 *      fresh claim for the SAME scope (network + program id) must be denied.
 *      That is exactly what a second deployment gets: standby, never a driver.
 *
 * It never prints secrets; DATABASE_URL is only used to open the connection.
 * A missing DATABASE_URL is reported as SKIP (the lease is then a no-op).
 */
import {
  createDriverLease,
  createPostgresDriverLease,
  driverLeaseScope,
} from "../apps/api/src/settlementLease.js";

const PROGRAM_ID = process.env.ROULETTE_PROGRAM_ID || "F5kuHXicGCRnnh9SbRvxshynXPyzgzbKK1UVgTg5UZos";
const NETWORK = process.env.SOLANA_NETWORK || "devnet";
const url = process.env.DATABASE_URL;

let failures = 0;
function check(name: string, ok: boolean, detail = ""): boolean {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
  return ok;
}

async function main(): Promise<void> {
  console.log(`program ${PROGRAM_ID}  network ${NETWORK}`);
  if (!url || !/^postgres(ql)?:\/\//.test(url)) {
    console.log("SKIP: no direct postgres DATABASE_URL — the lease is a no-op in this process.");
    return;
  }

  // ---- A. real lease mechanics on a private scope (not the driver's row) ----
  console.log("\nA. lease-table mechanics");
  const privScope = `${driverLeaseScope(NETWORK, PROGRAM_ID)}:verify:${Date.now()}`;
  const a = createPostgresDriverLease(url, privScope);
  const b = createPostgresDriverLease(url, privScope);
  check("first contender becomes leader", await a.acquire());
  check("second contender is a standby (same scope)", !(await b.acquire()));
  await a.release();
  check("leadership hands over on release", await b.acquire());
  await b.release();

  // ---- B. the running API holds the driver scope: a second instance is denied
  console.log("\nB. live arbitration against the running API");
  const lease = createDriverLease({
    databaseUrl: url,
    programId: PROGRAM_ID,
    network: NETWORK,
    mode: "chain",
  });
  check("driver lease is enforced (a shared lease row, not the no-op)", lease.kind === "postgres");

  let denied = false;
  for (let i = 0; i < 10; i++) {
    if (!(await lease.acquire())) {
      denied = true;
      break;
    }
    // We got the claim: no incumbent is holding it right now. Hand it back and
    // retry briefly, so a just-restarted API has time to take leadership.
    await lease.release();
    await new Promise((r) => setTimeout(r, 1500));
  }
  check(
    "a second instance is DENIED the driver lease (an instance is already driving)",
    denied,
    denied ? "" : "no incumbent held the lease — is the API running with the same DATABASE_URL?"
  );

  console.log(`\nRESULT: ${failures === 0 ? "PASS" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("verify-driver-lease crashed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
