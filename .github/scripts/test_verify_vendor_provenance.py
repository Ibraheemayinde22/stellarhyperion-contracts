"""Mutation regressions for the native host trust boundary; never fetch the network."""

import copy
from contextlib import contextmanager, redirect_stderr, redirect_stdout
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import verify_vendor_provenance as provenance


class VendorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="host-provenance-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "repository"
        shutil.copytree(provenance.ROOT / "soroban/vendor", self.root / "soroban/vendor")
        shutil.copy2(provenance.ROOT / "soroban/Cargo.toml", self.root / "soroban/Cargo.toml")
        # Only dependency manifests are needed; no compiled output or native test execution.
        for source in (provenance.ROOT / "soroban/crates").glob("*/Cargo.toml"):
            destination = self.root / source.relative_to(provenance.ROOT)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
        self.vendor = self.root / "soroban/vendor"
        self.host = self.vendor / "soroban-env-host"
        self.manifest = json.loads((self.vendor / "provenance.json").read_text())

    def verify(self, manifest=None, archive_path=None):
        return provenance.verify(self.manifest if manifest is None else manifest,
                                 root=self.root, offline=True, archive_path=archive_path)

    @contextmanager
    def modified(self, path, content):
        original = path.read_bytes()
        path.write_bytes(content)
        try:
            yield
        finally:
            path.write_bytes(original)

    def cli(self, arguments=()):
        with patch.object(provenance, "ROOT", self.root), patch("sys.argv", ["verifier", *arguments]), \
                redirect_stderr(io.StringIO()) as errors, redirect_stdout(io.StringIO()) as output:
            status = provenance.main()
        return status, errors.getvalue(), output.getvalue()

    def test_offline_checks_bytes_without_network(self):
        with patch("urllib.request.urlopen", side_effect=AssertionError("network access")):
            self.assertEqual(self.verify(), [])
            self.assertEqual(self.cli(["--offline"])[0], 0)

    def test_each_patched_source_is_checked_offline(self):
        for name in self.manifest["patch_paths"]:
            with self.subTest(path=name), self.modified(self.host / name, b"tampered patch output\n"):
                self.assertIn(f"vendored byte mismatch: {name}", self.verify())

    def test_source_only_and_added_files_have_no_exemption(self):
        for name in self.manifest["source_only_paths"] + self.manifest["added_paths"]:
            with self.subTest(path=name), self.modified(self.host / name, b"tampered overlay\n"):
                self.assertIn(f"reviewed overlay checksum mismatch: {name}", self.verify())

    def test_unpatched_source_mutation_is_rejected(self):
        with self.modified(self.host / "src/lib.rs", b"unreviewed source\n"):
            self.assertIn("vendored byte mismatch: src/lib.rs", self.verify())

    def test_missing_and_unexpected_paths_are_rejected(self):
        path = self.host / "src/lib.rs"
        path.rename(self.host / "src/unreviewed.rs")
        errors = self.verify()
        self.assertIn("missing upstream or reviewed path: src/lib.rs", errors)
        self.assertIn("unexpected vendored path: src/unreviewed.rs", errors)

    def test_omitted_wasm_cannot_be_reintroduced(self):
        for name in self.manifest["omitted_archive_paths"]:
            with self.subTest(path=name):
                path = self.host / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"unexpected wasm")
                self.assertIn(f"unexpected vendored path: {name}", self.verify())
                path.unlink()

    def test_self_consistent_tampered_manifest_does_not_change_trust_pin(self):
        changed = copy.deepcopy(self.manifest)
        content = b"malicious source and a matching contributed digest\n"
        changed["file_sha256"]["src/lib.rs"] = hashlib.sha256(content).hexdigest()
        changed["expected_tree_sha256"] = provenance.tree_digest(changed["file_sha256"])
        with self.modified(self.host / "src/lib.rs", content):
            errors = self.verify(changed)
            self.assertIn("reviewed source digest inventory mismatch", errors)
            self.assertIn("unexpected expected_tree_sha256 in provenance manifest", errors)

    def test_each_trusted_metadata_pin_is_enforced(self):
        for key in provenance.EXPECTED_METADATA:
            with self.subTest(key=key):
                changed = copy.deepcopy(self.manifest)
                changed[key] = None
                self.assertIn(f"unexpected {key} in provenance manifest", self.verify(changed))

    def test_malformed_manifest_and_digest_inventory_fail_cleanly(self):
        for value in [[], None, "manifest", 42]:
            with self.subTest(value=value):
                self.assertEqual(provenance.verify_metadata(value), ["provenance manifest must be an object"])
                with self.modified(self.vendor / "provenance.json", json.dumps(value).encode()):
                    self.assertEqual(self.cli(["--offline"])[0], 1)
        for inventory in [{}, [], {"../escape": "a" * 64}, {"src/lib.rs": "bad"}]:
            with self.subTest(inventory=inventory):
                changed = copy.deepcopy(self.manifest)
                changed["file_sha256"] = inventory
                self.assertIn("invalid expected source file digests", self.verify(changed))

    def test_patch_and_vcs_mutations_are_rejected(self):
        with self.modified(self.vendor / self.manifest["patch_file"], b"unreviewed patch"):
            self.assertIn("patch checksum mismatch", self.verify())
        with self.modified(self.host / ".cargo_vcs_info.json", b'{"git":{"sha1":"wrong"}}'):
            self.assertIn("vendored byte mismatch: .cargo_vcs_info.json", self.verify())

    def test_documented_revision_is_required(self):
        with self.modified(self.vendor / "README.md", b"unattributed native host"):
            self.assertIn("README does not reference the reviewed upstream revision", self.verify())

    def test_symlinked_source_file_and_directory_are_never_read(self):
        outside = Path(self.temporary.name) / "outside"
        outside.mkdir()
        sentinel = outside / "sentinel"
        sentinel.write_bytes(b"outside bytes")
        file = self.host / "src/lib.rs"
        file.unlink()
        file.symlink_to(sentinel)
        (self.host / "unreviewed").symlink_to(outside, target_is_directory=True)
        errors = self.verify()
        self.assertIn("unsupported vendored entry: src/lib.rs", errors)
        self.assertIn("unsupported vendored entry: unreviewed", errors)
        self.assertEqual(sentinel.read_bytes(), b"outside bytes")

    def test_symlinked_patch_manifest_and_parent_fail_cleanly(self):
        for relative in ["soroban/vendor/provenance.json", "soroban/vendor/soroban-env-host-rustcrypto.patch",
                         "soroban/vendor", "soroban/vendor/soroban-env-host"]:
            with self.subTest(path=relative):
                path = self.root / relative
                saved = path.with_name(path.name + ".saved")
                path.rename(saved)
                path.symlink_to(saved, target_is_directory=saved.is_dir())
                try:
                    self.assertEqual(self.cli(["--offline"])[0], 1)
                finally:
                    path.unlink()
                    saved.rename(path)

    def test_workspace_exclusion_patch_and_members_are_enforced(self):
        workspace = self.root / "soroban/Cargo.toml"
        original = workspace.read_text()
        cases = [original.replace('exclude = ["vendor/soroban-env-host"]', 'exclude = []'),
                 original.replace('path = "vendor/soroban-env-host"', 'path = "elsewhere"'),
                 original.replace('members = [', 'members = ["vendor/./soroban-env-host",'),
                 original.replace('members = [', 'members = ["vendor/*",')]
        for text in cases:
            with self.subTest(text=text), self.modified(workspace, text.encode()):
                self.assertTrue(self.verify())

    def test_direct_renamed_path_and_target_dependencies_are_blocked(self):
        contract = self.root / "soroban/crates/hyperion-core/Cargo.toml"
        cases = ['[dependencies]\nsoroban-env-host = "29.0.1"',
                 '[dependencies]\nalias = {package="soroban-env-host",version="29.0.1"}',
                 '[dependencies]\nalias = {path="../../vendor/soroban-env-host"}',
                 '[dependencies]\nalias = {path="../../vendor/./soroban-env-host"}',
                 '[dev-dependencies]\nsoroban-env-host = "29.0.1"',
                 '[build-dependencies]\nsoroban-env-host = "29.0.1"',
                 '[target.\'cfg(unix)\'.dependencies]\nalias = {package="soroban-env-host",version="29.0.1"}']
        for text in cases:
            with self.subTest(text=text), self.modified(contract, text.encode()):
                self.assertTrue(any("native-only host dependency leaked" in error for error in self.verify()))

    def test_workspace_inherited_host_dependency_is_blocked(self):
        workspace = self.root / "soroban/Cargo.toml"
        content = workspace.read_text().replace('[workspace.dependencies]',
                    '[workspace.dependencies]\nalias = {package="soroban-env-host",version="29.0.1"}')
        with self.modified(workspace, content.encode()):
            self.assertTrue(any("native-only host dependency leaked" in error for error in self.verify()))

    def test_symlinked_and_external_dependency_paths_fail_cleanly(self):
        (self.root / "soroban/crates/alias").symlink_to(self.host, target_is_directory=True)
        contract = self.root / "soroban/crates/hyperion-core/Cargo.toml"
        for target in ["../alias", "/outside-unverified-root"]:
            with self.subTest(target=target), self.modified(contract, f'[dependencies]\nalias = {{path="{target}"}}'.encode()):
                status, errors, _ = self.cli(["--offline"])
                self.assertEqual(status, 1)
                self.assertIn("provenance input cannot be verified: ValueError", errors)

    def test_symlinked_contract_manifest_is_rejected(self):
        path = self.root / "soroban/crates/hyperion-core/Cargo.toml"
        saved = path.with_suffix(".saved")
        path.rename(saved)
        path.symlink_to(saved)
        self.assertEqual(self.cli(["--offline"])[0], 1)

    def test_special_inputs_are_rejected_without_opening_them(self):
        for relative in ["soroban/vendor/provenance.json", "soroban/vendor/soroban-env-host-rustcrypto.patch",
                         "soroban/vendor/README.md", "soroban/crates/hyperion-core/Cargo.toml"]:
            with self.subTest(path=relative):
                path = self.root / relative
                saved = path.with_name(path.name + ".saved")
                path.rename(saved)
                os.mkfifo(path)
                try:
                    self.assertEqual(self.cli(["--offline"])[0], 1)
                finally:
                    path.unlink()
                    saved.rename(path)
        archive = Path(self.temporary.name) / "input.fifo"
        os.mkfifo(archive)
        self.assertEqual(self.verify(archive_path=archive), ["crates.io archive checksum mismatch"])

    def test_symlinked_contract_directory_is_rejected(self):
        path = self.root / "soroban/crates"
        saved = path.with_name("crates-saved")
        path.rename(saved)
        path.symlink_to(saved, target_is_directory=True)
        self.assertTrue(self.verify())

    def test_malformed_toml_sections_fail_without_tracebacks(self):
        contract = self.root / "soroban/crates/hyperion-core/Cargo.toml"
        cases = ['dependencies = []', 'workspace = []', 'target = []', '[target]\nfoo = 1',
                 '[dependencies]\nalias = 42', '[dependencies]\nalias = {path=42}',
                 '[dependencies]\nalias = {package=42}', '[workspace]\nmembers = 42']
        for text in cases:
            # Root-only workspace member validation needs the actual workspace manifest.
            path = self.root / "soroban/Cargo.toml" if text == cases[-1] else contract
            with self.subTest(text=text), self.modified(path, text.encode()):
                status, errors, _ = self.cli(["--offline"])
                self.assertEqual(status, 1)
                self.assertNotIn("Traceback", errors)

    def test_explicit_archive_checksum_and_symlink_are_enforced(self):
        archive = Path(self.temporary.name) / "bad.crate"
        archive.write_bytes(b"untrusted archive")
        self.assertEqual(self.verify(archive_path=archive), ["crates.io archive checksum mismatch"])
        link = archive.with_suffix(".link")
        link.symlink_to(archive)
        self.assertEqual(self.verify(archive_path=link), ["crates.io archive checksum mismatch"])

    def test_actual_pinned_archive_reconstructs_the_exact_source_tree(self):
        archive = os.environ.get("VENDOR_PROVENANCE_ARCHIVE")
        if not archive:
            self.skipTest("set VENDOR_PROVENANCE_ARCHIVE for no-network canonical reconstruction")
        with patch("urllib.request.urlopen", side_effect=AssertionError("network access")):
            self.assertEqual(self.verify(archive_path=Path(archive)), [])


class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="host-archive-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def archive(self, entries):
        path = self.root / "input.crate"
        with tarfile.open(path, "w:gz") as archive:
            for member in entries:
                archive.addfile(member, io.BytesIO(b"x" * member.size) if member.isfile() else None)
        return path

    def member(self, suffix="src/lib.rs", kind=tarfile.REGTYPE):
        entry = tarfile.TarInfo(provenance.ARCHIVE_DIRECTORY + "/" + suffix)
        entry.type = kind
        return entry

    def test_regular_archive_extracts_exact_bytes(self):
        member = self.member()
        member.size = 3
        directory = provenance.extract_archive(self.archive([member]), self.root / "extract")
        self.assertEqual((directory / "src/lib.rs").read_bytes(), b"xxx")

    def test_traversal_absolute_noncanonical_and_wrong_prefix_paths_are_rejected(self):
        for name in ["../escape", "/absolute", provenance.ARCHIVE_DIRECTORY + "/../escape",
                     provenance.ARCHIVE_DIRECTORY + "/./escape", provenance.ARCHIVE_DIRECTORY + "//escape",
                     provenance.ARCHIVE_DIRECTORY + "/back\\slash", "other-crate/file"]:
            with self.subTest(path=name):
                member = tarfile.TarInfo(name)
                with self.assertRaises(ValueError):
                    provenance.extract_archive(self.archive([member]), self.root / "extract")
                self.assertFalse((self.root / "extract").exists())

    def test_symlinks_hardlinks_and_special_files_are_rejected_before_writes(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE, tarfile.BLKTYPE]:
            with self.subTest(kind=kind):
                unsafe = self.member("link", kind)
                unsafe.linkname = "../outside"
                with self.assertRaises(ValueError):
                    provenance.extract_archive(self.archive([self.member(), unsafe]), self.root / "extract")
                self.assertFalse((self.root / "extract").exists())

    def test_duplicate_names_are_rejected_before_writes(self):
        for entries in [[self.member(), self.member()],
                        [self.member("directory", tarfile.DIRTYPE), self.member("directory/", tarfile.DIRTYPE)]]:
            with self.subTest(entries=entries), self.assertRaises(ValueError):
                provenance.extract_archive(self.archive(entries), self.root / "extract")
            self.assertFalse((self.root / "extract").exists())

    def test_member_count_is_bounded_before_writes(self):
        entries = [self.member(f"file-{number}") for number in range(4097)]
        with self.assertRaises(ValueError):
            provenance.extract_archive(self.archive(entries), self.root / "extract")
        self.assertFalse((self.root / "extract").exists())

    def test_declared_uncompressed_size_is_bounded_before_reading_body(self):
        archive = self.root / "oversized.crate"
        member = self.member()
        member.size = provenance.MAX_EXTRACTED_BYTES + 1
        with gzip.open(archive, "wb") as stream:
            stream.write(member.tobuf())
        with self.assertRaises(ValueError):
            provenance.extract_archive(archive, self.root / "extract")
        self.assertFalse((self.root / "extract").exists())


if __name__ == "__main__":
    unittest.main()
