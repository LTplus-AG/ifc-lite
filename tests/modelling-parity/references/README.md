# Modelling-parity reference models (lane L5, #9296)

External IFC files that the exercise ladder compares against, sourced so that anyone can
reproduce them. **No reference bytes are committed.** Everything is fetched on demand,
verified by SHA-256 and kept in a git-ignored cache.

Files here:

| File | What |
|---|---|
| `manifest.json` | One entry per reference: source URL, licence (quoted or marked unknown), size, SHA-256, schema, authoring tool, element counts, storeys, which exercise uses it |
| `fetch-references.mjs` | Download into `.cache/<id>/`, verify size and SHA-256; `--check` verifies offline, `--list` prints the table |
| `refresh-info.mjs` | Rewrites the `ifc` block of each manifest entry from `ifc-lite info --json` |
| `extract-target.mjs` | Derives a target spec from a reference IFC (own STEP reader plus the wasm mesh pass) |
| `f3-duplex-target.json`, `f2-fzk-haus-target.json` | Target specs with tolerances for F3 and F2 |
| `references.test.mjs` | Offline tests (manifest invariants, verifier, STEP reader, target/manifest agreement) |

```sh
pnpm parity:references                 # fetch + verify everything (about 14 MB of downloads plus 3 repo fixtures, ~19 MB)
node tests/modelling-parity/references/fetch-references.mjs --check   # offline verify
node --test tests/modelling-parity/references/references.test.mjs

# after `pnpm turbo build --filter=@ifc-lite/cli...`:
node tests/modelling-parity/references/refresh-info.mjs
node tests/modelling-parity/references/extract-target.mjs nibs-duplex-ifc2x3 --check \
  --out tests/modelling-parity/references/f3-duplex-target.json   # exit 1 when stale
```

## References, licences and what they are for

| id | Used by | Licence status | Redistributable | Bytes from |
|---|---|---|---|---|
| `nibs-duplex-ifc2x3` | **F3** | **unknown** (no licence on the NIBS/WBDG page; "All rights reserved" footer) | not assumed | repo fixture `ara3d/duplex.ifc` |
| `kit-fzk-haus-ifc4` | **F2** | informal: "for unrestricted use", attribution requested; no licence text | unclear | IFC Wiki, URL + hash |
| `kit-institute-var-2-ifc4` | later (F6 candidate) | same as FZK-Haus | unclear | IFC Wiki, URL + hash |
| `bsi-ifc4-simple-scene-architecture` | round 7 conformance | CC BY 4.0 (buildingSMART International) | yes, with attribution | GitHub, commit-pinned |
| `bsi-rv12-*` (5 files) | round 7 conformance | CC BY 4.0 (buildingSMART International) | yes, with attribution | GitHub, commit-pinned |
| `nibs-office-solibri`, `nibs-clinic-solibri` | candidates, unused | unknown (as Duplex) | not assumed | repo fixtures |

Why nothing is committed even where the licence allows it: the CC BY 4.0 files are small, but the
same fetch path serves all of them and the policy stays uniform; the repo's own fixture rules
(`tests/models/README.md`) say the same for models whose licence is not clear.

### Duplex (F3): provenance is inferred, not byte-verified

The official file is `2011-09-14-Duplex-IFC.zip` ("Duplex IFC 2x3 Coordination MVD", 7 MB) on
<https://www.wbdg.org/bim/cobie/common-bim-files> (alias `node/9165`; page credited to U.S. Army Corps
of Engineers ERDC-CERL; the model was made by Kristine Fallon Associates from a student design). The
download host `portal.nibs.org` timed out from the build host on 2026-11-08 and the Wayback Machine
holds only the landing page, so the zip's hash is **not** recorded. The bytes used are the repo
fixture `ara3d/duplex.ifc` (sha256 `b347a2c8...c606ed`): Revit Architecture 2011, Coordination View,
timestamp 2011-09-07, storeys and space numbers matching the Duplex. A second public copy with
identical bytes (git blob `8210b5f6...`) is in `ThatOpen/engine_web-ifc`. If you can reach
`portal.nibs.org`, download the zip, unzip it into an empty directory and compare the IFC's SHA-256
with the manifest before trusting this inference.

### FZK-Haus (F2): the reference does not match the F2 brief

The contract describes F2 as "10 x 8 m, hip roof ... Reference: KIT FZK-Haus". The actual FZK-Haus is
**12.0 x 10.0 m with a 30 degree gable roof** (two `IfcSlab(ROOF)` planes), storeys at 0.0 / 2.7 m,
one `IfcStair`, 5 doors, 11 windows and 7 spaces. The target spec records the real values. L2 and L1
should either relax the F2 brief to "FZK-like" or model the FZK-Haus gable and drop the hip claim; the
hip roof is then covered by an SDK probe instead.

The repo fixtures `ara3d/AC20-FZK-Haus.ifc` and `ara3d/C20-Institute-Var-2.ifc` are **different
exports** (different size and hash) from the files KIT publishes today. The manifest pins the KIT
files; do not swap them.

KIT's own site (`iai.kit.edu`, `iai.fzk.de`) no longer serves the files. The maintained origin is the IFC
Wiki page "KIT IFC Examples" (last edited 2021-03-29), whose attribution request is quoted in the manifest.

### buildingSMART Sample-Test-Files and Annex E

`buildingSMART/Sample-Test-Files` carries a `LICENSE` that reads "(C) buildingSMART International Ltd.
This work is licensed under the Creative Commons Attribution 4.0 International License." (GitHub reports
`NOASSERTION` because the file is a notice, not the licence text.) Pinned commit
`80d976a9b193a26a8e928c3e79bff67af1de68a8`. Taken: the IFC4 `Simple-Scene/Building-Architecture.ifc`
(a SketchUp-exported Reference View 1.2 building, 142 KB) and the five small
`ISO Spec - ReferenceView_V1.2` files. These are the machine-readable examples behind the IFC4 Annex E
page; the Annex E HTML itself (`standards.buildingsmart.org/IFC/RELEASE/IFC4/ADD2_TC1/HTML/annex/annex-e.htm`)
was not scraped.

## Target specs

`f3-duplex-target.json` and `f2-fzk-haus-target.json` hold, per storey: elevation and floor-to-floor,
wall count and total axis length, door and window counts with width x height groups, slab count and
top-face area, stair count and spaces (name, number, area); plus footprint (world-axis bounding box of
the lowest occupied storey and dominant wall direction), roof (type, inferred form, slope clusters with
tilt, azimuth and area), totals, and a `tolerances` block (exact counts, 5% lengths and areas, 15% wall
counts, 0.05 m elevations, 2 degrees of slope, 0.15 m footprint). Match spaces by name or number, not by
order. Quantities that Revit does not export (the Duplex has no base quantities) come from geometry:
wall length from the `Axis` polyline, space area from the downward floor faces of the space mesh, and
the gross figure Revit calls `GSA BIM Area` is kept beside it.

Duplex facts worth knowing before rebuilding it: four storeys are listed, but `T/FDN` (-1.25 m) is a
footing pseudo-storey; the occupied levels are Level 1 (0.0), Level 2 (3.1) and Roof (6.0, parapet
walls and a flat roof, no pitch). 57 walls, 14 doors, 24 windows, 2 stairs, 21 spaces. The roof is flat,
so F3 does not test pitched roofs.

Cross-check done: for FZK-Haus the sum of wall axis lengths (113.80 m) is within 4% of the file's own
`BaseQuantities.Length` sum (109.66 m).

## buildingSMART Validation Service (round 7 target)

Checked 2026-11-08 from the service documentation, the OpenAPI schema and the GitHub repositories.
Nothing was uploaded to it: no token, and an upload would publish the file to an external service.

- **Web UI:** <https://validate.buildingsmart.org>, account and login required. Usage is "subject to the
  Terms of Service" (<https://www.buildingsmart.org/wp-content/uploads/2021/09/20210923_TermsOfService.pdf>).
  **That PDF could not be retrieved** (bot challenge, HTTP 403), so its text was not read and nothing is
  claimed about automated or bulk use.
- **API:** exists as a *preview* at `https://dev.validate.buildingsmart.org/api/v1` (OpenAPI 3.0.3,
  "IFC Validation Service API (PREVIEW) 1.0.5", readable without auth at `/api/v1/schema/?format=json`,
  also `/swagger-ui` and `/redoc`). Endpoints: `POST /validationrequest` (multipart `file_name` + `file`),
  `GET /validationrequest[/{id}]`, `/validationtask`, `/validationoutcome`, `/model`. A token is
  obtained by **emailing validate@buildingsmart.org**; it is sent as `Authorization: Token <token>`
  or as the Basic-auth password. The bare production path `https://validate.buildingsmart.org/api/v1/`
  answered 404; only the dev host is documented. Upload limit: non-zipped `.ifc`, at most 256 MB.
- **CLI:** none for the hosted service. buildingSMART's NuGet CLI is for IDS, unrelated.
- **What it checks:** STEP syntax; schema version (IFC2X3, IFC4, IFC4X3_ADD2); EXPRESS schema compliance
  (attributes, inverses, WHERE and global rules); normative rules (implementer agreements, informal
  propositions); industry practices as warnings; bSDD checks are disabled since v0.6.6. It states it does
  not check project-, national- or organisation-specific rules.
- **IFC4 Reference View: not covered.** The only Reference View rule in `ifc-gherkin-rules` at HEAD is
  `IFC430`, an industry-practice rule for **IFC4X3** models that declare ReferenceView. No IFC4
  ReferenceView (or other MVD) rule exists, so the hosted service cannot give round 7 an IFC4 Reference
  View verdict. It can give a schema and normative-rule verdict.
- **Offline alternative (recommended for automation):** the rules and service are open source under
  MIT: `buildingSMART/ifc-gherkin-rules` (runs as `python -m ifc-gherkin-rules <file.ifc>` on IfcOpenShell,
  rule outcomes with step detail), `buildingSMART/validate` and `ifc-validation-data-model`. The
  service can also be self-hosted with Docker Compose. That avoids the token, the upload, the terms
  question and the network. **Not run here**: IfcOpenShell is not installed in this checkout's Python
  (`tools/ifcopenshell_reference` carries a Dockerfile for it), so this is documentation, not a test.
- Round 7 should therefore use: IfcOpenShell `validate` with express rules (already in the repo),
  `ifc-lite validate`, `ifc-gherkin-rules` offline for normative rules, plus our own Reference View
  scope check (allowed entity list) against the `bsi-rv12-*` and `bsi-ifc4-simple-scene-architecture`
  files as known-good examples. Use the hosted dev API only as an occasional cross-check after the token
  is requested and the terms are read.
