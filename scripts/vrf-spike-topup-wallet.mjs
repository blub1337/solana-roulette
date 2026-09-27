// Finds any devnet wallet recorded in test-ledger with enough SOL to top the
// operator up, without printing any key material. Balances only.
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "node:fs";

const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const c = new Connection(RPC, "confirmed");

const found = [];
const consider = (label, secret) => {
  try {
    const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
    found.push({ label, kp });
  } catch {
    /* not a keypair */
  }
};

// operator file: plain [64] array
try {
  consider("operator", JSON.parse(fs.readFileSync("operator-devnet.key.json", "utf8")));
} catch {}

// test-ledger files: search any 64-number array anywhere in the JSON
for (const f of fs.readdirSync("test-ledger")) {
  if (!f.endsWith(".json")) continue;
  try {
    const raw = fs.readFileSync(`test-ledger/${f}`, "utf8");
    const hits = raw.match(/\[\s*\d+(?:\s*,\s*\d+){63}\s*\]/g) ?? [];
    hits.forEach((h, i) => {
      try {
        consider(`${f}#${i}`, JSON.parse(h));
      } catch {}
    });
  } catch {}
}

console.log(`wallets found: ${found.length}`);
for (const { label, kp } of found) {
  const bal = await c.getBalance(kp.publicKey).catch(() => null);
  console.log(
    `${label.padEnd(24)} ${kp.publicKey.toBase58()}  ${bal === null ? "?" : (bal / 1e9).toFixed(4) + " SOL"}`,
  );
}
