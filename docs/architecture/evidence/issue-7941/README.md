# Exact rectangular opening unions (#7941)

The approximate box merge could fill authored gaps and steps smaller than its
centimetre candidate-search tolerance. The merge now requires exact coincidence
on two axes and actual contact on the remaining axis. Exact adjacent tiling still
coalesces; millimetre gaps and steps remain separate.

`qualification.json` records the completed native whole-wall finite-surface
comparison for NUS host 143268, using all seven original openings and every
emitted material-layer mesh. All 2,016 candidate triangles and all 124 independent
IfcOpenShell reference triangles participate. Both directed coverage checks pass
across all 22 plane groups at the unchanged 100 µm tolerance. Bounded progress
partitions reuse hash-bound exact-checker receipts; sampling and floating-area
checks cannot approve coverage. The full receipt and donor records are retained
under the recorded hashes.

The real source-built WASM browser-batch API was also executed in Node.
All 16 selected source/cut cases match their native filled triangle multisets
exactly in binary64 world coordinates, preserving every indexed triangle
occurrence and multiplicity. `native-wasm-identity.json` records that join,
including the unmatched-edge diagnostics: filled-surface identity does not
establish topology or winding. This transfers the named whole-wall surface
proof to the identical WASM geometry output. It is not a browser-render test.
The separate MiniBIM battery passes all 27 cases with zero unmatched or
collapsed triangles on the kernel snap grid.

The linked determinism workflow passes both arm64 and wasm32 jobs for the
same geometry source. Other changed hosts, the alternate-triangulation census,
actual browser rendering, engine size and current-pair performance remain
separate qualification requirements. These receipts grant no stack merge or
runtime approval. See the PR for current qualification status.
