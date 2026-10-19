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

This evidence covers the named native output. Browser output identity, other
changed hosts, the alternate-triangulation census, engine size and current-pair
performance remain separate qualification requirements. It grants no stack merge
or runtime approval. See the PR for current qualification status.
