#!/usr/bin/env python3
"""Verify exact native host bytes against the reviewed upstream archive and patch."""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
import tomllib
import urllib.request


ROOT = Path(__file__).resolve().parents[2]
ARCHIVE_URL = "https://static.crates.io/crates/soroban-env-host/soroban-env-host-29.0.1.crate"
ARCHIVE_DIRECTORY = "soroban-env-host-29.0.1"
MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
MAX_EXTRACTED_BYTES = 32 * 1024 * 1024
EXPECTED_TREE_SHA256 = "f56ace5e639366ecb677c2bc26fd2b1692affbd753df1cd4b6c52b157bfe5463"
# Updating these pins requires reviewing the archive, patch and every overlay together.
EXPECTED_METADATA = {
    "crate": "soroban-env-host",
    "version": "29.0.1",
    "upstream_repository": "https://github.com/stellar/rs-soroban-env",
    "upstream_revision": "ff6ae01b3465ac44185d2824876491e62c9a4cc4",
    "archive_sha256": "e545c3ba835e63894f23dae1e5f1e0221b0b15ae2f119ddeb88c5eb2b4ae9751",
    "license_sha256": "1d8e79dfd4c7a8702e6fa49e45a2f1b4b553a9507b29b2dc14d3656b7c47862f",
    "patch_file": "soroban-env-host-rustcrypto.patch",
    "patch_sha256": "48a21c883fafa443d1df73c3d58ba147415b12fe2f2cd2e923619d2e9e97ef0d",
    "patch_paths": ["Cargo.toml", "src/crypto/mod.rs", "src/cost_runner/util.rs", "tests/secp256r1_sig_ver.rs"],
    "source_only_paths": ["Cargo.lock", "src/test/hostile.rs"],
    "added_paths": ["LICENSE", "tests/hyperion_crypto_compatibility.rs"],
    "omitted_archive_paths": ["src/test/hostile_inputs/example_add_i32.wasm", "src/test/hostile_inputs/smoke.wasm"],
    "vector_test": "tests/hyperion_crypto_compatibility.rs",
    "source_only_sha256": {
        "Cargo.lock": "8847b998cafdb8c56151293aa2b18465e8efd9525ee1e0c7820769aba5657c0c",
        "src/test/hostile.rs": "5df2d5f06aa6e82bffd1e3a4d3836a4377e7de6921a40e4a11158fb01539e6cf",
    },
    "added_sha256": {
        "LICENSE": "1d8e79dfd4c7a8702e6fa49e45a2f1b4b553a9507b29b2dc14d3656b7c47862f",
        "tests/hyperion_crypto_compatibility.rs": "0e10fcadd1f30da1c45adfc950a66930775508c7539dda4b8ed2e4f4b24c9c7b",
    },
    "expected_tree_sha256": EXPECTED_TREE_SHA256,
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def regular_file(path: Path) -> bool:
    return stat.S_ISREG(path.lstat().st_mode)


def safe_relative(path: str) -> bool:
    return (isinstance(path, str) and bool(re.fullmatch(r"[A-Za-z0-9_.\-/]+", path))
            and not PurePosixPath(path).is_absolute()
            and not any(part in ("", ".", "..") for part in path.split("/")))


def tree_digest(digests: dict[str, str]) -> str:
    return hashlib.sha256(json.dumps(digests, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def file_digests(directory: Path) -> tuple[dict[str, str], list[str]]:
    """Read regular files only; never traverse or open a contributed symlink."""
    if directory.is_symlink() or not directory.is_dir():
        return {}, [f"source directory unavailable or symlinked: {directory.name}"]
    digests: dict[str, str] = {}
    errors: list[str] = []
    for parent, directories, filenames in os.walk(directory, followlinks=False):
        for name in list(directories) + filenames:
            path = Path(parent) / name
            relative = path.relative_to(directory).as_posix()
            mode = path.lstat().st_mode
            if stat.S_ISLNK(mode) or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                errors.append(f"unsupported vendored entry: {relative}")
                if name in directories:
                    directories.remove(name)
            elif stat.S_ISREG(mode):
                digests[relative] = sha256(path)
    return digests, errors


def compare_digests(actual: dict[str, str], expected: dict[str, str]) -> list[str]:
    return ([f"unexpected vendored path: {path}" for path in sorted(actual.keys() - expected.keys())]
            + [f"missing upstream or reviewed path: {path}" for path in sorted(expected.keys() - actual.keys())]
            + [f"vendored byte mismatch: {path}" for path in sorted(actual.keys() & expected.keys())
               if actual[path] != expected[path]])


def patch_paths(patch: str) -> set[str]:
    paths = set()
    for left, right in re.findall(r"^--- a/(\S+)\n\+\+\+ b/(\S+)$", patch, re.MULTILINE):
        if left != right or not safe_relative(left):
            raise ValueError("patch renames or unsafe paths are not permitted")
        paths.add(left)
    return paths


def verify_metadata(manifest: dict) -> list[str]:
    if not isinstance(manifest, dict):
        return ["provenance manifest must be an object"]
    errors = [f"unexpected {key} in provenance manifest" for key, expected in EXPECTED_METADATA.items()
              if manifest.get(key) != expected]
    expected_files = manifest.get("file_sha256")
    if (not isinstance(expected_files, dict) or not expected_files
            or any(not safe_relative(path) or not isinstance(digest, str)
                   or not re.fullmatch(r"[0-9a-f]{64}", digest)
                   for path, digest in expected_files.items())):
        errors.append("invalid expected source file digests")
    elif tree_digest(expected_files) != EXPECTED_TREE_SHA256:
        errors.append("reviewed source digest inventory mismatch")
    return errors


def read_toml(path: Path) -> dict:
    if not regular_file(path):
        raise ValueError(f"non-regular dependency manifest: {path.name}")
    return tomllib.loads(path.read_text(encoding="utf-8"))


def table(document: dict, key: str) -> dict:
    value = document.get(key, {})
    if not isinstance(value, dict):
        raise ValueError(f"dependency manifest section {key} must be a table")
    return value


def string_list(document: dict, key: str) -> list[str]:
    value = document.get(key, [])
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError(f"dependency manifest section {key} must be a string array")
    return value


def dependency_tables(document: dict):
    for name in ("dependencies", "build-dependencies", "dev-dependencies"):
        yield table(document, name)
    yield table(table(document, "workspace"), "dependencies")
    for target in table(document, "target").values():
        if not isinstance(target, dict):
            raise ValueError("target dependency manifest section must be a table")
        for name in ("dependencies", "build-dependencies", "dev-dependencies"):
            yield table(target, name)


def local_dependency_path(root: Path, manifest: Path, target: str) -> Path:
    """Normalize without following links or inspecting any external directory."""
    target_path = Path(os.path.abspath(manifest.parent / target))
    if not target_path.is_relative_to(root):
        raise ValueError("external path dependency cannot be verified")
    candidate = root
    for part in target_path.relative_to(root).parts:
        candidate = candidate / part
        if candidate.is_symlink():
            raise ValueError("symlinked path dependency cannot be verified")
    return target_path


def verify_dependencies(root: Path) -> list[str]:
    soroban = root / "soroban"
    host = soroban / "vendor/soroban-env-host"
    workspace = read_toml(soroban / "Cargo.toml")
    errors = []
    workspace_section = table(workspace, "workspace")
    if "vendor/soroban-env-host" not in string_list(workspace_section, "exclude"):
        errors.append("native host is not excluded from the Soroban workspace")
    if table(table(workspace, "patch"), "crates-io").get("soroban-env-host") != {"path": "vendor/soroban-env-host"}:
        errors.append("native host patch is not pinned to the vendored path")
    for member in string_list(workspace_section, "members"):
        if fnmatch.fnmatch("vendor/soroban-env-host", os.path.normpath(member)):
            errors.append("native host is included as a contract workspace member")
        if not os.path.normpath(member).startswith("crates/"):
            errors.append("contract workspace member is outside the reviewed crates directory")
    manifests = [soroban / "Cargo.toml"]
    crates = soroban / "crates"
    if crates.is_symlink():
        return errors + ["symlinked contract manifest directory"]
    for parent, directories, filenames in os.walk(crates, followlinks=False):
        for name in list(directories):
            if (Path(parent) / name).is_symlink():
                directories.remove(name)
                errors.append("symlinked contract manifest directory")
        if "Cargo.toml" in filenames:
            manifests.append(Path(parent) / "Cargo.toml")
    for path in manifests:
        for dependencies in dependency_tables(read_toml(path)):
            for name, dependency in dependencies.items():
                if not isinstance(dependency, (str, dict)):
                    raise ValueError("dependency specification must be a version or table")
                package = dependency.get("package", name) if isinstance(dependency, dict) else name
                target = dependency.get("path") if isinstance(dependency, dict) else None
                if not isinstance(package, str) or (target is not None and not isinstance(target, str)):
                    raise ValueError("dependency package and path must be strings")
                target_path = local_dependency_path(root, path, target) if target is not None else None
                if package == "soroban-env-host" or target_path == host:
                    errors.append(f"native-only host dependency leaked into WASM graph: {path.relative_to(root)}")
    return errors


def verify_local(root: Path, manifest: dict) -> list[str]:
    vendor = root / "soroban/vendor"
    host = vendor / "soroban-env-host"
    for path in (root, root / "soroban", vendor, host):
        if path.is_symlink():
            return [f"symlinked provenance directory: {path.name}"]
    actual, errors = file_digests(host)
    errors.extend(compare_digests(actual, manifest["file_sha256"]))
    patch = vendor / manifest["patch_file"]
    if not regular_file(patch) or sha256(patch) != manifest["patch_sha256"]:
        errors.append("patch checksum mismatch")
    elif patch_paths(patch.read_text(encoding="utf-8")) != set(manifest["patch_paths"]):
        errors.append("unexpected patch paths")
    for path, digest in (manifest["source_only_sha256"] | manifest["added_sha256"]).items():
        if actual.get(path) != digest:
            errors.append(f"reviewed overlay checksum mismatch: {path}")
    vcs = host / ".cargo_vcs_info.json"
    if actual.get(".cargo_vcs_info.json") == manifest["file_sha256"].get(".cargo_vcs_info.json"):
        metadata = json.loads(vcs.read_text(encoding="utf-8"))
        if metadata.get("git", {}).get("sha1") != manifest["upstream_revision"] or metadata.get("path_in_vcs") != "soroban-env-host":
            errors.append("upstream revision mismatch")
    readme = vendor / "README.md"
    if not regular_file(readme) or manifest["upstream_revision"] not in readme.read_text(encoding="utf-8"):
        errors.append("README does not reference the reviewed upstream revision")
    errors.extend(verify_dependencies(root))
    return errors


def extract_archive(archive_path: Path, destination: Path) -> Path:
    """Reject links, special files, duplicate names and escapes before writing anything."""
    with tarfile.open(archive_path, "r:gz") as archive:
        members = []
        names = set()
        total = 0
        for member in archive:
            name = member.name.rstrip("/")
            if (not safe_relative(name) or not (name == ARCHIVE_DIRECTORY or name.startswith(ARCHIVE_DIRECTORY + "/"))
                    or not (member.isfile() or member.isdir()) or name in names):
                raise ValueError("crate archive contains an unsafe or duplicate path")
            names.add(name)
            total += member.size
            members.append(member)
            if member.size < 0 or len(members) > 4096 or total > MAX_EXTRACTED_BYTES:
                raise ValueError("crate archive exceeds extraction limits")
        for member in members:
            target = destination / member.name
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                stream = archive.extractfile(member)
                if stream is None:
                    raise ValueError("crate archive member is unreadable")
                with stream, target.open("wb") as output:
                    output.write(stream.read())
    return destination / ARCHIVE_DIRECTORY


def compare_archive(archive_root: Path, manifest: dict, root: Path = ROOT) -> list[str]:
    errors = verify_metadata(manifest)
    if errors:
        return errors
    vendor = root / "soroban/vendor"
    host = vendor / "soroban-env-host"
    patch = vendor / manifest["patch_file"]
    if not regular_file(patch) or sha256(patch) != manifest["patch_sha256"]:
        return ["patch checksum mismatch"]
    original, errors = file_digests(archive_root)
    for path in manifest["source_only_paths"] + manifest["omitted_archive_paths"]:
        if path not in original:
            errors.append(f"reviewed upstream path is absent: {path}")
    for path in manifest["added_paths"]:
        if path in original:
            errors.append(f"reviewed added path already exists upstream: {path}")
    if errors:
        return errors
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_SYSTEM="/dev/null", GIT_CONFIG_NOSYSTEM="1")
    result = subprocess.run(["git", "apply", "--unidiff-zero", str(patch)], cwd=archive_root,
                            env=env, capture_output=True, text=True)
    if result.returncode != 0:
        return ["reviewed patch does not apply to the pinned archive"]
    for path, digest in (manifest["source_only_sha256"] | manifest["added_sha256"]).items():
        source = host / path
        if source.is_symlink() or not source.is_file() or sha256(source) != digest:
            errors.append(f"reviewed overlay checksum mismatch: {path}")
            continue
        target = archive_root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read_bytes())
    for path in manifest["omitted_archive_paths"]:
        (archive_root / path).unlink()
    expected, problems = file_digests(archive_root)
    errors.extend(problems)
    if tree_digest(expected) != EXPECTED_TREE_SHA256:
        errors.append("archive plus reviewed patch does not reproduce the pinned source tree")
    actual, problems = file_digests(host)
    errors.extend(problems)
    errors.extend(compare_digests(actual, expected))
    return errors


def verify(manifest: dict, *, root: Path = ROOT, offline: bool = False, archive_path: Path | None = None) -> list[str]:
    errors = verify_metadata(manifest)
    if errors:
        return errors
    errors = verify_local(root, manifest)
    if errors or (offline and archive_path is None):
        return errors
    with tempfile.TemporaryDirectory(prefix="hyperion-host-") as temporary:
        directory = Path(temporary)
        if archive_path is None:
            archive_path = directory / "host.crate"
            with urllib.request.urlopen(ARCHIVE_URL, timeout=30) as response:
                data = response.read(MAX_ARCHIVE_BYTES + 1)
            if len(data) > MAX_ARCHIVE_BYTES:
                return ["crate archive exceeds download limit"]
            archive_path.write_bytes(data)
        if not regular_file(archive_path) or archive_path.stat().st_size > MAX_ARCHIVE_BYTES or sha256(archive_path) != manifest["archive_sha256"]:
            return ["crates.io archive checksum mismatch"]
        archive_root = extract_archive(archive_path, directory / "extract")
        return compare_archive(archive_root, manifest, root)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--offline", action="store_true", help="verify actual local bytes and boundaries without downloading")
    parser.add_argument("--archive", type=Path, help="use an already downloaded, checksum-verified crate instead of the network")
    args = parser.parse_args()
    try:
        manifest_path = ROOT / "soroban/vendor/provenance.json"
        if any(path.is_symlink() for path in (ROOT, ROOT / "soroban", manifest_path.parent, manifest_path)):
            raise ValueError("symlinked provenance manifest")
        if not regular_file(manifest_path):
            raise ValueError("non-regular provenance manifest")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        errors = verify(manifest, root=ROOT, offline=args.offline, archive_path=args.archive)
    except (OSError, ValueError, tarfile.TarError) as error:
        errors = [f"provenance input cannot be verified: {type(error).__name__}"]
    if errors:
        print("dependency provenance verification failed:", file=sys.stderr)
        print("\n".join(f"- {error}" for error in errors), file=sys.stderr)
        return 1
    print("dependency provenance verified")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
