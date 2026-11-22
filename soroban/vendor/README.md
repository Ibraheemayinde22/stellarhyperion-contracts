# Native Soroban host security patch

`soroban-env-host/` contains the published `soroban-env-host` 29.0.1 crate sources,
with the reviewed changes below and a local RustCrypto compatibility patch for
RUSTSEC-2026-0387. Upstream:
https://github.com/stellar/rs-soroban-env/tree/ff6ae01b3465ac44185d2824876491e62c9a4cc4/soroban-env-host

The crates.io archive SHA-256 is
`e545c3ba835e63894f23dae1e5f1e0221b0b15ae2f119ddeb88c5eb2b4ae9751`,
matching the original Cargo.lock checksum. `.cargo_vcs_info.json` is preserved.
`LICENSE` is the Apache-2.0 license fetched from the same upstream commit.
No upstream host source or cryptographic functionality is removed.
The two published hostile-input WASM binaries are omitted; their corresponding
native cases remain ignored. The exact paths are recorded in `provenance.json`.

## Changes

`soroban-env-host-rustcrypto.patch` records the manifest and existing-source diff
against that archive (zero context; use `git apply --unidiff-zero` when replaying). k256/p256 move to 0.14, ecdsa to 0.17, elliptic-curve to
0.14.3 and sec1 to 0.8.1. The workspace lockfile selects crypto-bigint 0.7.10
(the advisory fix is >=0.7.6). Native host builds require Rust >=1.87.

The host adopts the replacement EcdsaCurve bounds and `to_sec1_point` API.
Signature byte parsing, low-S rejection, prehash verification, recovery IDs,
uncompressed SEC1 output and budget charging remain in place. The benchmark
helper uses the same new SEC1 API. The existing P-256 tests use the replacement
point/normalization APIs; their published NIST and Wycheproof vectors are retained.
`Cargo.toml.orig` remains the unmodified upstream manifest for reference.

The vendored lockfile records the standalone test dependencies.
`tests/hyperion_crypto_compatibility.rs` adds public upstream secp256k1 recovery
and P-256 vectors with invalid sizes, recovery IDs, zero/corrupted signatures and
explicit high-S rejection. These complement the upstream suites, which normalize
S before verification.

Upstream trailing whitespace in the hostile-WASM test table is removed separately
from the cryptography patch.

## Verification and maintenance

`../../.github/scripts/verify_vendor_provenance.py` verifies every vendored file
against the reviewed 270-file SHA-256 inventory and its pinned aggregate digest.
It checks the upstream revision, license, patch, source-only overlays and added
tests, rejects missing or unexpected files and symlinks, and confirms the host
is excluded from the contract workspace and direct WASM dependencies. Patched
and source-only files receive the same exact byte checks as upstream files.

The full check downloads the checksum-pinned crates.io archive, rejects unsafe
archive entries, applies the reviewed zero-context patch, copies individually
pinned overlays and removes only the two documented binary omissions. That
reconstructed tree must match both the pinned inventory and every local file.
From the repository root:

```sh
python3 -B .github/scripts/verify_vendor_provenance.py
python3 -B .github/scripts/verify_vendor_provenance.py --offline
```

`--offline` verifies actual local bytes and dependency boundaries without a
download. For full reconstruction without network access, pass an existing
archive with `--archive /path/to/soroban-env-host-29.0.1.crate`; its checksum is
always rechecked. Run the mutation regressions with that same cached archive:

```sh
VENDOR_PROVENANCE_ARCHIVE=/path/to/soroban-env-host-29.0.1.crate \
  python3 -B -m unittest discover -s .github/scripts -p test_verify_vendor_provenance.py -v
```

CI runs full reconstruction and mutation regressions immediately after checkout,
before Cargo writes build artifacts. Keep standalone native build output outside
the vendored source tree with `CARGO_TARGET_DIR`; unexpected generated files also
fail provenance verification. Updating this dependency requires reviewing and
updating the archive, patch, overlay hashes, full file inventory and verifier
trust pins together.

From `soroban/`:

```sh
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
CARGO_TARGET_DIR=target cargo test --manifest-path vendor/soroban-env-host/Cargo.toml --locked \
  --features testutils --test secp256r1_sig_ver --test ed25519_edge_cases \
  --test hyperion_crypto_compatibility
cargo audit --file Cargo.lock
cargo audit --file vendor/soroban-env-host/Cargo.lock
```

The host is used for native execution/testing and is absent from the normal
`wasm32v1-none` contract dependency graph. Compare rebuilt contract WASM hashes
against saved artifacts before any release; this dependency fix requires no
on-chain contract upgrade. Passing tests and dependency audits is not a formal
cryptographic audit.

Keep this patch narrow. Replace it with an official compatible Soroban host
release once available, rerun these vectors and the owned contract suite, then
remove the crates.io patch and vendor directory together. Do not suppress the
advisory or substitute an unrelated crypto-bigint major without adapting callers.
