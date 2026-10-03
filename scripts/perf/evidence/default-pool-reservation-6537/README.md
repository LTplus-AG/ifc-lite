# Default-pool reservation attribution (#6537, PR #6730)

**These four default SDK routes do not exercise a different initial reservation.**
The captures establish produced CPU-output identity and source-path eligibility,
with complete retained diagnostics. They establish no speed improvement,
affected-path performance verdict, physical peak-memory reduction, or IFC fidelity.
This evidence does not close #6537 or qualify PR #6730 for merge.

The frozen comparison is BASE `baa7d34db1be4bc8bf0b3479df33275da3130fc6`
versus CAND `7776e5b2f04b071b6e5aae7f4f5d1a158320f36d`.
The evidence-only packaging starts from main
`29bdcc174e862645193381d7aaef01e54db2fbe7`; it changes no production code.
The original attribution JSON is byte-for-byte inside [eligibility.json.gz](eligibility.json.gz).

## Why the candidate is ineligible for attribution here

The candidate bounds speculative index requests to 65,536 entries, retaining
`source_bytes / 50` for smaller inputs. Its changed sites are
`ColumnarEntityIndex::from_scan`, decoder `build_entity_index`, and the
non-prebuilt branch of `IfcAPI::pre_pass_streaming_impl`.

| Public fixture | Source bytes | Captured default route | Reservation effect |
| --- | ---: | --- | --- |
| AC20-FZK-Haus | 2,526,544 | Below the cap's activation threshold | Same requested capacity |
| ISSUE_129 | 12,030,684 | Eight shard scans; prebuilt columns delivered | Changed constructors bypassed; prepass staging already zero on BASE |
| ISSUE_053 Holter | 177,465,622 | Eight shard scans; prebuilt columns delivered | Same bypass and existing zero staging |
| O-S1 architectural | 342,657,851 | Eight shard scans; prebuilt columns delivered | Same bypass and existing zero staging |

The default shard threshold is 8 MiB. `geometry-parallel.ts` stitches scanned
columns and delivers the index; `geometry.worker.ts` installs it through
`setEntityIndex`, whose JS binding uses `ColumnarEntityIndex::from_owned_columns`.
Batch processing reuses that cached index. `EntityDecoder::build_index` returns
when an index is already installed. The sharded prepass accepts the prebuilt
index and requests zero unused staging capacity on both source revisions.
The archive includes both revisions of these modules and the complete
reservation patch, including the prepass change.

This conclusion covers these four captures. It does not cover every model:
an input above the reservation cap's activation threshold but below the shard
threshold could use the changed path. Establish actual affected-path execution
before measuring such a cohort; do not disable default sharding to manufacture
a claim about default large-model loads.

## What was actually captured

The v9 BASE and v10 CAND runs each load each fixture first in a fresh headless
Chrome process/context using the default eight-worker SDK geometry stream. The raw runtime
records Chrome `153.0.8010.36`, SharedArrayBuffer, cross-origin isolation,
visibility, worker identities, stream drain, disposal and owned cleanup.
Both runs complete all four bounded captures; the produced CPU hashes and
retained diagnostic records match. This is a source/correctness inspection,
not an interleaved timing cohort. Raw time fields do not change that status.

The earlier v8 architecture capture hit its original 5 GiB owned-RSS ceiling
and remains refused, with its partial receipt, abort witness, captured browser
console messages and cleanup.
The later 8 GiB inspection is separately recorded, not a waiver or replacement
sample in the original cohort. Guardian JSON receipts for all three runs
are retained. Each original guardian stdout log is zero bytes and is preserved
as such; those empty files contain no operational evidence. The refusal and
cleanup witnesses are in the fixture/report JSON records, while browser console
messages are in the fixture JSON. Their sampled process-tree RSS sums are not
physical peak memory.

The SDK consumer does not establish full metadata, viewer/render readiness,
GPU uploads, pixels, picking or federation. Equal produced-output hashes do
not establish faithful IFC output. Complete warnings, omissions and known
`KernelError` diagnostics remain in the raw files. The diagnostic census has
documented batch aggregation, cached-hit omissions and capped host details;
its counts are not a complete operation or affected-product census.
Browser response identity uses observed request/status and an immutable-origin
post-drain refetch; it is not a capture of raw browser-loaded response bytes.

## Archive and independent inspection

[raw-diagnostics.tar.gz](raw-diagnostics.tar.gz) retains 112 files: 90 verbatim
originals plus frozen source snapshots, the reservation patch and archival
inspection/packaging code. Original files total 20,330,658 bytes; all member
payloads total 20,985,838 bytes. No model files or executable build bundles
are included. The source snapshots are evidence, not new production modules.

The originals include all v8/v9/v10 reports and fixture JSONs, all three
guardian receipts/logs, producer v5, candidate reuse v3, inspectors v11/v12/v13,
their adapter/runtime qualifications and supporting build/reuse receipts.
Older prospective status fields and source constants remain unchanged;
actual v13 leases and run receipts distinguish the later executed inspection.

[SHA256SUMS.gz](SHA256SUMS.gz) indexes every uncompressed archive member after
decompression. Its checksum text is unchanged.
[artifact-index.json.gz](artifact-index.json.gz) adds byte counts and original
paths or git revisions. [archive-validation.json.gz](archive-validation.json.gz)
preserves the original validation JSON verbatim. It records the original
container hashes and lossless readback; its `files.SHA256SUMS` entry describes
the reconstructed, uncompressed checksum file. The two new gzip containers
have these independent outer hashes, avoiding a validation file hashing itself:

| Container | Bytes | SHA256 |
| --- | ---: | --- |
| SHA256SUMS.gz | 5160 | c9be79627cf5bba6655ceea5479027152272885086d457bc50e51d7757c64285 |
| archive-validation.json.gz | 591 | beb6fd288265736b0db49e2a093587a137156d76db93476348e167946093b49a |

Both decompress byte-for-byte to their original metadata files, with gzip
mtime zero and no stored filename. The original three gzip archives are
unchanged, including all 112 tar members. Gzip timestamps and tar
ownership/timestamps are normalized; every original payload remains exact.
Validation only decompressed the archive and compared its members, hashes and
standalone attribution bytes. No build, test, browser load or measurement ran
while packaging this disposition.

From the repository root, reconstruct the metadata and extract into a separate
inspection directory:

```sh
reservation_evidence="$PWD/scripts/perf/evidence/default-pool-reservation-6537"
reservation_inspection="$(mktemp -d)"
gzip -dc "$reservation_evidence/SHA256SUMS.gz" > "$reservation_inspection/SHA256SUMS"
gzip -dc "$reservation_evidence/archive-validation.json.gz" > "$reservation_inspection/archive-validation.json"
tar -xzf "$reservation_evidence/raw-diagnostics.tar.gz" -C "$reservation_inspection"
(cd "$reservation_inspection" && sha256sum -c SHA256SUMS)
```

`source-inspection/frozen-source-index.json` identifies git
blobs and hashes; `frozen-source/reservation-candidate.patch` exposes all changed
reservation sites. The source analysis is an attribution review, not a test
that treats a string's presence as proof of behavior.
