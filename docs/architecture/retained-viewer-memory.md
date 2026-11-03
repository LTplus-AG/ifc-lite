<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Retained viewer: source size and memory (#7955)

The viewer used to refuse retained loads of sources over 256 MiB. That cap was
an orchestrator default set in M2 "until M2-D measures"; it was never derived
from a measurement. This page records what actually limits a retained load in
the browser and the policy that replaced the cap.

## What bounds a retained load

- **One wasm32 linear memory.** The retained engine (`pkg-retained`) runs in one
  module Worker with one `WebAssembly.Memory`, which can address 4 GiB and never
  shrinks. Its heap holds the source, the entity index and scan products, the
  run's plan, and the per-product state the run keeps.
- **The source is one allocation.** `RetainedModelSession.run` takes the source
  as a Rust `Vec<u8>`: wasm-bindgen copies the bytes into linear memory, then
  `SourceBundle` owns them. No wasm32 allocation may exceed `isize::MAX`
  (2^31 - 1 bytes), so a source of 2 GiB (2^31 bytes) or more can never start.
  In the built engine an allocation of 2^31 - 1 bytes succeeds and one of 2^31
  aborts without growing memory. `RETAINED_MAX_SOURCE_BYTES` is 2^31 - 1,
  checked before any byte is read.
- **No streaming.** The session needs the whole source before it plans; there
  is no windowed parse on the retained path.
- **Copies outside WASM.** The main thread keeps its source buffer (the exact
  metadata parse uses it too). The client clones the bytes into the host Worker,
  never transfers them; the Worker drops its copy once wasm-bindgen has copied
  it into linear memory. Chrome refused to clone a 2.1 GiB `ArrayBuffer`
  (`DataCloneError: Data cannot be cloned, out of memory`).
- **SMLib is not size-bound.** The nested SMLib Worker gets bounded frames per
  product (12-4096 B, at most 8 batches pending). Its native worker's peak RSS
  was the same 311-312 MiB on the committed corpus and on Holter Tower.

The exact kernel has the same wasm32 ceiling: its streaming pre-pass also
copies the whole source into linear memory, and its traps from about 1.6 GB
are reworded by `packages/geometry/src/huge-file-error.ts`. It has no byte cap
either.

## Measured

Untimed observations on 2026-11-02, not benchmark evidence: Chrome 1248
(headless, software WebGPU) on Pop, the real `RetainedModelSession` from
`origin/main` b1d9b94bac in a module Worker fed by a structured clone, as the
viewer does. The released 27.2.0 engine gave the same heap figures. "Heap" is
the retained engine's linear memory (`get_memory().buffer.byteLength`), observed
at the start event, at each product event and at the end. "Index only" passes
an empty `ids` list, so the source copy, entity index, candidate scan and frame
are paid but no product runs. Holter xN repeats Holter Tower's DATA section N
times with renumbered ids; "dense" holds only `IFCCARTESIANPOINT` records. Both
are synthetic size probes, not realistic models.

| source | size | run | heap at start | heap max | heap / source |
|---|---:|---|---:|---:|---:|
| Holter Tower | 169 MiB | index only | 252 MiB | 292 MiB | 1.73 |
| Holter Tower | 169 MiB | full: 61,201 candidates, 54,536 published | 252 MiB | 470 MiB | 2.78 |
| ArchiCAD model (#8042 fixture) | 327 MiB | index only | 451 MiB | 464 MiB | 1.42 |
| ArchiCAD model (#8042 fixture) | 327 MiB | full: 16,763 candidates, 2,591 published | 451 MiB | 493 MiB | 1.51 |
| Holter x4 | 705 MiB | index only | 1,215 MiB | 1,378 MiB | 1.96 |
| Holter x8 | 1,418 MiB | index only | 2,424 MiB | 2,765 MiB | 1.95 |
| Holter x10 | 1,775 MiB | index only | 2,880 MiB | 3,277 MiB | 1.85 |
| Holter x11 | 1,960 MiB | index only | 3,065 MiB | 3,541 MiB | 1.81 |
| Holter x11 | 1,960 MiB | full, stopped at 88,859 of 673,211 products | 3,065 MiB | 3,877 MiB | 1.98 |
| dense | 951 MiB | index only | 1,377 MiB | 1,377 MiB | 1.45 |
| dense | 1,428 MiB | index only | 2,270 MiB | 2,270 MiB | 1.59 |
| dense | 2,038 MiB | index only | 2,880 MiB | 2,880 MiB | 1.41 |
| Holter x12 | 2,145 MiB | — | — | — | clone refused |

The first products add a step of about 180 MiB (Holter: 292 to 470 MiB; x11:
3,541 to 3,727 MiB), and then the heap grows by roughly 2 KiB per published
product (x11: 3,727 to 3,877 MiB over 88,859 products). At that rate the x11
run would have run out of memory near 200,000 products. Chrome's peak renderer
memory was 1.2 GiB for Holter and 1.7 GiB for the ArchiCAD model.

So the source and its index take roughly 1.4-2x the source size, and products
add to that as they publish. Whether a model of 1-2 GiB fits depends on its
product count and geometry, not on its byte size alone, so no byte cap below
2 GiB is principled.

A failed allocation in this engine reaches JavaScript as `RuntimeError:
unreachable` with no panic location recorded: allocating 256 MiB blocks
through the engine's own `malloc` export failed after 15 blocks, at a
3,850 MiB heap.

## Policy

- A retained load refuses before any work only what cannot start at all: a
  federated add, a non-STEP source, or a source of 2 GiB or more. Retry loads it
  with the exact kernel.
- Below that, the engine's own allocations decide. A failed allocation aborts
  the WASM instance with the abort trap (`RuntimeError: unreachable`). A Rust
  panic ends in the same trap, but only a panic runs the engine's panic hook,
  which records its location. So the host Worker reports `out_of_memory` for an
  abort trap with no panic recorded since the run began, and for an error that
  names an allocation failure, such as a refused clone. Every other trap
  (out-of-bounds access, a bad indirect call) stays a crash.
- The run is a wasm-bindgen future polled from microtasks, so a trap partway
  through does not reject the awaited run: it reaches the Worker as its own
  uncaught error or rejection. The Worker handles those while a run is active,
  classifies them the same way and cancels the event, so the client gets one
  typed error instead of an anonymous crash.
- An out-of-memory load ends with "did not fit in the retained engine's
  memory", and Retry switches that load to the exact kernel. The trapped Worker
  is terminated, which also releases its heap. There is never an automatic
  exact fallback.
- Every other host failure (startup, engine missing, a genuine panic, another
  trap) is worded by the host: "The retained engine stopped while processing
  ...: <reason>". It keeps the load's own Retry, which runs the retained kernel
  again, and says so; the panel offers the exact reload. Analytics classify
  these by their typed code. A stall is not a host error: it keeps the
  loader's stall wording and Retry, classified as a stalled stream.
- A model over the old cap can refuse tens of thousands of products. The
  viewport chip re-renders only when the summary changes (at most once a
  second), the panel builds its table only while it is open, and the table
  renders at most 500 rows; the code filter and its counts reach the rest.
- A separate 256 MiB limit remains in the geometry router's annotation-fill
  acceptance: its style lookup (`rust/core/src/decoder/styled_items.rs`)
  refuses sources over 256 MiB, so on such a source every
  `IfcAnnotationFillArea` is refused as an unsupported item, styled or not.
  This change does not touch it.
