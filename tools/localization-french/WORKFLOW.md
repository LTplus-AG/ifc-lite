# French browser acceptance

**PASS — all 10 workflow checks, exit 0; no runtime page errors, no browser
checks skipped.** Actual hardware WebGPU/WASM acceptance on Pop (`pop-os`),
2026-11-05, shared checkout HEAD `fd5eaf6277940e7c8bdc30c905139f594bc725b1`.
The checkout remains dirty with coordinator-owned files and the harness changes.
No production/test/German/campaign edits, staging, commits, pushes or delegation
were performed by this tester. Browser contexts and the tester preview tab are
closed; the coordinator's service remains running.

The original local job `6e2fc76c-3124-4fb5-9e5d-a3c4c214146c` completed exit 0:
root `pnpm typecheck`, then
`TEST_PATTERN="src/i18n/.*test" pnpm test --filter=@ifc-lite/viewer`.
The latter built the current viewer and passed 66 tests, zero skipped.
The receipt began at abeb878ee8 with the French repairs dirty; the preview
receipt at fd5eaf6277 records the same worktree digest. This is local evidence,
not a claim about the separate clean-source fleet request or full viewer suite.
Original log: `/tmp/french-validation-1.log`.
Original preview `dc76c1b4-fc1d-4ca4-881d-cb08ab6eda24`, port 5189, started
only after that job released the checkout. No duplicate build/server submitted.
Receipts: `/home/louistrue/build-workers/worker-state/jobs/<job-id>/receipt.json`;
snapshots and exact build hashes: `evidence/build-provenance.json`.

The successful build produced `assets/fr-DZn_WsUw.js` (SHA256
`54a7a9f9ce2da90a87fbb720e7e4b5bcbb18ccc0fa12427acc8a4ea50dec182a`).
Built and installed IFC WASM match SHA256
`99d9681387e12ac8a04731eefbd03bc0599e23236803d447d22c8b5604c255b4`;
the browser fetched the real built WASM asset HTTP 200. No Rust build or mocked
WASM. GPU: Intel Gen-12LP, `isFallbackAdapter: false`, Chrome headless shell
154.0.8037.92 with explicit Intel Vulkan ICD. This was untimed correctness work,
not performance evidence.

Reproduce after a current build and the existing admitted preview is ready:

```sh
VK_DRIVER_FILES=/usr/share/vulkan/icd.d/intel_icd.json \
IFC_GPU_CHROME_PATH=/home/louistrue/.t3/tools/chrome-headless-shell/linux64/154.0.8037.92/chrome-headless-shell \
FRENCH_WORKFLOW_URL=http://127.0.0.1:5189/ \
FRENCH_WORKFLOW_ATTEMPT=final-verified \
~/build-workers/ifc-gpu-check --limit 6 -- node tools/localization-french/workflow.mjs
```

Final log: `/tmp/french-workflow-verified.log` (also copied into evidence).
`evidence/final-verified/workflow.json` records exact host/source/fixture hashes,
adapter, `idsLocale: fr`, results and errors. `evidence/acceptance.json` records
the command, exit, limitations and harness hash; `evidence/sha256.json` inventories
artifacts. Screenshots were visually inspected, alongside accessible snapshots.

| Check | Actual evidence in `evidence/final-verified/` |
| --- | --- |
| IFC render | `wide-loaded.png`: real house, 14 meshes / 12 geometry elements; French chrome and file information |
| Hierarchy/storey/properties | Expanded Single-family house and 00 groundfloor, searched and clicked the real IfcWall; selected ID 262, highlighted wall, exact GlobalId `1AQAupaRP1txwK1AGiN61V` in `hierarchy-properties.png` |
| Measurement | French Mesure, real canvas drag produces one measurement and visible 4.102 m readout (`measurement.png`) |
| Section | Coupe → Dessus (Z), enabled down-axis plane and actual clipped/capped house (`section.png`) |
| IDS and export | Loaded committed `building-architecture.ids`, ran validation, expanded Walls are external; French requirement “La propriété … doit être égale à …”, French status and library controls (`ids-findings.png`, `ids-aria.txt`) |
| Parsed download | Real `ids-report-2026-11-05.json`: 3 specifications, 1 passed / 2 failed; 11 entity results, 8 passed / 3 failed, rate 72. French requirement descriptions asserted; downloaded failure reasons also inspected in French |
| Narrow/wide | 1600×1000 and 390×844, document width exactly 390; narrow image shows actual cut geometry, measurement, French controls (`narrow.png`) |
| Locale URL | `?model=/samples/building-architecture.ifc&lang=fr`, HTML language and stored preference `fr`; IDS locale asserted `fr` |
| Persistence/English | Removed query and reloaded, French persisted; `?lang=en` switched HTML, saved preference and visible Home tab |
| Negotiation/errors | Fresh fr-CH context with no stored choice rendered Accueil and HTML `fr`; pageerror collection installed before navigation on both pages, final `errors: []` |

Limits: sampled role names, snapshots and layouts are not an exhaustive
accessibility/overlap audit or native-speaker approval. The privacy notice covers
much of the narrow lower viewport; model and measurement remain visible. Legacy
English `Toggle dark mode`, ViewCube captions, tour title, `PROPERTY` badge and
some raw JSON fields remain; author-supplied IFC/IDS names stay unchanged.
The committed IDS sample reports one document-audit error but completes all
three specifications; this is distinct from runtime page errors. Local preview
returns 404 for `/_vercel/insights/script.js` (recorded under `httpErrors`), without
runtime exceptions or missing model/WASM assets. Root lint, broader tests,
pre-handoff and separate fleet validation remain coordinator-owned coverage.

Preserved attempts: initial T3 open returned `ERR_CONNECTION_REFUSED` before
service readiness. Two later preview navigations reported `No compatible GPU
adapter found`, so the tester closed that tab and used the authorized GPU helper.
`attempt-1` exited 1 at a stale IDS source-button locator; its report and failure
screenshot remain. The locator was corrected from the accessible French snapshot.
`attempt-2` passed all ten checks. The subsequent `final` run expanded IDS and
identified analytics 404s, but visual review caught a blank narrow resize frame;
that image is not accepted as model-render evidence. The harness now waits for
canvas presentation, and `final-verified` passed again with visible narrow model.
All attempt reports/logs remain; failed or blank evidence is not counted as green.
