"""Exercise severity gating and failed/malformed source analyses."""

import copy
import tempfile
import unittest
from unittest.mock import patch

from check_source_security import findings, main, JOURNAL_SOURCE, PUBLIC_NETWORK_ORIGINS, PUBLIC_IDENTITY_SINK


def report(severity="8.1"):
    return {"version": "2.1.0", "runs": [{
        "tool": {"driver": {"rules": [{"id": "js/test-security", "properties": {"security-severity": severity}}]}},
        "results": [{"ruleId": "js/test-security"}],
    }]}


def network_digest_report():
    data = report()
    rule = data["runs"][0]["tool"]["driver"]["rules"][0]
    rule["id"] = "js/insufficient-password-hash"

    def physical(point):
        line, start, end = point
        return {"artifactLocation": {"uri": JOURNAL_SOURCE, "uriBaseId": "%SRCROOT%"},
                "region": {"startLine": line, "startColumn": start, "endColumn": end}}

    result = {"ruleId": rule["id"],
              "locations": [{"physicalLocation": physical(PUBLIC_IDENTITY_SINK)}],
              "relatedLocations": [{"physicalLocation": physical(point)} for point in PUBLIC_NETWORK_ORIGINS],
              "codeFlows": [{"threadFlows": [{"locations": [
                  {"location": {"physicalLocation": physical(origin)}},
                  {"location": {"physicalLocation": physical(PUBLIC_IDENTITY_SINK)}},
              ]} for origin in [(281, 31, 48), (281, 31, 48), (356, 33, 48), (369, 59, 76)]]}]}
    data["runs"][0]["results"] = [result]
    return data


class SourceSecurityTests(unittest.TestCase):
    def test_reviewed_network_identity_keeps_original_finding_and_passes(self):
        data = network_digest_report()
        before = copy.deepcopy(data)
        self.assertEqual(findings(data), [])
        self.assertEqual(data, before)

    def test_source_changes_missing_and_extra_flows_still_block(self):
        data = network_digest_report()
        with patch("check_source_security.journal_source_digest", return_value="0" * 64):
            self.assertTrue(findings(data))
        for missing in ("locations", "relatedLocations", "codeFlows"):
            changed = copy.deepcopy(data)
            del changed["runs"][0]["results"][0][missing]
            self.assertTrue(findings(changed))
        changed = copy.deepcopy(data)
        paths = changed["runs"][0]["results"][0]["codeFlows"][0]["threadFlows"]
        paths.append(copy.deepcopy(paths[0]))
        self.assertTrue(findings(changed))

    def test_added_real_password_flow_is_not_hidden_by_public_related_locations(self):
        data = network_digest_report()
        paths = data["runs"][0]["results"][0]["codeFlows"][0]["threadFlows"]
        extra = copy.deepcopy(paths[0])
        extra["locations"][0]["location"]["physicalLocation"]["artifactLocation"]["uri"] = "auth/passwords.mjs"
        paths.append(extra)
        self.assertTrue(findings(data))

    def test_other_origins_sinks_and_foreign_intermediate_files_still_block(self):
        for section in ("relatedLocations", "locations"):
            data = network_digest_report()
            data["runs"][0]["results"][0][section][0]["physicalLocation"]["region"]["startLine"] += 1
            self.assertTrue(findings(data))
        data = network_digest_report()
        paths = data["runs"][0]["results"][0]["codeFlows"][0]["threadFlows"]
        middle = copy.deepcopy(paths[0]["locations"][0])
        middle["location"]["physicalLocation"]["artifactLocation"]["uri"] = "auth/passwords.mjs"
        paths[0]["locations"].insert(1, middle)
        self.assertTrue(findings(data))

    def test_genuine_password_hash_elsewhere_and_other_rules_still_block(self):
        data = network_digest_report()
        data["runs"][0]["results"].append({"ruleId": "js/insufficient-password-hash"})
        self.assertEqual(len(findings(data)), 1)
        data = network_digest_report()
        data["runs"][0]["results"][0]["ruleId"] = "js/test-security"
        data["runs"][0]["tool"]["driver"]["rules"][0]["id"] = "js/test-security"
        self.assertTrue(findings(data))

    def test_high_and_critical_findings_block(self):
        for severity in ["7.0", "8.1", "9.8"]:
            self.assertEqual(findings(report(severity)), [("js/test-security", str(float(severity)))])

    def test_lower_severity_findings_are_retained_without_blocking(self):
        self.assertEqual(findings(report("6.9")), [])

    def test_clean_analysis_passes(self):
        data = report()
        data["runs"][0]["results"] = []
        self.assertEqual(findings(data), [])

    def test_extension_rule_metadata_is_used(self):
        data = report()
        run = data["runs"][0]
        rules = run["tool"]["driver"].pop("rules")
        run["tool"]["extensions"] = [{"rules": rules}]
        self.assertTrue(findings(data))

    def test_failed_analysis_is_not_clean(self):
        data = report()
        data["runs"][0]["invocations"] = [{"executionSuccessful": False}]
        with self.assertRaises(ValueError):
            findings(data)

    def test_missing_or_invalid_metadata_fails_closed(self):
        for severity in ["nan", "inf", "11", "-1", "invalid"]:
            with self.subTest(severity=severity), self.assertRaises(ValueError):
                findings(report(severity))
        data = report()
        data["runs"][0]["tool"]["driver"]["rules"] = []
        with self.assertRaises(ValueError):
            findings(data)
        for data in [{}, {"version": "2.1.0", "runs": []}]:
            with self.assertRaises(ValueError):
                findings(data)

    def test_missing_analysis_artifact_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
            main(directory)


if __name__ == "__main__":
    unittest.main()
