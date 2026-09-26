# Test fixtures

This directory holds the IFC / IFCX / LandXML models used by tests, examples,
benchmarks, and helper scripts. The files themselves are **not stored in
this repository** — they are fetched on demand from a GitHub Release.

The catalogue lives in `manifest.json` (committed). For each fixture it
records:

- relative path under `tests/models/`,
- SHA-256 of the file contents,
- size in bytes.

Manifest v1 remains the catalogue for the existing historical IFC corpus.
Reviewed LandXML provenance is per entry, so a new producer fixture cannot
bypass review by retaining the legacy root version. Manifest v2 is also
accepted and may contain both historical IFC rows and reviewed LandXML rows.

## Quick start

```sh
# After cloning, populate the fixtures (one-off; idempotent on re-runs)
pnpm fixtures

# Verify in CI without downloading anything
pnpm fixtures:check

# Show paths that are missing or out of date (one per line)
pnpm fixtures:list-missing
```

Each fetched file is verified against the manifest's SHA-256 before being
written. The fetcher is parallel (default 6 concurrent connections; override
with `FIXTURE_CONCURRENCY=N`) and uses streaming writes, so big fixtures don't
buffer in memory.

`buildingsmart/Viadotto_Acerno.ifc` is fetched from the buildingSMART
Implementers Forum's commit-pinned `Viadotto Acerno.zip` and extracted locally.
The catalogue pins both the ZIP and IFC hashes. The model is an ACCA Software
export for MINnD; no redistribution license was declared in the source
repository, so `fixtures:upload` excludes it from this project's release.

## Why not Git LFS?

LFS is bandwidth-metered; the project's quota was exhausted in early 2026,
which broke `git clone` for new contributors (see PR #585). GitHub Releases
have no per-file bandwidth budget and a 2 GB per-asset limit — comfortably
larger than the biggest fixture in the manifest. Removing LFS also drops the
client-side LFS dependency and lets us version the catalogue (`manifest.json`)
in plain git.

## Where the bytes live

By default the fetcher reads from
`https://github.com/LTplus-AG/ifc-lite/releases/download/<release_tag>`,
where `<release_tag>` is taken from `manifest.json` (currently
`fixtures-v1`). Each asset on the release is named by its SHA-256 hash with
no extension, so the URL pattern is `<base_url>/<sha256>`.

Override the source for mirrors or local cache servers:

```sh
IFC_LITE_FIXTURE_BASE_URL=https://my-mirror.example/path pnpm fixtures
```

### Cost composition fixture provenance

`cost/buildingsmart-cost-composition.ifc` was authored by the ifc-lite
contributors under MPL-2.0. Its independently checked 800 + 1,300 + 150 =
2,250 GBP oracle follows the published buildingSMART IFC4 `IfcCostItem`
composition example; no third-party model bytes were copied into the fixture.
IfcOpenShell 0.8.2 independently opens the fixture as IFC4 and resolves its
top-level `IfcCostValue` to 2,250.

### Structural surface-member fixture provenance

`ifcopenshell/generated_structural_surface_member.ifc` is independently
authored by the ifc-lite contributors under MPL-2.0. It is serialized through
the IfcOpenShell 0.8.3.post2 IFC4 exporter API by
`scripts/fixtures/generate-structural-surface-member.py`; no third-party model
or generator source was copied. The fixed timestamp and stable GUIDs make the
export byte-reproducible with that exporter version.
### Structural edge-curve fixture provenance

`ifcopenshell/generated_structural_edge_curve.ifc` is independently authored
by the ifc-lite contributors under MPL-2.0. It is serialized through the
IfcOpenShell 0.8.3.post2 IFC4 exporter API by
`scripts/fixtures/generate-structural-edge-curve.py`; no third-party model or
generator source was copied. The fixed timestamp and stable GUIDs make the
export byte-reproducible with that exact IfcOpenShell version. Other exporter
builds may serialize different bytes; use 0.8.3.post2 when reproducing the
catalogued SHA-256, or intentionally regenerate and upload a new fixture hash.

## For maintainers: adding a new fixture

1. Drop the file under `tests/models/<group>/<name>` locally.
2. Regenerate the manifest:
   ```sh
   pnpm fixtures:manifest
   ```
3. Upload the new asset to the release (requires the `gh` CLI logged in
   with write access to `LTplus-AG/ifc-lite`):
   ```sh
   pnpm fixtures:upload
   ```
   `upload-fixtures.mjs` checks every local file against the manifest before
   uploading and skips assets that are already on the release. It will also
   create the release if it doesn't exist yet.
4. Commit the updated `manifest.json`.

## For maintainers: rotating to a new release

1. Bump `release_tag` in `manifest.json` (e.g. `fixtures-v1` → `fixtures-v2`).
2. Run `pnpm fixtures:upload` — it will create the new release and copy
   every asset over.
3. Open a PR with the bumped manifest. Old releases can be left in place; the
   manifest decides which one is canonical.

## What gets fetched, what gets skipped

The fetcher hashes any file already on disk before deciding to download. If
the on-disk file matches the manifest's `sha256`, it's left alone. This means:

- Re-running `pnpm fixtures` is cheap (no redundant downloads).
- A dev who has the files locally from a previous LFS clone keeps them
  unchanged.
- A corrupt / partial file is detected by hash and re-fetched.

`tests/models/local/` is explicitly **never** managed by the manifest — it's
reserved for private fixtures contributors keep on their own machine.

## Reviewed LandXML producer provenance

Every LandXML entry (`.xml` or `.landxml`) must add the following fields beside
`path`, `sha256`, and `size`. Historical non-LandXML rows may remain minimal,
whether the root manifest is v1 or v2:

- `provenance.source`: immutable commit-pinned blob URL, 40-character commit,
  source-byte SHA-256, and the fetch date;
- `provenance.license`: SPDX identifier, license URL, and the exact required
  attribution; `provenance.modification` says whether bytes changed, and
  `provenance.no_customer_data` is an explicit review attestation;
- `producer`: producer name, exact version, and export settings;
- `landxml`: schema version, namespace, declared units, and CRS (write
  `not-declared` where the source genuinely omits one — never infer it);
- `feature_inventory`: feature/capability pairs using `rendered`,
  `preserved-only`, `unsupported`, or `refused`.

The validator requires an immutable GitHub HTTPS blob URL whose commit path
segment exactly equals the recorded commit. For an unmodified fixture its
source SHA-256 must equal the catalogue SHA-256. `pnpm fixtures` downloads
those reviewed source bytes from the derived commit-pinned raw URL and verifies
them before writing; it never needs a binary committed in this repository.
Modified LandXML and every non-LandXML row continue to use the
content-addressed fixture release. `pnpm fixtures`, `pnpm fixtures:check`, and
`pnpm fixtures:upload` reject malformed LandXML entries before downloading or
publishing anything.

`pnpm fixtures:manifest` preserves a LandXML entry's reviewed metadata only while
its path, byte size, and SHA-256 are unchanged. To add or alter a LandXML fixture,
first add its complete reviewed entry to `manifest.json`, then regenerate and
upload. This deliberately fails closed: regeneration must never erase
attribution or convert an unreviewed local file into a public release asset.

### CC-BY-4.0 producer rows (checked 2026-09-20)

The following producer rows are fetched on demand from exact upstream commits.
Their license evidence is the pinned
[InfraModel LICENCE](https://github.com/buildingSMART-Finland/InfraModel/blob/eb2720b8b909d44f18ee4f84acfb113322405a87/LICENCE)
and [IFC-infra-unit-test LICENSE.txt](https://github.com/bSI-InfraRoom/IFC-infra-unit-test/blob/bc13603cc4899084edbf9f1d9151443a7fb4cf0e/LICENSE.txt).

| Source and coverage | Source SHA-256 | Bytes |
| --- | --- | ---: |
| [3D-Win 6.6.4 road alignment/profile, GK21 EPSG:3875](https://github.com/buildingSMART-Finland/InfraModel/blob/eb2720b8b909d44f18ee4f84acfb113322405a87/examples/M3_Road/0000_Alignments/M3_RS-CL.tg.xml) | `65d14a5934da307600ee9cd119972fddcca5720cd9f229135cb5cbcc08245c92` | 7,119 |
| [3D-Win 6.6.4 terrain, SourceData/Breaklines/Pnts/Faces, GK21 EPSG:3875](https://github.com/buildingSMART-Finland/InfraModel/blob/eb2720b8b909d44f18ee4f84acfb113322405a87/examples/M3_Road/9004_Terrain_models/M3_Rockbed_survey.mm.xml) | `8a32a56fceffc494e4270d482d4034d376b54e860ecb63195cb767e2845f02c1` | 385,964 |
| [3D-Win 6.6.4 CgPoints, GK21 EPSG:3875](https://github.com/buildingSMART-Finland/InfraModel/blob/eb2720b8b909d44f18ee4f84acfb113322405a87/examples/M3_Road/3300_Lighting/Lightning_columns.xy.xml) | `1adfefa81f5e7593be530ae0189348a9d877e3674094122a4c978694eeef92e1` | 7,417 |
| [Aplitop MDT 8.0 alignment/profile](https://github.com/bSI-InfraRoom/IFC-infra-unit-test/blob/bc13603cc4899084edbf9f1d9151443a7fb4cf0e/Alignment-Aplitop-1/UT-Alignment-Aplitop-1.xml) | `895b0932fcc887685eb766f9be47bf3fb21be716c47bf8071494af321be7ac16` | 5,491 |
| [OpenRoads Designer 10.09 US-survey-foot alignment/profile](https://github.com/bSI-InfraRoom/IFC-infra-unit-test/blob/bc13603cc4899084edbf9f1d9151443a7fb4cf0e/Alignment-INDOT/PR_Twin_Branch_section_alignment.xml) | `57b37fdb3d63a1cfebd2af14646c60f78d566b2908b21b91ea5d411f7eb50740` | 2,487 |
| [Trimble Novapoint 21.354 drainage PipeNetworks, EPSG:3878](https://github.com/bSI-InfraRoom/IFC-infra-unit-test/blob/bc13603cc4899084edbf9f1d9151443a7fb4cf0e/DrainageSystem-1/DrainageSystem-1-1.xml) | `bf13d686b9ce69a83d52d5f7ae8afb0746f1b0c4b43ca94a46f59c7725bc7de6` | 13,446 |

### MIT Civil 3D surface row (checked 2026-09-21)

This generic black-box test fixture is under the pinned
[tin2dem MIT LICENSE](https://github.com/lekks/tin2dem/blob/77ad81524567cce95dac4e7f5ad01aa51f1162f3/LICENSE); it is not vendor-conformance certification.

| Source and coverage | Source SHA-256 | Bytes |
| --- | --- | ---: |
| [Autodesk Civil 3D 2020 LandXML 1.2 international-foot TIN](https://github.com/lekks/tin2dem/blob/77ad81524567cce95dac4e7f5ad01aa51f1162f3/black-box-test/input/cplx_test.xml) | `a81c280d182c941b675cdf412a2e0e4c88813d6403a171308690f6678119a9d4` | 15,772 |

### CC0 bonsai-topo federation control (checked 2026-09-21)

The control files are dedicated by their directory-level
[CC0 notice](https://github.com/louistrue/openBIM-surveyor/blob/db5d60f98daf7937529e49dd6463ef2566da7e97/fixtures/ifc-lite-control/LICENSE-CC0.txt);
the surrounding openBIM-surveyor application remains AGPL-3.0.

| Source and coverage | Source SHA-256 | Bytes |
| --- | --- | ---: |
| [bonsai-topo control-v1 LandXML terrain/CgPoints, EPSG:3006 + EPSG:5613](https://github.com/louistrue/openBIM-surveyor/blob/db5d60f98daf7937529e49dd6463ef2566da7e97/fixtures/ifc-lite-control/terrain.xml) | `e0d3c11ce5ea61e98482f6b22b051da91cfc3abcf5e75989f9110f700323ea10` | 1,766 |

Fixture tests are deliberately skip-safe on a fresh clone, but a skip is
**unproven interoperability evidence** and cannot close #4937. Fetch the
relevant byte with `pnpm fixtures <path>`.
The versioned [LandXML interoperability coverage ledger](../../docs/architecture/landxml-coverage-ledger.md)
is the source of truth for the separate evidence disposition and observed
capability of every producer/workflow cell. Do not promote a public search hit,
a source header, or a manifest entry into a producer-conformance claim there.
The corpus deliberately records the current capability honestly: canonical
Aplitop and OpenRoads roots retain their declared units and alignment/profile
source records, but they do not create terrain, a rendered corridor, or a
producer-wide compatibility claim. InfraModel namespace rows are refused rather
than partially interpreted. This does not certify successful terrain, CgPoints,
or PipeNetworks interchange. The Civil 3D 2020 source is a repository
black-box test fixture under the root MIT grant; it is recorded as a generic
test surface, not as a customer deliverable or vendor conformance
certification.

The CC0 `bonsai-topo-control-v1` catalogue group supplies an IFC4X3 terrain,
LandXML 1.2 TIN/CgPoints, XYZ survey and five independently stated projected
controls at 1 mm tolerance. Its three model files must still pass the viewer's
canonical multi-model load path before the controlled-federation acceptance row
is considered proven. Civil 3D 1.0/1.1 and a TBC-native export remain held.
Generic LandXML 1.2 international-foot TIN invariants are exercised; no Civil
3D producer-conformance claim is made, and no rights-clear, non-customer 1.0
or 1.1 candidate was found. The public RustedGeom examples cannot become vendor
conformance evidence without an author/rights-holder attestation; no customer
or forum upload may substitute for that grant.

The remaining #5051 rows are deliberately documented as unproven rather than
backfilled with plausible-looking bytes. `nathancrews/LandXML2glTF` carries an
Apache-2.0 root grant and a Civil 3D 2007 LandXML 1.1 foot file, but its
`Project name="Partridge"` / parcel payload has no separate no-customer-data
attestation, so it is excluded. Exhaustive public-code searches found no
rights-clear Civil 3D 1.0 export. The only located TBC-native surface export
is an Autodesk Community forum attachment (TBC 32.0.7286.17026; SourceData,
DataPoints, and Breaklines); the attachment has no redistribution grant and
is retained only as an uncommitted local compatibility diagnostic. It does
not satisfy the mandatory TBC producer row.

Historical LandXML XSDs are provenance-only until their original redistribution
terms are verified. They are not vendored or uploaded to the fixture release:

| Version | Official historical URL | SHA-256 from byte-identical archived mirrors |
| --- | --- | --- |
| 1.0 | `http://www.landxml.org/schema/LandXML-1.0/LandXML-1.0.xsd` | `76ae87d7c8ad366fd1a0b0db4d90c5aac223c1df190fa11601207efc2d9b0019` |
| 1.1 | `http://www.landxml.org/schema/LandXML-1.1/LandXML-1.1.xsd` | `d099b33fd5984bfe7c10122bf1c914f64cc245e1fea559a038f511559c89bd88` |
| 1.2 | `http://www.landxml.org/schema/LandXML-1.2/LandXML-1.2.xsd` | `1c814526cc810193c0fd31536d15616426749a05cb445d0e850a69560f7872c2` |

Do not treat a public mirror as a redistribution grant. Archive and review an
original notice before adding any schema bytes to this repository or release.
