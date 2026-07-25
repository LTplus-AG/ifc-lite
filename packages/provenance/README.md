# @ifc-lite/provenance

**Experimental research prototype. Private package, not published to npm.**

A prototype certificate library for proof-carrying model changes, built
against the node-hash-v0 spec
([`docs/vision/spec/node-hash-v0.md`](../../docs/vision/spec/node-hash-v0.md),
moonshot M1 "Proof-carrying buildings" in
[`docs/vision/moonshots-tech.md`](../../docs/vision/moonshots-tech.md)).

## Status: 0.0.x, format NOT frozen

- The **node-hash-v0 format is NOT FROZEN**. The design decisions in the
  spec's section 6 are recorded, but freezing the byte format is an explicit,
  separate human-calendar act (ABI-freeze rule). Hashes produced today may
  not verify against a future build. Do not persist certificates anywhere
  that outlives a repo checkout.
- The package is `private: true` and versioned 0.0.x. Every export may be
  renamed, reshaped, or deleted without a changeset or deprecation cycle.
- No other workspace package may depend on it yet; consumers are the
  research demos under `scripts/moonshot/`.

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
