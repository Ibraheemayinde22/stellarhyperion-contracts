# @hyperion/protocol

The facts both halves of Hyperion have to agree on.

Hyperion is a router, not a bridge. It never decides on its own that a cross chain message is real;
it hands transfers to rails that already made that decision and were audited for it, and it keeps
the bookkeeping, the limits and the fees. That split is the reason this package exists. Two
contracts, an indexer, a keeper and a web app all need the same answer to the same questions: what
a rail is called, how a Stellar address is encoded, how many decimal places survive a hop, how a
flow window decays, and what a revert actually meant. Four implementations of those answers is
three too many, and the three that drift are the ones nobody notices until somebody's money is in
the wrong place.

So this package holds one copy, and a test suite that checks it against the contracts rather than
against itself.

## What is in here

| Module        | What it is for                                                                         |
| ------------- | -------------------------------------------------------------------------------------- |
| `bytes`       | Hex, big endian integers, ascii, slicing that refuses a short read instead of clamping |
| `routes`      | The four rails, their tag values, and what is true about each one                      |
| `errors`      | Both chains' error vocabularies with a sentence of help per error                      |
| `addresses`   | Stellar strkeys: parse, encode, and the two wire forms the rails want                  |
| `notes`       | The notes Hyperion writes into a rail's payload so a delivery knows who it is for      |
| `amounts`     | Fees, decimal conversion, and formatting that never touches a float                    |
| `flow`        | Sliding flow windows, the same arithmetic both routers run                             |
| `cctp`        | Reading CCTP V2 messages, which is all this side ever does with them                   |
| `chains`      | Chains, rpc endpoints, explorers, CCTP domains, finality                               |
| `quotes`      | Pricing a rail locally, so an app can render four of them while somebody types         |
| `deployments` | Deployment records, and a loader that checks them instead of casting them              |
| `registry`    | Assets and rail contracts per chain, with provenance attached                          |
| `abi`         | Generated from the Foundry build, behind its own entry point                           |

```ts
import { parseStellarAddress, planQuotes, formatUnits } from "@hyperion/protocol";
import { hyperionRouterAbi } from "@hyperion/protocol/abi";
```

The ABIs sit behind `@hyperion/protocol/abi` so an app that only wants to format an amount does not
pull forty kilobytes of JSON into its bundle to get it.

## Asset identity, and why a symbol is not one

A ticker names an asset the way a surname names a person. `USDC` on Base can be Circle's native
issuance or an Axelar Interchain Token Service representation of it, and those are two contracts
with two addresses, sometimes two precisions and two different sets of rails. Picking the first
entry that matches a symbol is how a transfer leaves as the wrong token.

So the identity of an asset is everything that distinguishes it on its chain:

- the chain key (`base`, `stellar-testnet`, …)
- the representation, `native` or `its`
- the on-chain handle: an EVM contract address, or a Stellar code and issuer

The registry and the deployment loader both expose identity-first lookups:

```ts
import {
  assetIdentity,
  assetOn,
  assetByIdentity,
  resolveAsset,
  resolveAssetForRoute,
  resolveToken,
  tokenByIdentity,
  planQuoteForAsset,
} from "@hyperion/protocol";

resolveAsset({ chain: "base", symbol: "USDC" });
// → { ok: false, reason: "ambiguous", candidates: [native, its] }

resolveAsset({ chain: "base", symbol: "USDC", representation: "its" });
// → { ok: true, asset: the ITS entry }

resolveAssetForRoute("base", RouteKind.Cctp, "USDC");
// → { ok: true, asset: native USDC }, because the ITS entry does not list CCTP
```

`resolveAsset`, `resolveAssetForRoute` and `resolveToken` either name exactly one entry or return a
reason (`not-found` or `ambiguous`) and the candidates, so a picker can show the choice instead of
hiding it. `assetByIdentity` and `tokenByIdentity` take an identity and answer a single asset or
null; they never approximate. `planQuoteForAsset` and `planQuotesForAsset` price a named identity,
and an identity the registry does not carry, or a rail the representation is not registered for,
comes back `TokenNotRegistered` rather than priced against whatever token the snapshot held.

### Legacy symbol lookup

`assetOn(chain, symbol)` and `tokenFor(set, chain, symbol)` remain, because plenty of code only
knows a ticker and a chain. Their ambiguity behaviour is now explicit and the same in both:

- exactly one match returns it
- no match returns null
- **more than one match returns null**

A duplicate symbol never silently resolves to the first entry. `pairExists` and `routesForPair`
follow `assetOn`, so an ambiguous end makes them answer `false` and `[]` rather than guess.
Migration is mechanical: if a call site can see two representations of one ticker, switch it to
`resolveAsset({ chain, symbol, representation })`, `resolveAssetForRoute` or `assetByIdentity`.

### Deployment records

Deployment token entries may now carry two optional fields:

```json
"tokens": {
  "USDC": { "address": "0x8335…2913", "representation": "native", … },
  "USDC.its": {
    "symbol": "USDC",
    "representation": "its",
    "address": "0x…",
    "routes": ["axelar-its"],
    …
  }
}
```

`symbol` defaults to the map key and `representation` defaults to `native`, so every file written
before this change loads unchanged and keeps its current meaning. The map key is now free to be a
stable identity key (`USDC.its`) rather than a ticker, which is what allows two representations of
one asset in one record. Unknown representation values are refused by the loader with the field
path, because a typo must not quietly promote an ITS representation to native.

Compatibility is additive: no existing exported name changed its parameters or return type, and
`quoteBatch` results grew one field (`asset`, null when no identity was supplied). The one
behavioural change is the ambiguity rule above, which only differs for a registry or record that
actually lists a duplicate symbol.

### Current deployment scope

The active deployment is **Stellar Testnet, outbound ITS/CCTP**. EVM and other rail development
remains explicitly gated until it is independently validated; the EVM entries in `registry` are
reference data for those rails and are not evidence that a route is live. Identity resolution
does not change that gate: a resolved asset says what token a rail would use, not that the rail is
enabled on chain.

## Three decisions worth knowing about

**No runtime dependencies.** Everything works on `Uint8Array` and `bigint`. No `Buffer`, no viem at
runtime, nothing that assumes Node. The same module is imported by a browser bundle and by a
Fastify process, and neither should be paying for the other's conveniences.

**`bigint` wherever money or an identifier appears.** A `uint256` does not fit in a double, and
neither does a muxed sub account id. The test suite uses two to the fifty three plus one as a
fixture precisely because that is the first integer a `number` gets wrong, and getting it wrong
means crediting the wrong sub account rather than throwing.

**Formatting is canonical, not localised.** `formatUnits` emits no thousands separators, and
`parseUnits` refuses a comma rather than guessing what it meant. A comma is a decimal point across
most of Europe, so a package that grouped digits here would be handing somebody a figure out by a
factor of a thousand. Grouping is a presentation decision; `Intl.NumberFormat` in the app already
knows whose conventions to use. What comes out of `formatUnits` goes straight back into
`parseUnits` unchanged, which is what makes it safe to put in an input field.

## The parity test

`test/parity.test.ts` is the reason to trust the rest. It reads the Rust and the Solidity off disk
and checks that:

- `SOROBAN_ERROR_NAMES` matches `HyperionError` name for name and number for number, and that the
  numbering really does start at one. Reordering that enum would relabel every failure the Stellar
  side has ever emitted, each one plausibly, which is the worst kind of wrong.
- `EVM_ERROR_NAMES` matches the declaration order in `HyperionErrors.sol`.
- Every error selector equals `keccak256` of its signature, so no selector is ever typed by hand.
- `RouteKind`, `AddressKind` and `QuoteBlocker` carry the same integers in all three languages.
- The CCTP offsets, the SEP-23 version bytes, the note layout and the fee and decimal ceilings
  match the constants the contracts actually use.
- Regenerating `src/abi` produces byte for byte what is committed.

The address fixtures are lifted from `evm/test/unit/StellarAddress.t.sol`, which already passes
against a Solidity implementation, and most of them also appear in the Rust suite. A codec checked
only against its own encoder proves the pair agree with each other and nothing else. The one number
in the suite that comes from outside this repository is the CRC16 of a known body, `0xB1D5`,
because a checksum that only agrees with itself is not a checksum.

## Working on it

```bash
npm install          # the committed lockfile is what CI installs
npm run gen          # regenerate src/abi from ../../evm/out, after a forge build
npm run check        # format, lint, typecheck, test, build
```

`npm run gen` needs `forge build` to have run in `../../evm` first. It reads what the compiler
produced rather than guessing, and says so if the artifacts are missing.

`.npmrc` sets `legacy-peer-deps`, and that is deliberate rather than lazy. viem pulls `abitype`,
whose peer range is `typescript >=5.0.4`; TypeScript 7 satisfies that while this package pins the
5.x line `typescript-eslint` supports, and npm's peer resolver walks that conflict into a null node
and dies before writing a single file. Every dependency here is a dev dependency, the package ships
with none at runtime, and `package-lock.json` is committed, so what CI installs is what was tested.
The flag lives in the repository rather than in somebody's shell history because an install flag
that only exists on one machine is a build that only works on one machine.

## Provenance

Addresses in `registry/contracts.ts` and `registry/assets.ts` carry a `source` and a `confirmed`
flag. `confirmed: true` means a primary source was read for that exact entry while this was being
written. Circle's CCTP V2 contracts are address identical across EVM chains, so the Ethereum, Base
and Sepolia entries ship as defaults and are marked `confirmed: false`, because "it is the same
everywhere else" is a reasonable inference and not a reading. Stellar's CCTP addresses are absent
entirely rather than guessed; they come from the deployment record. Shipping a plausible address as
if it were verified is how somebody loses money to a deploy script that looked fine.
