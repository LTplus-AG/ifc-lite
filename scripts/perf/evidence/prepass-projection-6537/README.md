# Checked prepass projection opportunity screen (#6537)

Verdict: reject unused nested attribute projection for the seven
screened direct-record families on the original four-model corpus. The canonical
parser found no unused list or typed-value containers in those four real files. The unused
values were scalar/null fields and short relationship strings; the dominant
styled-item population had no unused string bytes. This does not reject a
measured, different prepass bottleneck or establish a universal performance limit.

The harness links unmodified `ifc-lite-core` from frozen
`0d4168887dd099f36b5d9eb6460d940533b4a2d0`. It uses `EntityScanner`, the complete
canonical `parse_entity` grammar and `AttributeValue::from_token`; it neither
adds a parser nor changes the runtime. The slot selection follows direct readers
in `prepass.rs`, `prepass_styled.rs` and `prepass_type_material.rs`. It covers
`IfcStyledItem`, `IfcMaterialDefinitionRepresentation`,
`IfcRelAssociatesMaterial`, `IfcRelVoidsElement`, `IfcRelFillsElement`,
`IfcRelAggregates` and `IfcRelDefinesByType`. Indexed palettes and indirect
style/material records are excluded because they need a separate consumption
and cost measurement.

## Observations

| Public file | Direct records | Unused list/typed containers | Unused string/enum bytes | All direct attribute conversion and drop, native |
| --- | ---: | ---: | ---: | ---: |
| AC20-FZK-Haus.ifc | 473 | 0 | 1,694 | 0.035 ms |
| ISSUE_129_N1540_17_EXE_MOD_448200_02_09_11SMC_IGC_V17.ifc | 2,499 | 0 | 24,178 | 0.196 ms |
| ISSUE_053_20181220Holter_Tower_10.ifc | 94,318 | 0 | 53,856 | 6.146 ms |
| O-S1-BWK-BIM architectural - BIM bouwkundig.ifc | 27,891 | 0 | 43,626 | 1.955 ms |

These are one-shot native opportunity measurements, **not** whole-load A/B or
worker-pool speedups. The conversion column includes required values, allocation
and destruction, plus paired timer overhead; it is a ceiling on the observed
conversion work in this diagnostic, not an amount a projection would save.
The canonical parser still constructs and validates its complete token tree.
Record-family coverage is a superset of execution: some conditional prepass
branches may skip records this screen counts. Indirect decoding, memoization,
entity construction, geometry, GPU upload and source copies are not measured.
Concurrent qualification work and native versus WASM execution prevent treating
these timings as a controlled browser comparison.

The additional public Revit MedicalClinic MEP and Snowdon structural controls
are retained in `prepass-revit-construction-census.json.gz`. Their separate harness
screens six families, omitting `IfcMaterialDefinitionRepresentation`, and only
classifies unused values for the void/fill reference pair. The medical model
contains no covered void/fill records; Snowdon's covered pairs have no unused
lists and only short relationship strings. This extends the narrow negative
screen to a large Revit family; it does not establish that every unused field
or indirect style record in these two models is cheap.

The rejected general attribute constructor in #5330 already failed end-to-end
qualification. This narrow mechanism differs by converting only consumed
attributes, but the measured absence of unused nested trees gives no reason to
repeat a broader rewrite. Reopen this candidate only after a source-matched
worker capture identifies substantial unused attribute materialization on its
actual critical path, with complete malformed-record validation preserved.

## Reproduction and provenance

`results.json.gz` retains every type row, parse failures and limitations. All four
files parsed successfully within the seven families. `provenance.json.gz` records
original fixture SHA-256/size, frozen source head, original harness and build
hashes. The original diagnostic has its own Cargo dependency lock, retained here;
it is not represented as a workspace benchmark build. The lock is archived as
`Cargo.lock.gz`. `build.log.gz` and
`clippy.log.gz` record the standalone optimized build and warnings-as-errors check.
The decoded `census.rs.gz` adds only the required MPL header to the original harness; its body
is byte-identical to the source named in provenance.

`construction-census.rs.gz` is the unchanged additional harness from source
`5101bf33e053d1a4f1af6d86df4bda59a20ec6bb`. Its separate provenance, actual
build log, and pre/post host observations retain the original capture. These
are historical diagnostic runs, not freshly recompiled results for this PR.
The canonical parser and original direct-reader paths are byte-identical to
the original capture on publication base `29e1088dda6777f7086bd122208ce7bda8db1d89`;
the additional capture's canonical parser is also unchanged. Historical
standalone Clippy evidence applies to the original harness only.

Every retained capture, harness, dependency lock and log is archived losslessly.
Use `gzip -dc <artifact>.gz` to inspect its original contents. The [artifact manifest](ARTIFACTS.md)
records compressed and decoded sizes and SHA-256 hashes. All 15 newly packaged
archives have a zero gzip timestamp and decode exactly to publication source
`0339c7ae563a66b3638dd1d347c49e6f0a469d6e`; both existing result archives
remain byte-identical. Historical provenance names the uncompressed filenames
and hashes. These are inert evidence archives; no gate or runtime source changed.

To reproduce, create a temporary Cargo package with `ifc-lite-core` as a path
dependency pointing at the recorded checkout and `serde_json = "1.0"`. Decompress
`census.rs.gz` to `src/main.rs` and `Cargo.lock.gz` to the package's `Cargo.lock`, then
run the release executable with the four fixture paths from the manifest.
`pnpm fixtures` fetches the corpus. Keep any changed dependencies, missing
fixtures, parser errors or instrumentation failures in the result record.

After creating that temporary package, restore the original files from the
repository root (replace the package path with your temporary directory):

```sh
projection_archive=scripts/perf/evidence/prepass-projection-6537
projection_package=/tmp/prepass-projection-repro
gzip -dc "$projection_archive/census.rs.gz" > "$projection_package/src/main.rs"
gzip -dc "$projection_archive/Cargo.lock.gz" > "$projection_package/Cargo.lock"
```

Decompress `construction-census.rs.gz` similarly when reproducing the separate
construction capture. The recorded sources, fixture hashes, original results
and qualification receipts remain the authority; this packaging did not
compile either harness or collect new measurements.

The additional harness can be reproduced as the retained
`prepass_construction_census` example on its recorded source, using the same
canonical parser. The [public medical archive](https://tib.eu/data/duraark/BuildingData/01_IFC/NBU_MedicalClinic_ifc.zip)
contains member `NBU_MedicalClinic/NBU_MedicalClinic_Eng-MEP.ifc`; the
[Snowdon fixture](https://github.com/LTplus-AG/ifc-lite/releases/download/fixtures-v1/fab102eb5f9152bc7053d7e4920a8b75d0d34683c834078f0735c88308eb00a4)
is also catalogued in `tests/models/manifest.json`. Their original download
receipts retain the exact bytes and SHA-256. These receipts describe download
qualification at capture time; the separate construction census records the
subsequent diagnostic, without claiming a browser load benchmark.

No production source, API, geometry, baseline, grammar, cache, error handling or
quality setting is changed by this record. The rest of #6537 and foreground
qualification of #6584 remain open.
