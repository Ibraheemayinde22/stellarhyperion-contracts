#!/usr/bin/env bash
# Native local contract execution: exact early refusal, mature activation, link and repeat.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
[ "${STELLAR_NETWORK:-local}" = "local" ] || die "activation rehearsal requires STELLAR_NETWORK=local"
[ "$#" -eq 0 ] || die "activation rehearsal takes no arguments"
REPORT=$(mktemp)
trap 'rm -f "$REPORT"' EXIT
note "real native router and adapters; controlled provider fixture"
(
  cd "$SOROBAN_DIR"
  cargo test --locked -p hyperion-router \
    test::operations::activation_rehearsal_executes_real_queued_actions_links_and_verifies_repeatability -- --exact --nocapture
) | tee "$REPORT"
node - "$REPORT" <<'NODE'
const lines = require('fs').readFileSync(process.argv[2], 'utf8').split(/\r?\n/).filter(line => line.startsWith('ACTIVATION_REPORT '));
if (lines.length !== 1) throw new Error('activation fixture produced no unique execution report');
const report = JSON.parse(lines[0].slice('ACTIVATION_REPORT '.length));
if (report.fixture !== 'native-real-router-and-adapters' || report.earlyTimelockRejected !== true || report.maturedExecuted !== 7 || report.linksVerified !== true || report.repeatedPhaseTwoNoOp !== true) throw new Error('incomplete actual activation evidence');
NODE
printf '\nNative activation and repeated phase two verified.\n'
