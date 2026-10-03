<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Symbolic upload recorder prototype (#6537)

This isolated diagnostic harness is not invoked by the comparator. It does not
remove the authored-text refusal, change production sources, alter GPU usage
flags, or qualify any previous run. The standalone hosted buffer-input control
is qualified at source `88e26da7f9bc02eb0add8aabb010af98f380b3c2`; renderer/IFC,
atlas texels, pixels and performance remain unqualified.

`installSymbolicUploadRecorder` is a self-contained plain-JavaScript callback
for prospective installation before application scripts initialize WebGPU. It
preserves native receivers, return values, arguments and thrown exceptions.
Only six exact symbolic buffer labels retain shadows. Creation, native writes,
overlapping updates and destruction are tracked by buffer/device/queue identity;
freeze authorizes the exact live renderer pipeline pointers, counts, strides and
canonical 160-byte fill-camera allocations.
The bounded source copy occurs before delegation, preventing later source
mutation from changing captured bytes. Shared buffers, mapped creation,
unknown labels/shapes, missing byte coverage, unowned buffers and native-call
rejections refuse qualification. Original GPU calls continue on cancellation or
observer refusal. The observer does not prove successful asynchronous GPU writes:
canonical validation/device-loss/error guards remain mandatory.

Default bounds are 1,024 total observed buffer creations, 32 MiB live shadow
bytes, 10,000 symbolic writes, and 64 atlas copies. Byte coverage costs another
32 MiB at the maximum; post-timer cloning can temporarily add 32 MiB, plus one
bounded write-range copy. Retired buffers release their arrays but retain bounded
identity records. Freeze is single-use, releases shadow arrays after cloning and
rejects later symbolic writes/creation; consumers must check `status()` again
before acceptance. Normal teardown destruction does not enter the frozen copy.
`dispose()` restores methods only if they still belong to this observer.

Atlas observation records texture/source/queue pointers and canonical copy
parameters. Freeze demands the live source canvas and matching current/uploaded
atlas version. **No canvas pixels, GPU texels, or texture content hash are
captured.** GPU conversion/premultiplication and rendered-pixel identity remain
outside this witness. The prototype also does not prove draw binding/order or
complete authored-channel-to-overlay coverage. Empty uploads cannot establish
that authored IFC text was rendered. Those predicates require separate design
and qualification before any eligibility guard changes.

Initialized empty text has owned corner/camera allocations even with zero
glyphs. Freeze records those as inactive allocation metadata, with observed
coverage and `bytes: null`; it does not pretend the unwritten camera buffer was
uploaded. Positive glyph counts still require complete active-buffer coverage.
Unexpected live instance/RTE buffers at zero glyphs refuse rather than becoming
another exempt channel.

Copying bytes and coverage during loading has nonzero synchronous CPU and memory
cost. Any eventual timed cohort must declare identical instrumentation on both
arms and preserve source/fixture/graphics/worker/resource guards. Hashing belongs
after the frozen timer. An uninstrumented clock cohort is a separate prospective
protocol; old refusals and timings cannot be relabelled or pooled.

The controls execute the actual serialized recorder in an isolated JavaScript
realm against an independent functional destination-memory GPU fixture. They
check typed subview/element offsets, ArrayBuffer/DataView byte offsets, ordered
overwrites, source mutation before/after native delegation, original exception
identity, ownership/coverage refusal, replacement/destruction, cancellation,
bounds, atlas versions and post-freeze mutation. They are protocol invariants,
not real browser/GPU qualification. The existing recorder deliberately refuses
COPY_SRC source usage, including test buffers: adding that flag cannot silently
reuse its default schema. The preferred actual-GPU control keeps source buffer
usages at 40 (VERTEX|COPY_DST) and 72 (UNIFORM|COPY_DST). Read vertex words through
a `uint32` vertex attribute with four-byte stride into a flat `u32` fragment
output, one point/pixel into an `r32uint` target. Read uniform words through
`array<vec4<u32>>` respecting uniform alignment, emitting one word per pixel.
Only the control's target texture and staging buffer need COPY_SRC/MAP_READ;
copy rows with 256-byte pitch and compare each resulting u32 byte representation
to the captured bytes. This is a test-only shader/readback path, not the viewer's
symbolic shaders or pixel fidelity. If platform limits prevent that control, a
separately named test-only usage schema would need explicit review and cannot
qualify benchmark-default usage. Mutation controls should corrupt one captured byte,
offset-unit handling, or retirement authorization and produce actual failures.

## Prospective frame continuation policy (not implemented)

Current default behavior refuses every symbolic write after freeze. The normal
renderer rewrites text camera uniforms/RTE deltas and fill camera uniforms on
every requested frame, even with an unchanged camera. A frame delivered while
post-timer hashing runs can therefore refuse this strict prototype.

A separately reviewed prospective policy could retain the frozen active bytes
by buffer/queue identity and compare each bounded late-write range to those
bytes, forwarding the original call unchanged. Only identical writes to the
camera/RTE labels would be eligible continuations, with bounded count/bytes and
the original native rejection/error guards. Any changed byte, other-label write,
buffer/texture creation, atlas update, or pre-close destruction would refuse.
This rejects late annotation parsing even if some resulting bytes repeat;
creation/count/atlas/model/geometry settlement must also remain stable across
hashing. Owner census and a final status check are still required. A separate
explicit teardown phase may allow owned destruction only after verdict freeze;
neither destruction nor new data may alter the retained frame witness. This
policy would observe an immutable frame-input boundary, not stop RAF, force a
frame, suppress actual app work or establish GPU completion. No such continuation
is accepted by the current implementation or existing comparator.

## Qualified standalone hosted GPU control

`symbolic-upload-gpu-page.mjs` implements the described real GPU shader/readback
path for all six labels. It checks raw GPU bytes against the recorder after
typed subview, ArrayBuffer/DataView range writes, overlapping updates, immediate
source mutation and replacement. A one-byte changed expectation must fail the
same comparator. Functional controls also inject a copy fault into the observer
shadow while excluding the independent native destination, proving that the
destination-memory oracle detects corrupted recorder bytes. A second actual-device case creates initialized empty text
buffers, requiring inactive allocation metadata without invented upload bytes.
Source buffer usage remains 40/72. The shaders emit raw u32 words to an r32uint
render target, preserving raw float encodings including sign/NaN payload bits.
No production symbolic shader, app pipeline or renderer state is exercised.

`symbolic-upload-gpu-control.mjs` is the registered standalone child entry for a
fresh Linux hosted Chrome. It uses the existing fixed graphics profile, pins
listed source/lock hashes, records ownership-fenced Chrome argv/executable hash,
retains bounded page/GPU events and closes its owned browser/server with a
30-second cleanup budget. Native GPU validation errors, device loss, interruption,
crash, event-prefix exhaustion or cleanup failure refuse. Every recorder disposal result is checked; conflicts or cleanup throws refuse
and are recorded. Shader compilation messages retain type and source position,
with explicit refusal if the bounded diagnostic prefix would truncate. Intentional
device destruction is explicit and distinct from an observed unexpected loss;
cleanup status records success only when cleanup operations succeed. Original output
files are preserved by create_new refusal. It requires `CI=true DEBUG=pw:browser`.

This entry requires the shared outer owned-process graphics runner to
capture bounded stdout/stderr, apply Chrome/Dawn backend-error checks, enforce a
finite child wall bound (at least the declared operation/cleanup budgets), and
qualify final process/log cleanup. Its success status is deliberately
`observed-pending-outer-hosted-qualification`, not a completed hosted verdict.
The initial source-only proposal was unregistered and its GPU controls were
UNRUN. Hosted run [37157226416](https://github.com/LTplus-AG/ifc-lite/actions/runs/37157226416)
subsequently completed through the registered outer runner. Its independent
audit passed all 73 checks, including real shader compilation and readback.
[Durable raw evidence and replay](evidence/symbolic-upload-gpu-6537/README.md)
retain the exact source pin and original proposal/qualification receipts.
The child is still not imported by the comparator.
Atlas pointer/version checks do not verify canvas/GPU texture bytes, authored
annotation extraction, glyph packing, parse completeness, draw bindings or
rendered pixels. Those gaps still block replacing the existing text guard.

## Hosted integration and qualified scope

The `benchmark.yml` dispatch mode `symbolic-upload` reaches the existing reusable
GPU workflow with `symbolic_only: true`; default GPU mode retains both pixel
profiles. `gpu-outer.mjs` shares the existing detached-child PID/start/group,
raw-log limit/drain and cleanup policy. The symbolic child uses only the corrected
fixed profile and preserves its original pending receipt separately. The outer
runner certifies six exact readbacks/negative controls, empty allocations,
compilation/restoration/cleanup/loss receipts, actual Chrome identity, full raw
log drain and final listed source/Node hashes. No IFC/model/pixels/performance
verdict or comparator integration is present. The registered hosted execution
qualifies only this standalone buffer-input control; prior UNRUN receipts are
preserved as historical source-proposal evidence.

Future live-buffer reads after the timer could avoid write interception and
recorder overhead; atlas textureLoad/readback may also be possible with existing
usage. Neither mechanism, atlas completeness nor authored-text readiness is
implemented or qualified here. The authored-text refusal stays unchanged.

Hosted semantic qualification requires the exact eight child inputs, not an inventory
count. Six varied independently seeded destination plans must match both actual
GPU readback and recorder shadow; literal partial-write payloads and the before/after
source mutation are retained. Equal all-zero shadows/readbacks refuse, including
when their declared plan is also zero. These are control inputs, not IFC fidelity.

The hosted adapter reuses `PROFILES[1]` from the frozen GPU-control module; the
prototype's newer `GRAPHICS_PROFILE` export is absent from this exact base. No
profile flags, default original/corrected schedule, or pixel controls change.
