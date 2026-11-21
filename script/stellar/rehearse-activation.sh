#!/usr/bin/env bash
# Local-only activation rehearsal. It never signs a testnet or mainnet transaction.
set -euo pipefail
source "$(dirname "$0")/lib.sh"

[ "${STELLAR_NETWORK:-local}" = "local" ] || die "activation rehearsal requires STELLAR_NETWORK=local"
IDENTITY="${STELLAR_IDENTITY:-hyperion-rehearsal}"
RECORD="${HYPERION_RECORD:-$RECORD_DIR/stellar-local-phase1.json}"

note "local phase one"
STELLAR_NETWORK=local STELLAR_IDENTITY="$IDENTITY" "$CONTRACTS_ROOT/script/stellar/deploy.sh"

note "early execution must be rejected by the timelock"
if STELLAR_NETWORK=local STELLAR_IDENTITY="$IDENTITY" HYPERION_RECORD="$RECORD" \
  "$CONTRACTS_ROOT/script/stellar/execute.sh"; then
  die "local execute succeeded before the timelock matured"
else
  say "early execution rejected as expected"
fi

cat <<EOF

Local phase one is complete and early execution was rejected.
Run phase two again after the local timelock matures:
  STELLAR_NETWORK=local STELLAR_IDENTITY=$IDENTITY HYPERION_RECORD=$RECORD \\
    $CONTRACTS_ROOT/script/stellar/execute.sh

This rehearsal is local fixture evidence only; it is not testnet acceptance evidence.
EOF
