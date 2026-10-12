<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Worker sender accounting (#6993)

`fzk-functional.json` records actual Chromium worker/viewer qualification with
the public AC20-FZK-Haus fixture. The fixture fingerprint matches the model
manifest. The WASM runtime comes from the green Test run for the exact source
base recorded in the receipt; its digest is retained. No Rust source changed.

The canonical loader completed with four geometry workers, the hierarchy and
model visible, and the parser and prepass phases published. Each worker's
`msg.worker.out.transferBytes` is measured from its own transfer lists, rather
than inferred from received ArrayBuffers. Prepass output in this load is
cloned, so its sender reports no transfers despite the host receiving buffers.
Parser output contains both cloned and transferred buffers.

A separate actual parser worker parsed the same file without an entity-index
handoff. Its WASM ingress equals the file length, with one full scan, and its
sender message total includes the terminal message. The canonical loader's
successful handoff performs no parser WASM scan. These are real WASM runs,
independent of the synthetic worker endpoint tests.

The geometry fingerprint hashes positions, normals and indices per mesh,
plus express/item IDs, colors, origins and transforms, then sorts the mesh
records before hashing. It is independent of streaming arrival order. This
receipt records candidate geometry; a base comparison is not yet recorded.

This is functional evidence from the development viewer. Its timings, GPU
device count and upload counts are not accepted benchmark measurements.
Repeatable GPU upload counts remain pending under #6993; this slice does not
close that issue or claim a throughput improvement.

`inverse.json` binds the six runtime owners to their source digests. All ten
focused cases pass before and after restoring those owners. Replacing all six
owners with the recorded base produces seven genuine assertions and three
passing controls, without loader or type errors. This demonstrates behavior
coverage rather than the presence of particular source text.

The parser worker regression now also runs the actual WASM engine without a
handoff. Removing only the parser's meter attachment yields one genuine byte
assertion with four passing controls; restoring it returns five passes. The
successful handoff's zero-ingress check is paired with that positive control.
