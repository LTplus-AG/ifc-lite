<!-- SPDX-License-Identifier: MPL-2.0 -->
# NVIDIA SMLib replacement evaluation

**Verdict: pursue one retained-geometry platform with complementary engines.**
Preserve the exact Rust kernel and its guarantees; add SMLib for curved BRep
modeling. The [implementation design](implementation-design.md) details shared
semantics, explicit evaluation contracts, native/browser execution and no-loss
qualification. The [charter](platform-replacement.md) defines the whole-platform
scope. This supersedes the earlier proposal to remove the exact kernel.

The kernel builds for native Linux and wasm32 without upstream source patches. The
same ten analytic-volume / BRep-manifold / tessellation-topology cases pass
on native and Node WASM. Two browser workers each repeat the ten cases
three times successfully, without cross-origin isolation or SharedArrayBuffer.
This establishes browser feasibility for the exercised operations, not full
IFC coverage, native concurrency safety, or a load-time performance win.

Upstream source and toolchain pins are in [upstream.json](upstream.json).
The [evidence](evidence/) records the independent native/WASM/browser primitive feasibility runs.
Those experiments changed no production geometry or reference pins. Subsequent
implementation is tracked in the [foundation status](../../docs/architecture/geometry-platform-foundation.md),
with separate receipts; these original results are not evidence of a completed migration.

## What ran

- Official upstream release build, including Python and USD integration.
- A minimal standalone build of SMLib + SM_API, excluding OpenUSD, Python,
  TBB, threading and global-cache features. Debug/graphics code is disabled
  with upstream-supported definitions. `CMakeLists.txt` preserves the two
  projects' different `StdAfx.h` include orders.
- Identical C++ invariants: box, rectangular opening, circular through-hole,
  overlapping openings, disjoint subtraction, union, intersection, a cylinder
  converted to NURBS before subtraction, survey-coordinate opening, thin wall.
  Volume tolerance is `max(1e-7, expected * 1e-5)`; curves use an absolute
  chord tolerance and angular controls. Tessellation is strict: no partial
  output, no failed faces, no boundary or spine edges. This is not an
  independent mesh-volume or surface-deviation proof.

## Replacement scope and qualification

See [the platform replacement charter](platform-replacement.md) for the target
architecture, deletion map, runtime design, USD/IFCX contract and milestones.
Standalone family-by-family production adapters and universal SMLib replacement
are both superseded by shared orchestration with explicit responsibilities for
the exact and BRep engines. Existing guarantees and capabilities must survive.

The retained scope contains independent primitive/core feasibility evidence only.
The artifact provenance record is explicitly scoped to those original runs;
removed interchange experiments supply no capability or correctness claims here.
Native/browser packaging, native worker isolation, direct IFC construction, face provenance, tessellation quality,
full-corpus fidelity and end-to-end performance remain qualification work.
No production crate, schema contract or runtime has been replaced by this probe.

## Reproduce

Run from the IFC-Lite root. Keep all upstream checkouts and builds outside
the repository. Python 3.12, a C++17 compiler, Git, make and Node are needed.

```bash
git clone https://github.com/NVIDIA-Omniverse/usd-brep.git /tmp/smlib-upstream
git -C /tmp/smlib-upstream checkout c9c5979f04cea8c38213004d4f04df0dcfb40d05
python3 -m venv /tmp/smlib-venv
/tmp/smlib-venv/bin/pip install -r tools/smlib-evaluation/requirements.txt

/tmp/smlib-venv/bin/cmake -S tools/smlib-evaluation -B /tmp/smlib-native \
  -G Ninja -DCMAKE_MAKE_PROGRAM=/tmp/smlib-venv/bin/ninja \
  -DCMAKE_BUILD_TYPE=Release -DSMLIB_SOURCE=/tmp/smlib-upstream
/tmp/smlib-venv/bin/cmake --build /tmp/smlib-native -j 6
/tmp/smlib-native/smlib_probe
```

For WASM, install/activate Emscripten 4.0.15 using its `emsdk`, then:

```bash
source /path/to/emsdk/emsdk_env.sh
PATH=/tmp/smlib-venv/bin:$PATH emcmake cmake \
  -S tools/smlib-evaluation -B /tmp/smlib-wasm -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DSMLIB_SOURCE=/tmp/smlib-upstream
/tmp/smlib-venv/bin/cmake --build /tmp/smlib-wasm -j 6
node tools/smlib-evaluation/probe.mjs /tmp/smlib-wasm/smlib_probe.mjs
cp tools/smlib-evaluation/browser.html tools/smlib-evaluation/browser-worker.mjs /tmp/smlib-wasm/
python3 -m http.server 8765 --bind 127.0.0.1 --directory /tmp/smlib-wasm
```

Open `http://127.0.0.1:8765/browser.html`; inspect `window.probeResult`.
Both workers terminate after their runs; timeout and error paths fail visibly.

Sources: [NVIDIA architecture](https://github.com/NVIDIA-Omniverse/usd-brep/blob/c9c5979f04cea8c38213004d4f04df0dcfb40d05/.agents/docs/OVERVIEW.md),
[concurrency contract](https://github.com/NVIDIA-Omniverse/usd-brep/blob/c9c5979f04cea8c38213004d4f04df0dcfb40d05/source/SM_API/inc/SmApiGeneral.h),
[known issues](https://github.com/NVIDIA-Omniverse/usd-brep/blob/c9c5979f04cea8c38213004d4f04df0dcfb40d05/KNOWN_ISSUES.md),
[contribution policy](https://github.com/NVIDIA-Omniverse/usd-brep/blob/c9c5979f04cea8c38213004d4f04df0dcfb40d05/CONTRIBUTING.md).
