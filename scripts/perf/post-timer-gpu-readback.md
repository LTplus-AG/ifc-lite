<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Standalone post-timer input readback qualified (#6537)

Ten new functional controls and twelve existing GPU/outer controls pass.
Corrected-source hosted run 37161606551 at `0c2a5e3222ac809d91d924bd9016a1bd9ed2b9f2`
qualifies the standalone four-role GPU input-byte control; independent audit
passes 137 checks. First run 37161075655 remains refused for an invalid negative
descriptor after four byte-matching readbacks. [Durable evidence and replay](evidence/post-timer-gpu-inputs-6537/README.md)
retain both outcomes with their literal sources.
This separate layer builds on the qualified standalone integer readback at
`88e26da7f9bc02eb0add8aabb010af98f380b3c2`. This qualification does not authorize
a viewer caller, comparator integration or eligibility change.

The serializable factory binds original live VERTEX|COPY_DST40 or UNIFORM|COPY_DST72
sources to owned point-list pipelines and an r32uint target. Uniform windows
respect adapter binding-size/offset alignment. Only requested word bytes are
returned; padded pixels/rows are excluded. Atlas22 RGBA8unorm TEXTURE_BINDING
single-mip sources use textureLoad at mip0 into an owned RGBA8unorm target, without blending,
sampling, source COPY_SRC augmentation, write interception or renderer.draw.

Per operation: requested bytes≤32MiB; owned target and padded staging each≤4MiB;
one output≤32MiB (accounted payload at most40MiB additional). This is not physical
peak: source memory, compiler/driver caches and caller-retained outputs are excluded.
At most2048 tiles/diagnostic records and128KiB serialized UTF8 diagnostic bytes,
32 cleanup messages (4096UTF8bytes each) and64 typed control errors
(4096UTF8bytes per type/message text field, not per whole record), explicit prefix refusal;
64 operations per reader, no concurrent read; callers must digest/discard outputs.
Every operation frees its owned stage/texture, checks validation and observed
loss/cleanup errors. It never destroys the supplied device/source. Own-device
loss guards, bounded wall/process cleanup and source/Chrome provenance remain
mandatory in the outer harness; the helper alone is not a completed verdict.

The standalone source control crosses vertex rows and a uniform-binding boundary,
compares raw bytes/hashes to independent seeded sources after CPU-source mutation,
reads varied alpha/R/G/B atlas values and a nontrivial subrectangle, and rejects
changed hash bytes and augmented usages. JS tests state range coverage, pitch,
alignment, adapter and allocation-refusal invariants; they are not GPU mocks.

No timer/comparator, renderer or authored-text guard is changed. Multi-tile reads
are not atomic snapshots. Future callers must establish stable complete annotation
parsing, glyph/atlas/frame readiness and pre/post revision/census identity separately.
Input-byte readback does not prove draw bindings, IFC completeness or rendered pixels,
and supplies no performance verdict. Strict late-write policy remains unimplemented.

## Qualified standalone named hosted adapter

`Benchmark` mode `post-timer-inputs-v1` selects the specialized reusable GPU
workflow. Conflicting specialized inputs refuse; old pixel/six-role defaults
and their interpretation remain unchanged. New `post-timer-gpu-child.mjs`
launches only the corrected Chrome profile; `post-timer-gpu-run.mjs` reuses the
qualified `runGpuChild` ownership/log-drain/cleanup authority and freezes exact
child/outer source inventories. The new independent four-role semantic audit
reconstructs word and RGBA sources, never importing the reader/planner or trusting
its declared bytes/hashes. It validates complete ranges/rows/binding limits,
actual diagnostics, source/Chrome identity, post-close events and owned cleanup.
The corrected-source hosted four-role control passed. No old six-role verdict
is reused. Negative resources use legal augmented usages44/23, with observed
descriptors required by the audit; uncaptured GPU errors remain fatal and retain
their class and message. The failed predecessor used illegal MAP_READ|VERTEX41;
its source/byte/cleanup audit is diagnostic evidence, not an accepted control.
