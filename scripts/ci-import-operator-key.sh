#!/bin/sh
# CI-only helper: import the operator keypair from the OPERATOR_KEYPAIR secret
# (JSON array, base64-encoded for safe passing) and show the wallet address.
# The secret is never echoed. Runs only inside GitHub Actions.
set -e
if [ -z "$OPERATOR_KEYPAIR_B64" ]; then
  echo "OPERATOR_KEYPAIR_B64 is not set" >&2
  exit 1
fi
mkdir -p ~/.config/solana
printf '%s' "$OPERATOR_KEYPAIR_B64" | base64 -d > ~/.config/solana/id.json
chmod 600 ~/.config/solana/id.json
echo "wallet address: $(solana-keygen pubkey ~/.config/solana/id.json)"
