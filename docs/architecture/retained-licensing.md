# Retained artifact licensing review inputs

Refs #7955. Release review draft. **Review inputs,
not a licence-compatibility decision or distribution approval.** Not legal advice. Exact remains
the default; this change changes packaging, not geometry execution.

## Evidence and scope

The [component table](https://github.com/LTplus-AG/ifc-lite/blob/main/licenses/retained/README.md) lists every collected
component and links its preserved texts. The machine-readable [inventory](https://github.com/LTplus-AG/ifc-lite/blob/main/licenses/retained/manifest.json) records
component name, version, licence declaration, source, artifact scope and the
SHA-256 of every preserved notice. The [generated notice bundle](https://github.com/LTplus-AG/ifc-lite/blob/main/licenses/retained/THIRD_PARTY_NOTICES.txt)
contains the actual text, deduplicated by content hash. Immutable upstream texts
are under `licenses/retained/texts/`; they are not paraphrased licence templates.
CI compares semantic inputs: external locked package identities/checksums in each
production dependency closure, the SMLib and emsdk pins, Emscripten version, Rust
toolchain channel and supplemental notice records. Workspace versions and unrelated
workflow text are excluded. Preserved notice hashes and generated outputs are checked.
The Apache-2.0 election for `wasm_sync` below closes the missing-text gap.

This is a **conservative source/build inventory**, not proof of the exact code
remaining after link-time dead stripping. The roots are `ifc-lite-wasm` (default
and retained WASM) and `ifc-lite-diff-wasm` (`pkg-diff`, also shipped by npm).
The lockfile walk excludes workspace dev-only edges using the parsed manifests;
optional and target-specific production dependencies and build tools are included
conservatively. Each component records its root scope. Cargo metadata supplies
the actual archive paths during refresh, not during the SDK-free CI check.
The Rust standard-library copyright inventory includes its own nested components.
The exact final native linker dependencies are platform-specific and must be
collected before a future native worker binary release. No claim of a complete final-linked-artifact audit is made.

## Kernel, runtime and artifact mapping

| Component | Pin | Actual licence evidence | Artifact and delivery |
|---|---|---|---|
| NVIDIA usd-brep SMLib + SM_API | `c9c5979f04cea8c38213004d4f04df0dcfb40d05` | Root `LICENSE`, `THIRD_PARTY_NOTICES.md`; source SPDX Apache-2.0 | Native worker, SMLib Emscripten module; original SDK notices plus generated bundle |
| Emscripten runtime and Node-derived path code | 4.0.15; emsdk `3b3963d86a5c97adaf6eaa845cdfe0b811c2f960` | Actual installed Emscripten `LICENSE`: MIT/NCSA; embedded Node MIT attribution | SMLib wasm/JS and staged CLI engine; generated bundle |
| dlmalloc | 2.8.6 bundled with Emscripten 4.0.15 | Actual source licence/version header: public-domain/CC0 dedication, with full source-file hash | Default SMLib WASM allocator; generated bundle |
| musl libc | bundled with Emscripten 4.0.15 | `system/lib/libc/musl/COPYRIGHT`: MIT and individual BSD-style portions | SMLib WASM; complete copyright text retained |
| libc++, libc++abi, libunwind, compiler-rt, llvm-libc | bundled with Emscripten 4.0.15 | Each `system/lib/*/LICENSE.TXT`: Apache-2.0 with LLVM exceptions and legacy portions as printed | Conservative SMLib WASM runtime inventory; final link map determines used portions |
| wasm-bindgen runtime/glue + macro/shared crates | 0.2.126 | Actual Cargo archives' `LICENSE-MIT` and `LICENSE-APACHE` | `pkg`/`pkg-retained`/`pkg-diff` JS/WASM; generated bundle |
| js-sys / web-sys / wasm-bindgen-futures | 0.3.103 / 0.3.103 / 0.4.76 | Actual archives' MIT/Apache texts | `pkg`/`pkg-retained`/`pkg-diff`; generated bundle |
| Rust standard library | nightly-2025-11-15, exact rustc identity in inventory | Installed `COPYRIGHT-library.html` and complete `licenses/` directory | All WASM packages; complete upstream library inventory retained |
| Rust transitive packages | Exact name/version rows in inventory | Cargo archive texts, including embedded subordinate notices | All WASM packages, per-root conservative production closures; no SDK inside source crates |
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

## Distribution scope for this release

* **crates.io:** the eight crates in `scripts/lib/crates-io.mjs` (core, clash,
  geometry, processing, landxml, export, ffi, wasm) and the separately qualified
  geometry-runtime bootstrap candidate are source packages. `cargo package
  --list` is the archive selection check, not a build or publication. Their
  lists contain source, tests/fixtures, documentation and Cargo metadata, no SDK
  or third-party binaries. Each inherits `license-file = "LICENSE"` from the
  workspace, so Cargo includes the repository MPL-2.0 text. Runtime also has an
  explicit source-only `include` list. Even ffi's `cdylib` declaration does not
  put a compiled library in a source archive.
* **npm:** `packages/wasm/package.json#files` includes the retained loader/types,
  default `pkg` and `pkg-diff` JS/WASM, and `THIRD_PARTY_NOTICES.txt`, but excludes
  retained implementation JS/WASM and SMLib. CLI's `files` selects `dist`, README
  and the notice; its generated JS/declarations consume the WASM package rather
  than bundle SMLib. These are loader/client packages, not SDK delivery.
* **Hosted browser retained assets:** separately built `pkg-retained` JS/WASM,
  declarations and snippets, and SMLib's generated wasm/JS and module Workers
  may be served after review, with the notices and MPL text staged alongside as
  described above. `stage-retained-browser-assets.mjs` and
  `stage-cli-retained-engine.mjs` hash-inventory those copies. The viewer Vite
  integration does not copy these into build output and rejects retained Vercel
  builds; this scope does not claim the production viewer currently serves them.
* **Native retained worker binaries are not distributed in this release.** Users
  build from the pinned SDK. CMake install support and native CI evidence are not
  a release channel. `.github/workflows/release.yml` publishes npm and source
  crates; its separate `server-v<version>` release is for server-bin, not the
  retained worker. A future native retained binary release must first complete
  the platform link/runtime audit (item 3).

## Review record

This records evidence and fulfilment mechanisms for the scope above, not a
signature or a blanket conclusion about every possible linked artifact.

| Component | Licence and obligation | How addressed in this scope |
|---|---|---|
| SMLib / SM_API | Apache-2.0 section 4: copy LICENSE, retain applicable notices; identify modified upstream files | Original SDK LICENSE and THIRD_PARTY_NOTICES.md preserved in `/smlib/` and `LICENSES/SMLib/`. Verified local SDK HEAD is `c9c5979f04cea8c38213004d4f04df0dcfb40d05` and `git status --porcelain --untracked-files=all --ignored -- source/SMLib source/SM_API LICENSE THIRD_PARTY_NOTICES.md` is empty. No modifications to those pinned paths; IFC-Lite adapter is separate. CMake and stagers enforce cleanliness, not binary provenance. |
| Emscripten runtime | MIT OR NCSA, including Node MIT attribution: retain permission/copyright/disclaimer texts | Installed 4.0.15 LICENSE preserved whole in generated bundle, including both alternatives and subordinate notices. Compiler tools are not shipped. |
| dlmalloc | Public domain / CC0-1.0 dedication in source | Actual 2.8.6 licence/version header preserved, full source hash recorded; Emscripten modifications covered by its separate licence. |
| musl | MIT and BSD-style portions: retain applicable notices/disclaimers | Complete installed COPYRIGHT preserved in bundle, including individual holders/portions. |
| LLVM runtimes | Apache-2.0 WITH LLVM-exception plus legacy terms: retain texts and applicable attribution | libc++, libc++abi, libunwind, compiler-rt and llvm-libc LICENSE.TXT files preserved; conservative superset avoids discarding legacy notices without link evidence. |
| Rust std and crates | MIT / Apache-2.0 and other per-component terms (including ISC, BSD, Unicode, Zlib, Boost): retain actual applicable texts | Generated inventory and bundle preserve archive texts and Rust COPYRIGHT-library.html plus its licence directory; supplemental pinned texts cover archive omissions. No single generic MIT notice substitutes for component holders. |
| wasm_sync 0.1.2 | MIT OR Apache-2.0; Apache-2.0 elected | `supplemental.json` records the election and attribution: “wasm_sync 0.1.2 (crates.io), licensed under Apache-2.0 by election from MIT OR Apache-2.0”. Canonical [SPDX Apache-2.0 text](https://spdx.org/licenses/Apache-2.0.html) preserved by hash. This supplies section 4(a)'s licence copy; the archive and pinned upstream tree have no NOTICE, so section 4(d) adds no separate NOTICE-copy requirement. No copyright holder is invented. |
| IFC-Lite | MPL-2.0: file-level copyleft, retain notices and make covered source available to executable recipients | Source crates include source and MPL LICENSE. Hosted copies include IFC_LITE_LICENSE.txt and notice with exact release-tag source URL; see source offer below. Combining separate Apache-2.0 and MIT code with MPL files is permitted while respecting each licence; this does not relicense those components. See [MPL FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/) questions 11–12 and MPL section 3.3. |

### Source offer and release owner actions

IFC-Lite covered source is available under MPL-2.0 at
`https://github.com/LTplus-AG/ifc-lite/tree/<tag>`, where `<tag>` is the exact tag
for the distributed release commit. `release.yml` creates the root `v<version>`
tag using `release-tag-commit.mjs`, explicitly resolving the version commit;
Changesets also creates per-package tags. Use the matching root tag, not `main`
or the unrelated `server-v<version>` tag. Verify that it resolves to the source
used to build the supplied assets.

The generated THIRD_PARTY_NOTICES header carries this placeholder. Before
staging a release, the owner fills it in the distributed notice copies (including
copies used by both stagers), then stages/hashes the final files and keeps the
source available at that URL. The repository's template remains reproducible;
`--check` validates that template, not a filled release archive. See the
[hosting guide](../guide/retained-installation.md) for delivery paths.

Remaining for the maintainer: verify the final tag/source and deployed notice
copies, review this record against the actual release scope, and sign below.
No final release archive, deployed host, or future native binary was audited here.
Registry bootstrap/Trusted Publisher settings and actual OIDC publication are
also unverified; they are operational release prerequisites, not inferred from
this licence record.

Approved for the scope above by: ____ (date: ____)

## Why the default npm package includes the notice file

`@ifc-lite/wasm` ships the default Rust WASM/wasm-bindgen runtime as well as
`retained.js`, `retained.d.ts`, `pkg-retained/ifc-lite.d.ts` and the separate
`pkg-diff` runtime. The diff closure includes `ryu-js` 1.0.3, whose actual
Apache-2.0 and Boost Software License 1.0 texts are preserved. Its explicit
`files` list excludes retained JS/WASM implementation files and the SMLib SDK.
Whether the loader and declarations require any NVIDIA/Emscripten notices is
an open point for the human reviewer. Many Rust and wasm-bindgen notices in the generated
inventory do apply to the default compiled runtime. We retain one conservative
notice superset for this package and the separately staged retained engine,
avoiding a second, independently maintained attribution list. Human review
still determines which notices are legally required for the final artifact.

The file is standalone npm archive content, not imported JavaScript, a runtime
fetch, or input to WASM compilation. It increases npm archive contents (the
notice size is reported by the package inventory); it does not enter the default viewer or
WASM code bundle. Default Rust source, dependency lock and compiler flags are
unchanged by this branch. The retained `build-wasm.sh` packaging path copies licence texts
inside `BUILD_RETAINED=1`.

Use `node scripts/retained-default-identity.mjs <base-commit>` in the admitted
release qualification environment to compare canonical builds of default `pkg`
and `pkg-diff` JS, WASM and declaration bytes. Preserve source identities and
per-file SHA-256 results in release evidence. This does not measure the rebuilt
viewer application or model output. The npm tarball intentionally changes when
notice content changes; a runtime byte comparison does not imply tarball identity.

## Open release decisions and evidence gaps

1. **Review record prepared; maintainer signature remains.** See [Review
   record](#review-record) for component obligations and evidence. Final scope,
   release copies and source identity still require the maintainer's check; no
   approval is asserted by this document.
2. **Resolved: wasm_sync text/election.** Apache-2.0 election, exact attribution
   and SPDX text are recorded in `supplemental.json` and generated bundles.
   Its archive and upstream tree `cc027b3b27c2e24e3cd5c7a6cc63306eff724af5`
   have no LICENSE/NOTICE files. Existing VCS-pinned supplements for i_key_sort,
   i_overlay, flatbuffers and valuable remain; r-efi's AUTHORS is preserved.
3. **Out of scope: native link map.** No native retained worker binaries ship
   in this release; users build from the pinned SDK. Before any future native
   binary distribution, collect actual link maps/import tables, compiler and
   bundled runtime notices for every platform. The Linux CI collector
   `retained-native-link-inventory.mjs` supplies evidence infrastructure, not a
   completed release audit.
4. **Out of scope as a licence gate: build attestation.** Staging manifests
   honestly retain `buildAttestation: false`. Binding binary hashes to clean
   source, toolchains and linker inputs is recommended release evidence, not a
   licence obligation. Hash inventories alone do not prove provenance.
5. **Source-offer mechanism resolved; release value remains.** The notice header
   and [hosting guide](../guide/retained-installation.md) specify the exact
   `https://github.com/LTplus-AG/ifc-lite/tree/<tag>` source URL. Owner must fill
   and verify the matching `v<version>` tag before distribution, as above.
6. **Outside this licence closure: registry operations.** Bootstrap and per-crate
   Trusted Publisher configuration remain manual and unverified; follow the
   [release runbook](../guide/retained-release.md). Its recorded registry/dry-run
   failures remain visible; this record does not waive publication prerequisites.

## Regeneration

The refresh resolves the current locked source closures and reads Cargo archive paths
(metadata is not a build). The check needs Node and Python 3.11+, with no SDK,
Emscripten, Cargo installation or network access:

```sh
node scripts/retained-notices.mjs --refresh --sdk /absolute/pinned-usd-brep \
  --emscripten /absolute/emsdk/upstream/emscripten
node scripts/retained-notices.mjs --check
```

Refresh reads actual installed licence files and preserves byte hashes, including
line endings. Review changed pins, missing texts and supplemental sources before
committing. `--write` regenerates outputs from committed inputs; it cannot waive
a semantic input mismatch. CI's drift check requires no SDK or network.

Performance verdict: packaging-only; no execution or compiler flags changed.
The build-script additions copy licence texts only inside `BUILD_RETAINED=1`.
Artifact comparisons belong in release evidence. Model output was not benchmarked
by this packaging work; no end-to-end speed claim is made.
