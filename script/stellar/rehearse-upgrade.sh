#!/usr/bin/env bash
# Real released-WASM -> candidate-WASM timelock upgrade, with executable rollback fixture.
# Usage: script/stellar/rehearse-upgrade.sh --old-wasm /path/released-router.wasm
source "$(dirname "$0")/lib.sh"
OLD_WASM=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --old-wasm) [ "$#" -ge 2 ] || die "missing --old-wasm value"; OLD_WASM="$2"; shift 2 ;;
    *) die "unknown option: $1" ;;
  esac
done
[ -f "$OLD_WASM" ] || die "supply the released router artifact with --old-wasm"
OLD_WASM="$(realpath "$OLD_WASM")"
# Always build the candidate from current source and apply the unchanged deployment size gate.
env -u CARGO_TARGET_DIR "$CONTRACTS_ROOT/script/stellar/build.sh"
note "running real executable upgrade and missing-hash rollback fixtures"
(
  # Select the workspace's declared toolchain, even when invoked from the repository root.
  cd "$SOROBAN_DIR"
  HYPERION_UPGRADE_OLD_WASM="$OLD_WASM" \
  HYPERION_UPGRADE_NEW_WASM="$WASM_DIR/hyperion_router.wasm" \
  cargo test --locked -p hyperion-router \
    storage_maintenance::actual_wasm_upgrade_preserves_state_and_failure_retains_executable -- --ignored --nocapture
)
note "read-only storage cost fixture with real XDR codec"
node "$CONTRACTS_ROOT/script/stellar/storage-cost.mjs" \
  --record "$CONTRACTS_ROOT/script/stellar/fixtures/storage-cost-rpc-v2.json"
printf '\nUpgrade rehearsal and exact recorded projection passed.\n'
