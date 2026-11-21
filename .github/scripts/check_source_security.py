"""Fail the gate on high/critical CodeQL findings; retain all findings in SARIF."""

import json
import hashlib
import math
from pathlib import Path
import sys


# Reviewed CodeQL name-heuristic false positive: a Stellar network's public
# passphrase is part of the stable operation identity, never an authentication
# password. Preserve journal IDs and the original SARIF. This exception requires
# the complete reviewed source plus every exact public-origin-to-digest flow;
# another password origin, sink, file or source revision still blocks the gate.
JOURNAL_SOURCE = "script/stellar/operation-journal.mjs"
JOURNAL_SHA256 = "8f1c7c9b2be4201c3fe5870f24cec52f7f1e242b82bc696adcc839c6f84ea501"
PUBLIC_NETWORK_ORIGINS = {(281, 31, 48), (356, 33, 48), (369, 59, 76)}
PUBLIC_IDENTITY_SINK = (22, 53, 58)


def journal_source_digest():
    source = Path(__file__).resolve().parents[2] / JOURNAL_SOURCE
    return hashlib.sha256(source.read_bytes()).hexdigest()


def reviewed_public_network_identity(result):
    if result.get("ruleId") != "js/insufficient-password-hash":
        return False

    def position(physical):
        artifact = physical["artifactLocation"]
        if artifact["uri"] != JOURNAL_SOURCE or artifact["uriBaseId"] != "%SRCROOT%":
            raise ValueError("unreviewed source location")
        region = physical["region"]
        line = region["startLine"]
        if region.get("endLine", line) != line:
            raise ValueError("unreviewed multiline location")
        return line, region["startColumn"], region["endColumn"]

    try:
        locations = result["locations"]
        if len(locations) != 1 or position(locations[0]["physicalLocation"]) != PUBLIC_IDENTITY_SINK:
            return False
        origins = {position(loc["physicalLocation"]) for loc in result["relatedLocations"]}
        if origins != PUBLIC_NETWORK_ORIGINS:
            return False
        paths = []
        for flow in result["codeFlows"]:
            for thread in flow["threadFlows"]:
                points = [position(point["location"]["physicalLocation"]) for point in thread["locations"]]
                if len(points) < 2 or points[-1] != PUBLIC_IDENTITY_SINK:
                    return False
                paths.append(points[0])
        if sorted(paths) != [(281, 31, 48), (281, 31, 48), (356, 33, 48), (369, 59, 76)]:
            return False
        return journal_source_digest() == JOURNAL_SHA256
    except (KeyError, TypeError, ValueError, OSError):
        return False


def findings(report):
    if not isinstance(report, dict) or report.get("version") != "2.1.0":
        raise ValueError("Invalid source security SARIF report")
    runs = report.get("runs")
    if not isinstance(runs, list) or not runs:
        raise ValueError("Source security report has no analysis run")
    blocking = []
    for run in runs:
        if any(item.get("executionSuccessful") is False for item in run.get("invocations", [])):
            raise ValueError("Source analysis did not complete successfully")
        rules = run["tool"]["driver"].get("rules", [])
        extensions = run["tool"].get("extensions", [])
        by_id = {rule["id"]: rule for rule in rules}
        for extension in extensions:
            by_id.update({rule["id"]: rule for rule in extension.get("rules", [])})
        results = run.get("results")
        if not isinstance(results, list):
            raise ValueError("Source security analysis has no result list")
        for result in results:
            rule_id = result.get("ruleId") or result.get("rule", {}).get("id")
            if rule_id not in by_id:
                raise ValueError("Source finding references an unknown rule")
            rule = by_id[rule_id]
            severity = rule.get("properties", {}).get("security-severity")
            if severity is None:
                if result.get("level", rule.get("defaultConfiguration", {}).get("level")) == "error":
                    blocking.append((rule_id, "error"))
                continue
            score = float(severity)
            if not math.isfinite(score) or not 0 <= score <= 10:
                raise ValueError("Invalid source security severity")
            if score >= 7:
                if reviewed_public_network_identity(result):
                    print("Reviewed public Stellar network-identity digest finding retained as nonblocking; exact source and every flow verified.")
                else:
                    blocking.append((rule_id, str(score)))
    return blocking


def main(directory):
    files = sorted(Path(directory).glob("*.sarif"))
    if not files:
        raise ValueError("CodeQL did not produce a SARIF report")
    blocking = []
    for path in files:
        blocking.extend(findings(json.loads(path.read_text())))
    for rule, severity in blocking:
        print(f"::error::Source security finding {rule} (severity {severity}); review the SARIF artifact.")
    print(f"Checked {len(files)} source analysis report(s); {len(blocking)} blocking finding(s).")
    return int(bool(blocking))


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1]))
    except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
        print(f"::error::{error}", file=sys.stderr)
        sys.exit(1)
