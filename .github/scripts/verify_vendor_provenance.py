#!/usr/bin/env python3
"""Verify the provenance and dependency boundary of the native host patch."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
VENDOR = ROOT / "soroban" / "vendor"
HOST = VENDOR / "soroban-env-host"
MANIFEST_PATH = VENDOR / "provenance.json"
ARCHIVE_URL = "https://crates.io/api/v1/crates/soroban-env-host/29.0.1/download"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def files(root: Path) -> set[str]:
    return {path.relative_to(root).as_posix() for path in root.rglob("*") if path.is_file()}


def patch_paths(patch: str) -> set[str]:
    paths = set()
    for left, right in re.findall(r"^--- a/(\S+)\n\+\+\+ b/(\S+)$", patch, re.MULTILINE):
        if left != right:
            raise ValueError(f"patch renames are not permitted: {left} -> {right}")
        paths.add(left)
    return paths


def compare_archive(archive_root: Path, manifest: dict) -> list[str]:
    archive_files = files(archive_root)
    host_files = files(HOST)
    expected_patch = set(manifest["patch_paths"])
    expected_source = set(manifest["source_only_paths"])
    expected_added = set(manifest["added_paths"])
    expected_omitted = set(manifest["omitted_archive_paths"])
    errors: list[str] = []

    for relative in sorted(host_files - archive_files):
        if relative not in expected_added:
            errors.append(f"unexpected vendored path: {relative}")
    for relative in sorted(archive_files - host_files):
        if relative not in expected_omitted:
            errors.append(f"missing upstream path: {relative}")
    for relative in sorted(host_files & archive_files):
        if relative in expected_patch or relative in expected_source:
            continue
        if (HOST / relative).read_bytes() != (archive_root / relative).read_bytes():
            errors.append(f"unexpected vendored modification: {relative}")

    changed = {
        relative
        for relative in sorted(host_files & archive_files)
        if (HOST / relative).read_bytes() != (archive_root / relative).read_bytes()
    }
    allowed_changed = expected_patch | expected_source
    for relative in sorted(changed - allowed_changed):
        errors.append(f"unexpected vendored modification: {relative}")
    return errors


def verify(manifest: dict) -> list[str]:
    errors: list[str] = []
    patch = (VENDOR / manifest["patch_file"]).read_text(encoding="utf-8")
    expected_patch = set(manifest["patch_paths"])
    actual_patch = patch_paths(patch)
    if actual_patch != expected_patch:
        errors.append(f"unexpected patch paths: {sorted(actual_patch ^ expected_patch)}")
    if sha256(VENDOR / manifest["patch_file"]) != manifest["patch_sha256"]:
        errors.append(f"patch checksum mismatch: {manifest['patch_file']}")
    if sha256(HOST / "LICENSE") != manifest["license_sha256"]:
        errors.append("license checksum mismatch: soroban/vendor/soroban-env-host/LICENSE")

    vcs = json.loads((HOST / ".cargo_vcs_info.json").read_text(encoding="utf-8"))
    if vcs.get("git", {}).get("sha1") != manifest["upstream_revision"]:
        errors.append("upstream revision mismatch: soroban/vendor/soroban-env-host/.cargo_vcs_info.json")
    readme = (VENDOR / "README.md").read_text(encoding="utf-8")
    if manifest["upstream_revision"] not in readme:
        errors.append("README does not reference the verified upstream revision")
    vector_test = HOST / manifest["vector_test"]
    vector_text = vector_test.read_text(encoding="utf-8")
    if manifest["upstream_revision"] not in vector_text:
        errors.append(f"cryptographic vector test does not reference {manifest['upstream_revision']}: {manifest['vector_test']}")

    cargo = (ROOT / "soroban" / "Cargo.toml").read_text(encoding="utf-8")
    if 'exclude = ["vendor/soroban-env-host"]' not in cargo:
        errors.append("native host is not excluded from the Soroban workspace")
    if '[patch.crates-io]\nsoroban-env-host = { path = "vendor/soroban-env-host" }' not in cargo:
        errors.append("native host patch is not pinned to the vendored path")
    for manifest_path in (ROOT / "soroban" / "crates").rglob("Cargo.toml"):
        text = manifest_path.read_text(encoding="utf-8")
        if "soroban-env-host" in text:
            errors.append(f"native-only host dependency leaked into WASM graph: {manifest_path.relative_to(ROOT)}")

    with tempfile.TemporaryDirectory(prefix="hyperion-host-") as temporary:
        archive_path = Path(temporary) / "host.crate"
        urllib.request.urlretrieve(ARCHIVE_URL, archive_path)
        if sha256(archive_path) != manifest["archive_sha256"]:
            errors.append("crates.io archive checksum mismatch: soroban-env-host-29.0.1")
        else:
            extract = Path(temporary) / "extract"
            extract.mkdir()
            with tarfile.open(archive_path, "r:gz") as archive:
                members = archive.getmembers()
                if any(Path(member.name).is_absolute() or ".." in Path(member.name).parts for member in members):
                    errors.append("crates.io archive contains an unsafe path")
                else:
                    archive.extractall(extract, members=members)
                    errors.extend(compare_archive(extract / "soroban-env-host-29.0.1", manifest))
    return errors


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="only validate metadata and dependency boundaries")
    args = parser.parse_args()
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    errors = verify(manifest) if not args.offline else []
    if args.offline:
        errors = verify_metadata(manifest)
    if errors:
        print("dependency provenance verification failed:", file=sys.stderr)
        print("\n".join(f"- {error}" for error in errors), file=sys.stderr)
        return 1
    print("dependency provenance verified")
    return 0


def verify_metadata(manifest: dict) -> list[str]:
    errors: list[str] = []
    if manifest["upstream_revision"] != "ff6ae01b3465ac44185d2824876491e62c9a4cc4":
        errors.append("unexpected upstream revision in provenance manifest")
    if manifest["archive_sha256"] != "e545c3ba835e63894f23dae1e5f1e0221b0b15ae2f119ddeb88c5eb2b4ae9751":
        errors.append("unexpected archive checksum in provenance manifest")
    if manifest["patch_paths"] != [
        "Cargo.toml",
        "src/crypto/mod.rs",
        "src/cost_runner/util.rs",
        "tests/secp256r1_sig_ver.rs",
    ]:
        errors.append("unexpected patch path policy in provenance manifest")
    return errors


if __name__ == "__main__":
    raise SystemExit(main())
