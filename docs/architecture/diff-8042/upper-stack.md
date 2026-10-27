# #8042 host observations: current-main source preparation

This focused layer starts at engine
`3e24cbe5519bc1e522d217d002c6a0e21d5da91f`, based on accepted main
`97d8add207104d5801c0c8d62e40fa7066e848f8`. It replays only R124's
`02-host` commit `088bf173390ebf44e65f14a638507c5486476b91`, adapting
the two live operations identified in the R128 compatibility audit.
The original engine, R124 layers, final arms and receipts remain historical
references. Foundation landing and runtime qualification are pending the parent.

## Current-main compatibility

Sidecar creation uses host `JSON.stringify` on a structural tuple of
`[base, here]` or `[relation, base, head]` (#8130/#8088). Rust captures the
callee and receiver before reading tuple fields, then invokes that captured
callee through a caught generic primitive. Field/array boundaries, arbitrary
UTF-16, host `toJSON`, first duplicate provenance, sorting and validation are
preserved. Creation still projects only known fields.

Live largest-share migration follows the exact accepted TypeScript short
circuits (#8131/#8084): truthy shares, equal head length, nonempty shares, then
`shares.every(share => Number.isFinite(share) && share >= 0)` before ranking.
Repeated getters, sparse/inherited slots and custom methods remain observable.
The existing best/tie loop and the foundation's native guard are retained.

R135 corrects the R134 review findings: live share callbacks preserve the
original falsy `Number.isFinite` result, and lineage-sidecar validation observes
that current host method after its noncoercive number type check. Both paths
return a boolean only when evaluating `share >= 0`. The raw JSON-text creation
ABI still throws diagnostic strings; live creation throws `Error` objects.
The same live-validation correction preserves `Number.isNaN(Date.parse(value))`:
the NaN callee is looked up before parsing, its return is observed by truthiness,
and a custom parse result passes directly to it without numeric coercion.

Retained method callbacks belong to host GC; borrowed iterator callbacks stay
within the synchronous caught visit boundary. Getter, method, predicate,
comparison and JSON failures return through caught imports. The projection DTO
reader also catches array-proxy length/index reads and object enumeration;
its existing DTO traversal and nesting limit are unchanged. Normalization keeps
host recursion outside active Rust callback frames.

The tie-filter predicate retains only its numeric index in Rust. A generic
caught bridge keeps its entry context in a JS lexical closure, preserving
dynamic getters and retained callback calls while removing the Rust backroot
through `entry -> shares.saved`. Survival tests are prepared for return, throw,
GC and reentry; post-release closure/externref reclamation still needs parent
measurement with the existing decode-leak harness. No runtime leak is claimed
proven or measured by this source correction.

## Tests prepared for parent qualification

The raw WASM tests in `packages/wasm/test/diff-host-*.test.mjs` cover the accepted
eleven-case dedup corpus through text and live exports, lossless keys, share
validation, sparse/custom observations, iterator closing, retained callbacks,
reentry and recovery. They run through the existing root pnpm/turbo test graph.
Missing artifacts skip explicitly; a skip does not qualify this layer.

Observation tests use independently built current-main production TypeScript.
At this host-only stage the local public TS graph retains those algorithms.
Set `IFC_LITE_CURRENT_MAIN_DIFF_ORACLE` to an independently built exact-main
`packages/diff/dist/index.js` when qualifying or composing later layers. A public
WASM facade is rejected as the staging oracle. Record its commit and emitted
graph separately; no historical R124 oracle expectations are used here.
The root Turbo `test` task explicitly passes this variable through its strict
environment. Tests report the selected entry's resolved path and SHA-256;
the expected main commit is a separate label, not inferred from those bytes.

The parent must build fresh payloads, verify generated declarations, run the
root test/typecheck graph, native workspace tests and strict Clippy, and repeat
the retained-callback cases with exposed GC. Both Node 22 and 24 remain required
where applicable. No builds, tests, installations, fleet/storage operations,
performance measurements, package rebinding or final-pair construction were
performed in this preparation. Source and syntax review do not qualify runtime.

Later public/oracle layers need the three accepted-main TS statement changes,
the relocated accepted regressions and corrected separator-conflict assertions.
Their precise adaptation handoff is recorded separately in the R132 receipt;
those later layers are not constructed here.
