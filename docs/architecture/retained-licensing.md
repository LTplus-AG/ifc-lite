# Retained artifact licensing review inputs

Refs #7955. Prepared against main `853d7c9781`, 2026-10-29. **Review inputs,
not a licence-compatibility decision or distribution approval.** Exact remains
the default; this change changes packaging, not geometry execution.

## Evidence and scope

The [component table](../../licenses/retained/README.md) lists every collected
component and links its preserved texts. The machine-readable [inventory](../../licenses/retained/manifest.json) records
component name, version, licence declaration, source, artifact scope and the
SHA-256 of every preserved notice. The [generated notice bundle](../../licenses/retained/THIRD_PARTY_NOTICES.txt)
contains the actual text, deduplicated by content hash. Immutable upstream texts
are under `licenses/retained/texts/`; they are not paraphrased licence templates.
`Cargo.lock`, manifests, toolchain and adapter inputs are hash-bound. CI fails on
input changes, missing texts, text corruption or generated-output drift.

This is a **conservative source/build inventory**, not proof of the exact code
remaining after link-time dead stripping. Cargo metadata was resolved with
`--locked --filter-platform wasm32-unknown-unknown --features ifc-lite-wasm/retained-browser`;
only non-dev edges reachable from `ifc-lite-wasm` were followed. Workspace feature
unification can add components; proc macros/build tools are retained conservatively.
The Rust standard-library copyright inventory includes its own nested components.
The exact final native linker dependencies are platform-specific and remain a
release input to collect. No claim of a complete final-linked-artifact audit is made.

## Kernel, runtime and artifact mapping

| Component | Pin | Actual licence evidence | Artifact and delivery |
|---|---|---|---|
| NVIDIA usd-brep SMLib + SM_API | `c9c5979f04cea8c38213004d4f04df0dcfb40d05` | Root `LICENSE`, `THIRD_PARTY_NOTICES.md`; source SPDX Apache-2.0 | Native worker, SMLib Emscripten module; original SDK notices plus generated bundle |
| Emscripten runtime and Node-derived path code | 4.0.15; emsdk `3b3963d86a5c97adaf6eaa845cdfe0b811c2f960` | Actual installed Emscripten `LICENSE`: MIT/NCSA; embedded Node MIT attribution | SMLib wasm/JS and staged CLI engine; generated bundle |
| dlmalloc | 2.8.6 bundled with Emscripten 4.0.15 | Actual source licence/version header: public-domain/CC0 dedication, with full source-file hash | Default SMLib WASM allocator; generated bundle |
| musl libc | bundled with Emscripten 4.0.15 | `system/lib/libc/musl/COPYRIGHT`: MIT and individual BSD-style portions | SMLib WASM; complete copyright text retained |
| libc++, libc++abi, libunwind, compiler-rt, llvm-libc | bundled with Emscripten 4.0.15 | Each `system/lib/*/LICENSE.TXT`: Apache-2.0 with LLVM exceptions and legacy portions as printed | Conservative SMLib WASM runtime inventory; final link map determines used portions |
| wasm-bindgen runtime/glue + macro/shared crates | 0.2.126 | Actual Cargo archives' `LICENSE-MIT` and `LICENSE-APACHE` | `pkg-retained` JS/WASM; generated bundle |
| js-sys / web-sys / wasm-bindgen-futures | 0.3.103 / 0.3.103 / 0.4.76 | Actual archives' MIT/Apache texts | `pkg-retained`; generated bundle |
| Rust standard library | nightly-2025-11-15, exact rustc identity in inventory | Installed `COPYRIGHT-library.html` and complete `licenses/` directory | `pkg-retained`; complete upstream library inventory retained |
| Rust transitive packages | Exact name/version rows in inventory | Cargo archive texts, including embedded subordinate notices | `pkg-retained`, conservative workspace-unified closure; no SDK inside source crates |
| Native C/C++ runtime | Final compiler/OS pin **unresolved** | Must inspect final `DT_NEEDED`/link map and compiler runtime licences | Native worker; collect before distributing per-platform binaries |
| IFC-Lite | Release source commit | Repository MPL-2.0 LICENSE and source file headers | Source crates ship source; linked distributions need matching source availability and MPL notice |

The adapter CMake target compiles only `source/SMLib/src/*.cpp` and
`source/SM_API/src/*.cpp` plus our adapter. It does not invoke upstream packman,
link OpenUSD or build the Python/GUI plugins. The supplied SDK checkout contains
root notices, not the separately downloaded `PACKAGE-LICENSES/OpenUSD` bundle.
The upstream notice lists OpenUSD 25.11, oneTBB, hwloc 2.9.3, MaterialX 1.39.3,
Python, pybind11, NVIDIA packages, proposal materials and GUI dependencies.
Those entries describe upstream's wider product, not this adapter's link graph.
They are preserved verbatim for traceability; an upstream summary with abbreviated
OpenUSD licence text must never substitute for its complete licence if OpenUSD
is added to a future artifact. `proposals/NOTICE` belongs to unshipped proposals.

`ifc-lite-geometry-runtime` now has an explicit source-only Cargo include list.
It remains outside the automatic `CRATES` release list until manual bootstrap;
explicit package qualification still includes it.
Its retained feature forwards to `ifc-lite-geometry/retained-runtime`. Processing's
current retained feature also forwards directly to geometry; it does **not** have
an optional runtime dependency. The unpublished `ifc-lite-retained-native` harness
has the path dependency on runtime. No fictitious optional edge was added merely
to reproduce an older branch's dependency graph. Package dry-runs exercise both
runtime feature-off and feature-on graphs.

## Obligations for the human review

These are review prompts grounded in the preserved texts, not compatibility rulings:

* Apache-2.0 section 4: retain licence, applicable notices and attribution;
  identify modified upstream files if any. The pinned kernel/API are clean.
* MIT/ISC/BSD/Zlib/Unicode: preserve each applicable copyright, permission,
  disclaimer and attribution text; do not infer one generic MIT notice covers
  all copyright holders. The bundle includes the actual per-component texts.
* LLVM runtime exceptions and legacy clauses: determine which apply to the
  linked runtime. Both full current and legacy texts are supplied for review.
* MPL-2.0: make the matching covered source available and tell executable
  recipients how to obtain it. Source archives already include covered source;
  publishing a binary needs a durable exact release-source link, not just main.
* Native libc/libstdc++/libgcc: decide treatment of system dependencies versus
  bundled/static runtime portions, including LGPL/GPL runtime exceptions and
  any source/relink obligations. No blanket compatibility conclusion is inferred.

## What the packaging paths deliver

* Browser `/smlib/`: original SDK `LICENSE` and `THIRD_PARTY_NOTICES.md`, plus
  `IFC_LITE_THIRD_PARTY_NOTICES.txt` and `IFC_LITE_LICENSE.txt`, all included in
  the asset hash manifest.
* `pkg-retained`: opt-in build copies `THIRD_PARTY_NOTICES.txt` and the MPL
  `IFC_LITE_LICENSE.txt` beside JS/WASM.
* Staged CLI engine: complete bundle at root and in `/smlib/`, original SDK
  notices under `LICENSES/SMLib`, IFC-Lite MPL under `LICENSES/ifc-lite`, and
  supplied additional runtime notices under `LICENSES/toolchain`.
* Native CMake install: worker under `bin/`; notices under
  `share/licenses/ifclite-smlib/`. This is staging support, not a release job.
* npm `@ifc-lite/wasm` and `@ifc-lite/cli`: full notice bundle included via
  `files`. Retained SDK/runtime binaries remain excluded; WASM ships the loader
  and retained declarations only. Do not describe `npm install` as installation
  of the retained engine.

## Why the default npm package includes the notice file

`@ifc-lite/wasm` ships the default Rust WASM/wasm-bindgen runtime as well as
`retained.js`, `retained.d.ts` and `pkg-retained/ifc-lite.d.ts`. Its explicit
`files` list excludes retained JS/WASM implementation files and the SMLib SDK.
The loader and declarations alone do **not** establish a requirement to ship
NVIDIA/Emscripten notices. Many Rust and wasm-bindgen notices in the generated
inventory do apply to the default compiled runtime. We retain one conservative
notice superset for this package and the separately staged retained engine,
avoiding a second, independently maintained attribution list. Human review
still determines which notices are legally required for the final artifact.

The file is standalone npm archive content, not imported JavaScript, a runtime
fetch, or input to WASM compilation. It increases npm archive contents (the
notice is about 955 KB uncompressed); it does not enter the default viewer or
WASM code bundle. Default Rust source, dependency lock and compiler flags are
unchanged by this branch. The only `build-wasm.sh` changes copy licence texts
inside `BUILD_RETAINED=1`. This establishes unchanged compilation inputs, **not
an observed base-versus-branch WASM SHA match**; no paired default build has yet
been recorded. The complete npm tarball is intentionally not byte-identical,
because it now includes this notice file.

## Open release decisions and evidence gaps

1. Human reviewer must decide final-linked-artifact compatibility and approve
   redistribution/hosting on each platform. A complete source notice inventory
   alone does not authorize distribution.
2. `wasm_sync` 0.1.2 declares MIT OR Apache-2.0 but its archive and pinned upstream
   tree `cc027b3b27c2e24e3cd5c7a6cc63306eff724af5` contain no LICENSE/NOTICE files.
   Obtain authoritative permission/attribution text; do not invent it. `i_key_sort`
   0.11.0 and `i_overlay` 8.1.2 also omit texts from their archives; exact VCS-pinned
   upstream texts were recovered and recorded in `supplemental.json`.
3. Collect the **actual release** native link map, `readelf -d` (Linux), `otool -L`
   (macOS) or import table (Windows), compiler version and any bundled runtime
   notices. `retained-native-link-inventory.mjs` is wired into the Linux native
   CI lane to collect exact binary/library hashes, compiler and dpkg versions,
   installed copyright files and referenced common licences; its report is
   uploaded with the existing evidence. CI also verifies CMake-installed notices.
   This newly wired collector is not a completed release-artifact audit.
4. Bind final JS/WASM/native hashes to their clean source, build toolchain,
   linker inputs and this notice inventory. Existing staging manifests explicitly
   say `buildAttestation: false`; that remains honest and unchanged.
5. Record the exact release source URL and any required source/relink delivery
   mechanism. A human must approve the final source-offer wording.
6. Registry bootstrap and per-crate Trusted Publisher configuration remain
   manual. See [release runbook](../guide/retained-release.md); public lookup
   found runtime absent and the existing core/geometry crates at 25.0.1 while
   this checkout uses 26.0.0. Real dry-run failures must stay visible.

## Regeneration

The refresh resolves the current locked Cargo graph itself (metadata is not a build):

```sh
node scripts/retained-notices.mjs --refresh --sdk /absolute/pinned-usd-brep \
  --emscripten /absolute/emsdk/upstream/emscripten
node scripts/retained-notices.mjs --check
```

Refresh reads actual installed licence files and preserves byte hashes, including
line endings. Review changed pins, missing texts and supplemental sources before
committing. `--write` regenerates outputs from committed inputs; it cannot waive
an input hash mismatch. CI's drift check requires no SDK or network.

Performance verdict: packaging-only; no execution or compiler flags changed.
The build-script additions copy licence texts only inside `BUILD_RETAINED=1`.
Default model-output identity is expected from unchanged code, not measured by
this slice; no end-to-end speed or byte-identity benchmark claim is made.
