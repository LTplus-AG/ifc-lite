<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.
-->

# LandXML interoperability coverage ledger

Version: 1.1 (2026-09-22)

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

`waived-replaced` is reserved for a dated maintainer acceptance decision that
names the unmet evidence requirement, the search performed, rights-clear
replacement tests, the remaining uncertainty, and a trigger to revisit. No row
below is silently waived. A waiver narrows the acceptance claim to the stated
grammar invariant; it never turns synthetic input into vendor certification.

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
| Civil 3D LandXML 1.0, metric | Rights-clear 1.0 grammar vector, exact metric scale and TIN source topology. | waived-replaced | unverified | W-01; grammar/unit evidence only, never Civil 3D certification. |
| Civil 3D LandXML 1.0, international foot | Rights-clear 1.0 grammar vector, exact international-foot scale and TIN source topology. | waived-replaced | unverified | W-02; grammar/unit evidence only, never Civil 3D certification. |
| Civil 3D LandXML 1.0, US-survey foot | Rights-clear 1.0 grammar vector, exact US-survey-foot scale and TIN source topology. | waived-replaced | unverified | W-03; grammar/unit evidence only, never Civil 3D certification. |
| Civil 3D LandXML 1.1, metric | Rights-clear 1.1 grammar vector, exact metric scale and TIN source topology. | waived-replaced | unverified | W-04; grammar/unit evidence only, never Civil 3D certification. |
| Civil 3D LandXML 1.1, international foot | Rights-clear 1.1 grammar vector, exact international-foot scale and TIN source topology. | waived-replaced | unverified | W-05; grammar/unit evidence only, never Civil 3D certification. |
| Civil 3D LandXML 1.1, US-survey foot | Rights-clear 1.1 grammar vector, exact US-survey-foot scale and TIN source topology. | waived-replaced | unverified | W-06; grammar/unit evidence only, never Civil 3D certification. |
| Civil 3D LandXML 1.2, metric | Rights-clear 1.2 grammar vector, exact metric scale and TIN source topology. | waived-replaced | unverified | W-07; grammar/unit evidence only, never Civil 3D certification. |
| Civil 3D LandXML 1.2, international-foot | Rights-clear 1.2 grammar vector and MIT `lekks/tin2dem` generic fixture, exact international-foot scale and TIN source topology. | waived-replaced | unverified | W-08; neither source has the contributor attestation required for Civil 3D certification. |
| Civil 3D LandXML 1.2, US-survey foot | Rights-clear 1.2 grammar vector, exact US-survey-foot scale and TIN source topology. | waived-replaced | unverified | W-09; grammar/unit evidence only, never Civil 3D certification. |
| TBC legacy LandXML 1.2: alignment / profiles / surface source definitions / breaklines | Rights-clear 1.2 document grammar tests preserve the named feature families and multiple profiles; bounded stream lifecycle is covered separately. Trimble documents that an export uses surface source data or its definition, not both, subject to the selected surface-description option. | waived-replaced | unverified | W-10; not a claim about Trimble Business Center output. |
| TBC ISO 15143-4: alignment / profiles / surface source definitions / breaklines | Foreign-root test refuses an ISO 15143-4-labelled grammar before ordinary LandXML content is interpreted. Trimble documents this as a separate export version with a different supported-data set from legacy TBC 1.2. | waived-replaced | unverified | W-11; the generic safety result does not establish the behavior of a real TBC ISO export. |
| OpenRoads terrain | Rights-clear 1.2 terrain grammar invariant preserves Pnts/Faces/Breaklines. The verified OpenRoads alignment fixture is deliberately not terrain evidence. | waived-replaced | unverified | W-12; no OpenRoads terrain exporter certification. |
| OpenRoads alignment/profile | The CC-BY fixture and canonical document/stream behavioral test preserve the producer header, US-survey-foot unit, exact alignment identity/station/length, and profile records. | redistributable-verified | preserved-only | Not waived. The remaining limitation is no terrain or rendered corridor claim. |
| Aplitop alignment/profile | The CC-BY fixture and canonical document/stream behavioral test preserve the producer header, metric unit, exact alignment identity/station/length, and profile records. | redistributable-verified | preserved-only | Not waived. No terrain or rendered corridor claim. |
| IFC + LandXML + point-cloud federation with independent controls | CC0 control triplet from #5124. | redistributable-verified | rendered | Complete independently controlled federation row; synthetic, not vendor certification. |

## Discovery evidence held outside the manifest

These entries are retained to make the search reproducible, but none are
fixture provenance and none changes a matrix row above:

| Lead | Checked | Why it is not verified evidence |
| --- | --- | --- |
| [`mf4633/gisc`](https://github.com/mf4633/gisc) | 2026-09-21 | Its relevant files are COM-derived or invented, Civil-3D-shaped geometry. The repository MIT license can support generic invariants, not producer certification. |
| [`nathancrews/LandXML2glTF`](https://github.com/nathancrews/LandXML2glTF) / [LandXML.org samples](http://www.landxml.org/webapps/landxmlsamples.aspx) | 2026-09-21 | Possible producer headers, but no file-level non-customer-data provenance and redistribution attestation for the candidate bytes. |
| [WFLHD design-data policy](https://highways.dot.gov/federal-lands/pddm/wfl/release-digital-design-data-3d-models) and [solicitations](https://highways.dot.gov/federal-lands/business/construction-contracting) | 2026-09-21 | Establishes OpenRoads terrain/alignment workflow, not permission to redistribute a concrete attachment. |
| [swisstopo OGD](https://www.swisstopo.admin.ch/en/height-model-swisssurface3d) | 2026-09-21 | Usable with attribution after a concrete download review; optional federation expansion only, because #5124 already covers the required independent-control workflow. |
| GitHub code-search findings summarized in the [#5051 acceptance research decision](https://github.com/LTplus-AG/ifc-lite/issues/5051#issuecomment-5766908841) | 2026-09-21 | Search hits are discovery leads until exact bytes, root/file rights, producer attribution, and non-customer-data review are recorded. |

## Dated waiver decisions

The following are the revised #5051 waiver decisions, dated 2026-09-22 by
repository maintainer `@louistrue` after the 2026-09-21
[#5051 acceptance and research decision](https://github.com/LTplus-AG/ifc-lite/issues/5051#issuecomment-5766908841).
The closing PR's code-owner review ratifies the implementation of that decision;
it must not be recorded as complete before that review is submitted. The
waivers replace the unavailable-corpus requirement only. They do not permit a
vendor name in product documentation, release notes, or support claims.

The searches recorded for every waiver were: GitHub code search for the exact
producer/schema/unit strings; review of `mf4633/gisc` and
`nathancrews/LandXML2glTF`/LandXML.org leads; Trimble's public TBC
[export results](https://help.fieldsystems.trimble.com/tbc/1620.htm),
[settings](https://help.fieldsystems.trimble.com/tbc/1631.htm), and
[version choice](https://help.fieldsystems.trimble.com/tbc/992.htm); and
WFLHD's public design-data policy and solicitation pages.
None provided a concrete byte with both producer attribution and an explicit
redistribution/non-customer-data grant. The next trigger for every waiver is a
rights-clear, producer-attributed export with that grant, or 2027-03-22,
whichever is earlier. On either trigger, replace the waiver with a fixture
manifest record and a producer-specific behavioral test.

| ID | Unmet corpus requirement | Rights-clear replacement evidence | Residual uncertainty |
| --- | --- | --- | --- |
| W-01 | Civil 3D 1.0 metric export | `issue_5051_waived_producer_cells_keep_schema_units_and_tin_source_invariants`: 1.0 meter scale, Pnts, Faces and Breaklines | Civil 3D-specific ordering, optional elements and export defects are untested. |
| W-02 | Civil 3D 1.0 international-foot export | Same test: 1.0 `foot` scale, Pnts, Faces and Breaklines | Civil 3D-specific ordering, optional elements and export defects are untested. |
| W-03 | Civil 3D 1.0 US-survey-foot export | Same test: 1.0 `USSurveyFoot` exact scale, Pnts, Faces and Breaklines | Civil 3D-specific ordering, optional elements and export defects are untested. |
| W-04 | Civil 3D 1.1 metric export | Same test: 1.1 meter scale, Pnts, Faces and Breaklines | Civil 3D-specific ordering, optional elements and export defects are untested. |
| W-05 | Civil 3D 1.1 international-foot export | Same test: 1.1 `foot` scale, Pnts, Faces and Breaklines | Civil 3D-specific ordering, optional elements and export defects are untested. |
| W-06 | Civil 3D 1.1 US-survey-foot export | Same test: 1.1 `USSurveyFoot` exact scale, Pnts, Faces and Breaklines | Civil 3D-specific ordering, optional elements and export defects are untested. |
| W-07 | Civil 3D 1.2 metric export | Same test: 1.2 meter scale, Pnts, Faces and Breaklines | Civil 3D-specific ordering, optional elements and export defects are untested. |
| W-08 | Civil 3D 1.2 international-foot export | Same test plus MIT `lekks/tin2dem` generic invariant fixture | The fixture has no producer/customer-data attestation, so it cannot certify Civil 3D. |
| W-09 | Civil 3D 1.2 US-survey-foot export | Same test: 1.2 `USSurveyFoot` exact scale, Pnts, Faces and Breaklines | Civil 3D-specific ordering, optional elements and export defects are untested. |
| W-10 | TBC-native legacy LandXML 1.2 export | `issue_5051_waived_producer_cells_keep_schema_units_and_tin_source_invariants`; `preserves_distinct_profiles_curves_sections_and_roadway_associations`; independent `stream` tests cover bounded mechanics | TBC version, producer extensions and option-specific output are untested. Trimble documents multiple vertical alignments per horizontal, but only source data or definition is used per exported surface; surface settings select points/breaklines, triangles, both as two surfaces, or program optimization, and imported internal data may force triangles. |
| W-11 | TBC ISO 15143-4 export | `issue_5051_refuses_unknown_or_cross_grammar_root_declarations` refuses a foreign ISO-labelled root before semantic interpretation | Trimble documents a different supported-data set than legacy 1.2; exact ISO grammar, feature exclusions and every real-export diagnostic remain untested. |
| W-12 | OpenRoads terrain export | `issue_5051_waived_producer_cells_keep_schema_units_and_tin_source_invariants` exercises 1.2 Pnts/Faces/Breaklines without borrowing the alignment fixture | OpenRoads terrain producer extensions, surface definitions and output ordering are untested. |

## Reproduction and closure gate

Run the public-byte checks with:

```sh
pnpm fixtures \
  landxml/federation/bonsai-topo-control-v1/control.json \
  landxml/federation/bonsai-topo-control-v1/terrain.xml \
  landxml/producers/aplitop-mdt-8.0-alignment.xml \
  landxml/producers/bentley-openroads-designer-10.09-us-survey-foot-alignment.xml \
  landxml/producers/autodesk-civil3d-2020-international-foot-tin.xml \
  landxml/producers/3d-win-6.6.4-m3-road-alignment.xml \
  landxml/producers/3d-win-6.6.4-m3-rockbed-terrain.xml \
  landxml/producers/3d-win-6.6.4-m3-lighting-cgpoints.xml \
  landxml/producers/trimble-novapoint-21.354-drainage.xml
cargo test -p ifc-lite-landxml --test producer_corpus
cargo test -p ifc-lite-landxml --test schema_versions
cargo test -p ifc-lite-landxml --test ingest \
  preserves_distinct_profiles_curves_sections_and_roadway_associations
```

Acceptance run: 2026-09-22 at
`f9ef17249792ac111e8015772ddaa24eb88a7040`. The scoped fixture check reported
all nine files present and hash-verified; `producer_corpus` executed all four
tests with no skips; all five `schema_versions` tests passed; and the targeted
multiple-profile regression passed. The closing PR must link its green required
CI and code-owner waiver ratification before this issue is closed.

The test names cite #5051 and assert semantic facts rather than a byte snapshot.
Its absence skip is intentionally not evidence of interoperability. #5051's
revised closure gate is satisfied when every required row is either reviewed
`redistributable-verified`/`externally-verified` or appears in the dated waiver
table with its replacement test green. Record the actual acceptance run and
keep the public fixture, corpus, and required CI green.
