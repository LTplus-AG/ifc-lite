<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Incremental affinity publication qualification (#4051)

The prepass previously computed all remaining geometry routing keys before
publishing bulk jobs. It now publishes each existing chunk immediately after
computing that chunk's keys. The decoder, signature memo, first wave, job order,
chunk boundaries and type-geometry tail are preserved. Earlier publication can
overlap routing with geometry processing; it does not eliminate geometry work.

## Final artifact

[Final timing results](./results.json) and [every pair](./landing-pairs.jsonl)
use alternating base/candidate order, fresh Chrome processes, fixed source-built
distributions and real IFC input. The equal-model aggregation applies only to
the listed subset, not the original full corpus. OS file cache was not flushed.
No native or Firefox performance gain is established. Earlier overlap increases
sampled MEP memory; this is a targeted readiness tradeoff, not a universal
no-regression result.

[Validation](./validation.json) records the final source commit, all changed
Rust inputs, a digest of the tracked Rust/build inputs, binary hash, build logs
and tests. The helper tests enforce publication before later key computation
and immediate callback-error termination. A surgical mutation restoring full
precomputation fails both assertions; restored tests pass. Actual-WASM tests
cover exact job/source-span order, routing keys, owned callback arrays,
prerequisite publication order and repeated prepasses.

[Browser qualification](./browser-qualification.json) covers cold loads in
Chrome and stock Firefox plus properties, hierarchy, real search selections,
GPU picking, federation with overlapping local IDs, actual cache hits and
federation after cache reopening. The served final WASM matches the frozen
binary. These are local functional checks, not deployed verification.

## Artifact attribution correction

The private initial run directory names contain `combined`. Those labels are
wrong: the intended map-cache-plus-publication build reused the affinity-only
Cargo artifact after timestamp-preserving source restoration. Forced Turbo and
matching bundled/package hashes did not prove Cargo recompiled restored source.
The build log reported no crate compilation.

The map-cache source was archived and removed. Removing the crate's WASM
release output and recompiling the initial affinity-only source produced an
exact binary match to the initial measured artifact. The later testable-helper
extraction changed the binary, so final qualification and paired measurements
were repeated on a newly built artifact. No combined/cache gain is attributed.

The [initial timings](./initial-results.json), [pairs](./initial-pairs.jsonl),
[initial validation](./initial-validation.json) and initial whole-MEP
[prepass payload comparison](./prepass-parity.json) remain separate evidence.
They must not be presented as measurements of the final helper binary.

## Coverage limits and retained failures

Mesh/triangle counts, geometry fingerprints, AABB bits, volume bits and spatial
query result multisets match their controls. Spatial result order may differ
with worker completion order. Those queries cover flat spatial publication,
not every instanced-only entity or the lazy renderer CPU BVH. Full real-model
vertex-buffer and closure equivalence are not claimed.

Raw timing logs retain a pre-load analytics resource error; timing runs do not
claim completely clean consoles. Functional qualification explicitly emulates
only the local Vercel analytics endpoint, preserving application assets and
error assertions. Initial missing-sampler, cache-ineligible fixture and browser
adapter failures are retained. CSG/Haus framed-picking failures reproduce on
base; the documented Tekla/Haus federation/cache exercises pass in both browsers.
This establishes no introduced failure in those checks, not a fix for the
pre-existing framing case. Memory sampling extends through cache settlement.

## Reproduction and private evidence

Original fixtures, screenshots, console logs, full spatial rows and frozen
builds are held in the private archive `ifc-cold-load-t3-2026-09-06`. Public
projections retain source-result hashes and sanitized model labels. The archive
contains source snapshots, build logs, runners and projection scripts; browser
runs use the previously reviewed local `bvh-acceptance/chrome.mjs` harness.

After restoring variants, force source mtimes forward or use a fresh build
output directory. Verify actual Rust recompilation as well as bundled hashes.
A copied provenance manifest does not prove compiler inputs.
