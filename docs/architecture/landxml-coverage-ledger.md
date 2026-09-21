<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

# LandXML interoperability coverage ledger

Version: 1.0 (2026-09-21)

This is the acceptance evidence for [#5051](https://github.com/LTplus-AG/ifc-lite/issues/5051),
not a list of formats that a source header happens to name. It is deliberately
separate from `tests/models/manifest.json`: the manifest only catalogues
reviewed, downloadable bytes. Discovery leads, restricted external runs, and
reviewed waivers belong here and cannot be promoted to the manifest merely
because their XML is publicly reachable.

## How to read a row

Each row records two independent facts:

- **Evidence disposition** is one of `redistributable-verified`,
  `externally-verified`, `candidate`, or `waived-replaced`. A verified row has
  rights/provenance review, immutable bytes or an authorized external run, and
  reproducible behavioral evidence. A candidate is not a compatibility claim.
- **Capability** is one of `rendered`, `preserved-only`, `unsupported`,
  `refused`, or `unverified`. It describes the named workflow only; it never
  generalizes across another exporter, schema revision, unit system, or feature
  family.

`waived-replaced` is reserved for a dated reviewer decision that names the
unmet evidence requirement, the search performed, rights-clear replacement
tests, the remaining uncertainty, and a trigger to revisit. No row below is
silently waived. Consequently this ledger is an honest progress report, not a
closure assertion for #5051 or #4937.

## Verified public corpus

The fixture manifest contains the immutable blob URL, source and fixture hash,
fetch date, exact license/attribution, modification status, no-customer-data
attestation, observed producer metadata, declared schema/units/CRS, and feature
inventory for every row referenced below. The producer corpus test skips on a
fresh checkout with `pnpm fixtures <path>` guidance; CI must fetch the byte for
a row to count its result as verified.

| Producer/version and export variant | Schema and units | Workflow / bounded observation | Fixture and test evidence | Evidence disposition | Capability |
| --- | --- | --- | --- | --- | --- |
| Aplitop MDT 8.0, LandXML 1.2 alignment/profile | LandXML 1.2; meter; CRS not declared | Horizontal alignment, profile, lines, curves, spirals. Source semantics are retained; no TIN is invented. | `landxml/producers/aplitop-mdt-8.0-alignment.xml`; `rust/landxml/tests/producer_corpus.rs` | redistributable-verified | preserved-only |
| Bentley OpenRoads Designer 10.09.00.91, LandXML 1.2 alignment/profile | LandXML 1.2; USSurveyFoot; CRS not declared | Horizontal alignment, profile, lines and curves. The declared US-survey-foot token and semantic records must survive both canonical paths; terrain is not implied. | `landxml/producers/bentley-openroads-designer-10.09-us-survey-foot-alignment.xml`; `rust/landxml/tests/producer_corpus.rs` | redistributable-verified | preserved-only |
| 3D-Win 6.6.4, InfraModel road alignment/profile | InfraModel 4.0.3 profile; meter; EPSG:3875 / N2000 | Unsupported namespace/profile is rejected before partial ordinary-LandXML interpretation. | `landxml/producers/3d-win-6.6.4-m3-road-alignment.xml`; `rust/landxml/tests/producer_corpus.rs` | redistributable-verified | refused |
| 3D-Win 6.6.4, InfraModel rockbed terrain | InfraModel 4.0.3 profile; meter; EPSG:3875 / N2000 | SourceData, Breaklines, Pnts and Faces are a separate terrain workflow, not evidence for OpenRoads terrain. Unsupported profile is rejected. | `landxml/producers/3d-win-6.6.4-m3-rockbed-terrain.xml`; `rust/landxml/tests/producer_corpus.rs` | redistributable-verified | refused |
| 3D-Win 6.6.4, InfraModel CgPoints | InfraModel 4.0.3 profile; meter; EPSG:3875 / N2000 | CgPoint-only workflow; unsupported profile is rejected. | `landxml/producers/3d-win-6.6.4-m3-lighting-cgpoints.xml`; `rust/landxml/tests/producer_corpus.rs` | redistributable-verified | refused |
| Trimble Novapoint 21.354.0.0, InfraModel drainage | InfraModel 4.0.3 profile; meter; EPSG:3878 / EPSG:3900 | PipeNetworks, Structs and Pipes are exercised as a separately refused profile. This is not TBC evidence. | `landxml/producers/trimble-novapoint-21.354-drainage.xml`; `rust/landxml/tests/producer_corpus.rs` | redistributable-verified | refused |
| bonsai-topo control-v1 (synthetic) | LandXML 1.2; meter; EPSG:3006 / EPSG:5613 | Independently stated IFC + LandXML + XYZ controls through the canonical 1/N federation load path, including placement, rendering, picking, ownership and CRS refusal. | `landxml/federation/bonsai-topo-control-v1/`; `tests/e2e/federation-control-triplet.e2e.spec.ts`; #5124 | redistributable-verified | rendered |

The two canonical LandXML 1.2 alignment/profile fixtures above prove only
source-record preservation. They do not prove terrain exchange, stationing
evaluation, design/corridor rendering, a declared CRS, or compatibility with a
different OpenRoads or Aplitop release.

## Required producer matrix and disposition

| Required cell | Current evidence / replacement evidence | Evidence disposition | Capability | Waiver state and retained uncertainty |
| --- | --- | --- | --- | --- |
| Civil 3D LandXML 1.0, metric | Rights-clear producer-attributed bytes have not been accepted. Synthetic 1.0 TIN schema tests cover only grammar invariants. | candidate | unverified | No waiver decision. A contributor-owned export with an explicit redistribution grant is required to make a producer claim. |
| Civil 3D LandXML 1.0, international foot | No accepted producer byte. Synthetic unit tests are not vendor evidence. | candidate | unverified | No waiver decision; same acquisition trigger. |
| Civil 3D LandXML 1.0, US-survey foot | No accepted producer byte. | candidate | unverified | No waiver decision; same acquisition trigger. |
| Civil 3D LandXML 1.1, metric | Rights-clear producer-attributed bytes have not been accepted. Synthetic 1.1 TIN schema tests cover only grammar invariants. | candidate | unverified | No waiver decision; same acquisition trigger. |
| Civil 3D LandXML 1.1, international foot | No accepted producer byte. | candidate | unverified | No waiver decision; same acquisition trigger. |
| Civil 3D LandXML 1.1, US-survey foot | No accepted producer byte. | candidate | unverified | No waiver decision; same acquisition trigger. |
| Civil 3D LandXML 1.2, metric | No accepted producer byte. | candidate | unverified | No waiver decision; same acquisition trigger. |
| Civil 3D LandXML 1.2, international foot | `lekks/tin2dem` has a MIT repository grant and a Civil-3D-shaped 2020 surface, but its project/provenance is insufficient for producer certification. It remains a generic invariant fixture only. | candidate | rendered | No waiver decision. Do not claim Civil 3D interoperability from this row without author attestation. |
| Civil 3D LandXML 1.2, US-survey foot | No accepted producer byte. | candidate | unverified | No waiver decision; same acquisition trigger. |
| TBC legacy LandXML 1.2: alignment / profiles / surface source definitions / breaklines | No accepted TBC-native byte. Trimble documentation and public search leads do not establish a redistributable export. | candidate | unverified | No waiver decision. A contributor-owned toy project with explicit grant is the preferred trigger. |
| TBC ISO 15143-4: alignment / profiles / surface source definitions / breaklines | No accepted ISO 15143-4 byte. This grammar is tracked separately and must not be treated as LandXML 1.2. | candidate | unverified | No waiver decision; same acquisition trigger, including exact grammar identification. |
| OpenRoads terrain | FHWA/WFLHD material establishes that terrain is a real workflow but does not license a concrete attachment. The alignment/profile fixture above is not terrain evidence. | candidate | unverified | No waiver decision. Add a specific rights-reviewed terrain export and test it independently. |
| OpenRoads alignment/profile | The CC-BY fixture and canonical document/stream behavioral test preserve the producer header, US-survey-foot unit, alignment and profile records. | redistributable-verified | preserved-only | Not waived. The remaining limitation is no terrain or rendered corridor claim. |
| Aplitop alignment/profile | The CC-BY fixture and canonical document/stream behavioral test preserve the producer header, metric unit, alignment and profile records. | redistributable-verified | preserved-only | Not waived. No terrain or rendered corridor claim. |
| IFC + LandXML + point-cloud federation with independent controls | CC0 control triplet from #5124. | redistributable-verified | rendered | Complete independently controlled federation row; synthetic, not vendor certification. |

## Discovery evidence held outside the manifest

These entries are retained to make the search reproducible, but none are
fixture provenance and none changes a matrix row above:

| Lead | Checked | Why it is not verified evidence |
| --- | --- | --- |
| `mf4633/gisc` | 2026-09-21 | Its relevant files are COM-derived or invented, Civil-3D-shaped geometry. The repository MIT license can support generic invariants, not producer certification. |
| `nathancrews/LandXML2glTF` / LandXML.org samples | 2026-09-21 | Possible producer headers, but no file-level non-customer-data provenance and redistribution attestation for the candidate bytes. |
| WFLHD solicitation/design packages | 2026-09-21 | Establishes OpenRoads terrain/alignment workflow, not permission to redistribute a concrete attachment. |
| swisstopo OGD | 2026-09-21 | Usable with attribution after a concrete download review; optional federation expansion only, because #5124 already covers the required independent-control workflow. |
| GitHub code search results | 2026-09-21 | Search hits are discovery leads until exact bytes, root/file rights, producer attribution, and non-customer-data review are recorded. |

## Reproduction and closure gate

Run the public-byte checks with:

```sh
pnpm fixtures landxml/producers/aplitop-mdt-8.0-alignment.xml
pnpm fixtures landxml/producers/bentley-openroads-designer-10.09-us-survey-foot-alignment.xml
cargo test -p ifc-lite-landxml --test producer_corpus
```

The test names cite #5051 and assert semantic facts rather than a byte snapshot.
Its absence skip is intentionally not evidence of interoperability. Before
closing #5051, replace every remaining candidate with either a reviewed
`redistributable-verified` or `externally-verified` record, or a complete,
dated `waived-replaced` decision under the issue's waiver rules. Record the
actual acceptance run and keep the public fixture, corpus, and required CI
green.
