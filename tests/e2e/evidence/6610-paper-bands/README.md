# #6610 current-main paper-band evidence

Actual tested source: 325593c90bc85af810f7df6b09eef21222ee7fc4.
Integrated main: 002876c49393798efa246464ca5c285a9b372826.
This evidence-only commit changes no production, tests, dependency or build inputs.
All 76 report feature paths and 24 incoming main paths were preserved byte-for-byte.

Native witness SHA256: 66fdaf21fdb8b18e4eee96ed3bd3c8911bd12bbf923f88beb7610421c389b254
Final production asset lease SHA256: 5d85705a7e27b97fee6f5490f9a6782c43dbfa1006722ecd73cb864d6e0b59a3
All 727 production asset hashes were checked before and after the native run.
Reader SHA256: dc8ee3d9a2c2b56b7aebc198a4e3791706bd5f4fe6428af70ec737794af0cdf9.
Independent reader: dedicated Python 3.12 venv, pinned PyMuPDF 1.28.2.

## Actual local qualification

- Root full build: 62/62 tasks passed; final post-gates build also 62/62.
- Root Turbo typecheck: 111/111; mandatory audit: 3,331 test files, 57 packages.
- 34 relevant report/copy/onboarding files: 314 tests passed, zero failures/skips.
- Lint, module size, source assertions, test wiring, docs samples/generated/readmes and API surface passed.
- Native Chrome 154.0.8037.58: NVIDIA blackwell, nonfallback adapter.
- Four actual product PDF exports passed; 16 native complete-band plus body captures passed.
- Real reload preserved both authored bands before the same IFC was uploaded again.
- Initial/reloaded model: exact name/fingerprint equality and 14 retained meshes; positive GPU draws/resident bytes.
- Model schema was not recorded: the witness read an undefined optional property; no schema-equality claim.
- File-change events were automated with isTrusted=false; no trusted-input claim.
- Own context, CDP connection, server and Windows download folder were all cleaned up.

## Public real authoring-tool model

[SketchUp 2024 building-architecture.ifc](https://raw.githubusercontent.com/LTplus-AG/ifc-lite/baa7d34db1be4bc8bf0b3479df33275da3130fc6/apps/viewer/public/samples/building-architecture.ifc)
225,635 bytes; SHA256 3ff9b10bd00c7b96dded51e7ca5a6b69efbea38b049adcdd05fcd247de7e70d5.
Canonical ingestion established completed store/fingerprint/retained geometry, with no loading/streaming/error.

## Downloaded PDFs

| Case | Pages | Bytes | SHA256 |
| --- | ---: | ---: | --- |
| Native overflow | 3 | 14895 | 1abbde6865f8a3a861ac811598bfa478230eb16ed48d0eff8c7682bd9f9f1367 |
| Native defaults after reset | 3 | 12507 | 653acf9116e3e47aa81b588dca2606f9050b7cb343ac947ee3e37030fa4b88bc |
| Native eleven pages | 11 | 14516 | 52fdc7b431a24fda30f78230bdebfef916b8108fa307379266247890916dea35 |
| Native A3 landscape | 11 | 14549 | b5866ce4e6fbd2da7379400bfced752d374619ef463e6a0a1023ee4d129f63f1 |

## Selected lossless images

- [Native overflow-pdf-page-1.png](Native%20overflow-pdf-page-1.png): SHA256 fa9b87a12a1ed8ebf3a5f9eb302c65b19f7eb6c049722f0b4a7482f4c62ecc3d.
- [Native defaults after reset-pdf-page-3.png](Native%20defaults%20after%20reset-pdf-page-3.png): SHA256 eaf64936a8fe74de1f2c5a18c33b3981550cc66b88377bb2d71a2ebbb75ae670.
- [Native A3 landscape-pdf-page-11.png](Native%20A3%20landscape-pdf-page-11.png): SHA256 848548fe5ca2587826604aabea05d2707e9229deb1597d57b5c0aed3e9f5eb6e.
- [Native eleven pages-last-footer-visible-viewport.png](Native%20eleven%20pages-last-footer-visible-viewport.png): SHA256 3c4b4cbea9c35aa122f29f1de85d2cfb153981ded33e63419854b0890e39b5d8.

## Scope and preserved failures

Native viewport captures show every heading/footer text, date, counter and logo rectangle plus at least one body line inside all actual clips and clear of every toast. They are partial paper views, not entire-page screenshots.
Independent PDF.js text/image/page/anchor checks and PyMuPDF complete first/last-page rasters qualify exported pages; they do not claim pixel-identical glyph painting between DOM and PDF.
Authored captured dates are exact. Default Generated footers use the actual fresh export timestamp, checked within real before/after bounds in the browser locale and timezone.
Models are session-only. After real reload, band persistence was proved first, then the same model was canonically reloaded. No claim of simultaneous body/footer visibility in the shorter no-model banner viewport.
The first current attempt stopped before Chrome on an obsolete asset lease: the root test graph rebuilt the viewer. The stale lease and raw failure are retained. A final root build captured the fresh 727-asset lease.
The next current attempt exported the authored report and proved persistence, then genuinely refused a no-model last-footer/body clip whose 701.69px span exceeded its 685px port. The unchanged clip controls passed after real model reload; prior failure receipt/source are retained.
Cross-OS download transport uses only the actual owned browserContextId with an owned Windows temporary directory. Historical same-context default Linux path canceled; Windows path completed with exact bytes. No global download policy or direct producer bypass.
Historical causal controls are explicitly scoped to their frozen earlier production heads. Their production paths remain identical in this current source; current normal/native gates are recorded separately. Historical D inverse predates the logo-cancellation fix; that fix has its own actual red/green controls.
Remote CI, review verdicts and per-layer landing gates remain separate requirements. This packet is not a merge approval or a performance/all-model verdict.

## Lossless raw proof

raw-proof.tar.gz SHA256: 22573f406a9f3c45a2aaa2d3d28a7724a7ac1d4cf2dca3a785f6eaf55d009ffa.
Deterministic gzip/tar contains original native receipts/model screenshots, witness/reader, source identity, all-asset lease, gate logs and guardian receipts, historical causal controls and genuine current failed-attempt provenance.
