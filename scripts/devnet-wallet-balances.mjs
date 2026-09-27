// Devnet balance of every local test wallet (public keys + balances only).
// Never prints key material.
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "node:fs";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const c = new Connection(RPC, "confirmed");

const files = ["operator-devnet.key.json"];
for (const f of fs.readdirSync("test-ledger")) {
  if (f.endsWith(".json")) files.push(`test-ledger/${f}`);
}

for (const f of files) {
  try {
    const raw = JSON.parse(fs.readFileSync(f, "utf8"));
    const candidates = [];
    const walk = (o, path = "") => {
      if (!o || typeof o !== "object") return;
      for (const [k, v] of Object.entries(o)) {
        if (Array.isArray(v) && v.length === 64 && v.every((n) => typeof n === "number")) {
          candidates.push([path + k, new Keypair(Uint8Array.from(v)).publicKey]);
        } else if (typeof v === "object") walk(v, `${path}${k}.`);
      }
    };
    walk(raw);
    for (const [label, pk] of candidates) {
      const lamports = await c.getBalance(pk).catch(() => null);
      console.log(
        `${f} ${label}: ${pk.toBase58()} ${lamports === null ? "?" : (lamports / 1e9).toFixed(4) + " SOL"}`,
      );
    }
    if (candidates.length === 0) console.log(`${f}: no 64-byte keypairs found`);
  } catch (e) {
    console.log(`${f}: unreadable (${e.message})`);
  }
}
void PublicKey;
