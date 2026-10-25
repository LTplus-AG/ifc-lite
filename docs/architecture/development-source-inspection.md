# Development source inspection (#7955 A0p)

The nondefault `development-inspection` feature adds one standalone synchronous
WASM export, `inspectDevelopmentSource(bytes, productId, optionsJson)`. It creates
an owned `SourceBundle` and its authenticated decoder, then calls the existing
`processing::element::inspect_retained_source`. It does not add an `IfcAPI`
member. It returns copied UTF-8 diagnostic bytes or throws an `entry_refused`
object carrying the generated typed `code` and `authority: diagnostic_only`.
The processing contract validates options. Product IDs must be positive integral
u32 values; the binding rejects JS numbers that wasm-bindgen would otherwise
truncate. Callers cannot provide source hashes, decoded roots, or decoder owners.

The report stops at the first numerical boundary or source refusal. It has no
numerical adapter, SDK request, Worker, geometry, removal proof, or finality.
It does not complete J4, browser transactions, or the release requirements.
The existing default engine and released retained-browser API remain unchanged;
their breaking replacement belongs to a later A0p/A3 change.

## Building and consuming

Use the repository's admitted worker/fleet launcher for heavy commands. In a
clean source checkout, supply `IFC_RETAINED_BUILD_COMMIT` explicitly from the
original source-pinned build request, then run these root commands:

```sh
pnpm build:wasm:development-inspection
pnpm test:wasm-development-inspection
```

The normal `scripts/build-wasm.sh` regenerates the development JS/WASM/types
under `.retained-dev/wasm/`, never `pkg` or `pkg-retained`. It also generates a
private `tsconfig.json` for the declaration consumer and a compact hash manifest.
The latter records build inputs and bytes, **not an authoritative build receipt**.
Match its compile identity and artifacts against the original worker request and
receipt before claiming qualification. Runtime Git HEAD cannot supply identity.
Missing tools or artifacts fail this development path; a SKIP is unrun coverage.

An actual local Node diagnostic consumer accepts an original fleet request, an
IFC file, a product ID, and a strict options JSON file:

```sh
node scripts/inspect-retained-source.mjs ORIGINAL_REQUEST.json MODEL.ifc 10 OPTIONS.json
```

It validates the generated schema and independently checks source bytes, options,
product ID, and compiled identity. The contract command additionally exercises a
synthetic extrusion reaching numerical work, malformed-source refusal, forged
options, invalid IDs, source changes, and zero fetch/Worker calls. The synthetic
input proves this boundary only, not authored-model or numerical qualification.

The integrated inspection budget captures one start before options/source work,
and nested/resumed allowances preserve it. Native builds retain `std::time::Instant`.
The pinned nightly's `library/std/src/sys/pal/unsupported/time.rs` implements
`Instant::now()` as a panic; `wasm32-unknown-unknown` selects that platform.
Only `retained-runtime` on that target imports the synchronous JS monotonic clock.
It uses [`performance.now()`](https://nodejs.org/api/perf_hooks.html#performancenow),
whose [monotonic clock](https://www.w3.org/TR/hr-time-3/#monotonic-clock) does not
follow wall-clock adjustments. No `Date` fallback or JS callback is retained.
Unavailable, throwing, negative, nonfinite, or regressing samples latch failure
and yield `DEADLINE_EXCEEDED`; they never turn off the deadline. A fresh combined
native/WASM run is required after this clock adaptation; predecessor test counts
do not qualify it.

## Package and declaration containment

`pnpm check:api-surface` includes canonical member signatures for both the
default module and the declaration closure reachable through `RetainedEngine`.
It checks constructors, static/instance methods, properties, overloads, and
generic signatures, and rejects unresolved declaration imports. Only wasm-bindgen
platform trampoline indices and private implementation fields are excluded.
`pnpm api-surface:update --wasm-only` refreshes these two member baselines without
rewriting unrelated export snapshots; use it only for a reviewed surface change.

`pnpm test:packed` inspects actual npm archives including geometry/CLI wildcard
payloads, typechecks installed declaration closures and external negative
consumers, and initializes the real installed default WASM with fetch/Worker
traps. Private JS, WASM, declarations, source maps, and SDK assets must not appear
in those archives. Build the development output before the release build when
qualifying exclusion after development use. No npm package content changes or
publication are part of this slice; private declarations are always generated.
