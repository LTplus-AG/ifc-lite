# @ifc-lite/provenance

**Research prototype with a FROZEN wire format. Private package, not published to npm.**

A certificate library for proof-carrying model changes, built
against the node-hash-v0 spec
([`docs/vision/spec/node-hash-v0.md`](../../docs/vision/spec/node-hash-v0.md),
moonshot M1 "Proof-carrying buildings" in
[`docs/vision/moonshots-tech.md`](../../docs/vision/moonshots-tech.md)).

## Status: 0.1.x, format FROZEN (node-hash-v0 / 1.0.0, 2026-07-25)

- The **node-hash-v0 wire format is FROZEN** as of 2026-07-25 (spec version
  `node-hash-v0` / 1.0.0, `docs/vision/spec/node-hash-v0.md`). Hashes and
  certificates produced by this package are stable: the byte encodings, the
  tagged-hash string forms, the `NHV0` header, the kind tags, and the sort
  rules may no longer change.
- **Change policy:** any wire-format change, however small, requires a new
  versioned spec file (`node-hash-v1.md`, new magic/version byte) and a
  major version bump of `@ifc-lite/provenance`. Golden wire-format vectors
  in `test/golden/` pin the frozen encoding in CI; a golden-vector test
  failure means a wire-format change and must not be "fixed" by regenerating
  the vectors under the v0 name.
- Additive reserved fields (do not alter any hash): `Certificate.signatures`
  (`{alg: 'ed25519', key, sig}`, ignored by v0 verification, spec section 6
  Q5) and `GeometryMeshPayload.semanticHash` (RTC-invariant annotation,
  never folded into the node hash, spec section 6 Q2).
- The package remains `private: true` (not published to npm). API surface
  (names, types) may still evolve; the WIRE FORMAT may not.
- Consumers today are the research demos under `scripts/moonshot/`.

## What it does

Pure and store-agnostic (like `@ifc-lite/diff`): it never touches a parser,
WASM, or a renderer. Callers supply node payloads and an async
`nodeId -> payload` resolver.

- `node-hash.ts` - canonical node hashing over the building DAG node kinds
  (geometry mesh, property set, relationship, layer, element).
- `certificate.ts` - `createCertificate` / `verifyCertificate` over an
  application-supplied `NodeResolver`, with claims such as
  subtree-untouched, hash-equality, and scalar-delta.
- `dag-engine.ts` - `ProvenanceDag`, a memoized recompute engine over
  composite nodes with telemetry.
- `footprint.ts` - AABB footprints and the conflict predicate used by the
  merge model.
- `merge-model.ts` / `merge-battery.ts` / `commutation.ts` - the
  certified-merge soundness model and its test battery (see
  `docs/vision/reviews/g2-red-team-2026-07-24.md`).

## Develop

```bash
pnpm --filter @ifc-lite/provenance build
pnpm --filter @ifc-lite/provenance test
```

Demos that exercise the library end to end live in `scripts/moonshot/`
(`g0-certificate-demo.mjs`, `g1-memoized-recompute.mjs`,
`g2-merge-soundness.mjs`, `b35-demo/run.mjs`).
