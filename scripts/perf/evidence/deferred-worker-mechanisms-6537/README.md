<!-- This Source Code Form is subject to the terms of the Mozilla Public
     License, v. 2.0. If a copy of the MPL was not distributed with this
     file, You can obtain one at https://mozilla.org/MPL/2.0/. -->

# Deferred geometry-worker mechanisms (#6537)

Disposition: retain the affinity pilot as an unshipped experiment and defer
compact geometry-worker source packets. Neither mechanism has a qualified
whole-load improvement. This evidence-only record changes no production code,
parser grammar, runtime, worker count or ownership policy. It does not close
#6537 or establish private-file, all-model, physical-memory or lifetime success.

The [artifact index](ARTIFACTS.md) records exact archived and
original SHA-256/size. Every payload uses lossless gzip with zero timestamp.
Schedules, row order, contaminated rows and original dispositions remain
unchanged. Original per-sample JSON objects match their archived JSONL rows;
duplicate JSON files are omitted. Decompression does not execute a capture. The two original worker-diagnostic
`.json.gz` payloads retain their exact bytes inside an outer `.gz`; they need
two decodes to inspect JSON, as documented in the artifact index.

## Affinity admission: defer shipping

The [saved independent source review](review/independent-source-review.md.gz)
read canonical dispatch, recovery, worker FIFO, prepass routing and three
instrumented traces. It proposes delaying ownership only for previously unseen
true affinity keys until a real slice-completion credit becomes available.
It does not infer cost from job counts or change the existing key grammar.
Earlier bounded advisory messages have no saved raw Astra transcript; this
archive does not invent one or attribute the saved review to that model.

[The frozen prototype patch](review/qualified-prototype.patch.gz) belongs to
`982da209b3a07da924d4c0af566aebbe7fe749e9` against
`9400cb6c952ba200e165c1dadbd95f9d28fca927`. It preserves first-wave dispatch,
sticky assigned keys, collision behavior, FIFO and canonical style/index
readiness. One fixed bundle admits at most sixteen previously unowned keys.
Credits require the current worker and posted sequence; recovery must actually
replay successfully before a replacement releases its credit. Deferred end,
failed post, cancellation and abandonment retain their ownership cleanup.
This record neither reapplies that patch nor adds a new tuning experiment.

[Historical qualification](qualification/qualification.json.gz) records 62
passing pool/recovery controls, including ten admission cases, the normal
61-task build and exact root typecheck. [The production inverse](qualification/root-oracle.json.gz)
records ten passes, then two passes/eight assertion failures, then ten restored
passes through the root Turbo dependency graph. Logs preserve actual runtime
stages separately. The browser comparison assets used the same `03941554`
WASM on both sides; no compiled runtime is copied into this archive.

The two attempted cohorts remain separate:

| Attempt | Retained rows | Disposition |
| --- | --- | --- |
| [v1](affinity-v1/runs.jsonl.gz) | Eleven of fifty planned; ten clean A/A rows | [First A/B baseline contaminated](affinity-v1/incomplete.json.gz); no candidate A/B comparison |
| [v2](affinity-v2/runs.jsonl.gz) | Forty-six of fifty planned; forty-five environmentally valid | [Last retained Snowdon row contaminated](affinity-v2/incomplete.json.gz); incomplete corpus, no replacement |

[The original v2 identity audit](affinity-v2/initial-identity-audit.json.gz)
refused a flat-only equivalence claim on the heavy families. Later instrumented
O-S1 loads explain why flat counts alone were insufficient: occurrences moved
between flat output and instanced shards. [The retained world comparison](os1-diagnostic/worldgeometry-euclidean-derived.json.gz)
reports matching occurrence multiplicity, topology and appearance while also
reporting nonzero reconstructed position and normal differences. It is not
byte identity or execution of the canonical pre-instancing precision gate.
The larger original per-piece array chunks remain outside this compact archive;
these reports alone are not independently reproducible all-array proof.
The [earlier contaminated diagnostic](excluded-diagnostic/runs.jsonl.gz) is
preserved independently, not silently replaced by the later diagnostic.

Before reconsidering shipment, qualify all retained occurrences through the
actual flat/instanced precision and appearance contract, including the original
pre-instancing operands; preserve source IDs, picking and owner selection.
Then complete a source-matched fresh-first-file cohort with actual full-ready
and GPU witnesses, uncontaminated A/A and interleaved A/B controls, and bounded
held-job bytes/copy accounting. Worker-local slice completion alone is
insufficient. Retain repeated-key/collision/style/replacement/failed-post/end/
abort controls and unchanged watchdog limits. Defer if full readiness remains
inconclusive, CPU staging grows materially, or correctness cannot be explained
without weakening canonical geometry or liveness rules.

## Compact source packets: defer implementation

The [O-S1 forward-source census](compact-source/census-os1.json.gz) and
[provenance](compact-source/census-os1-provenance.json.gz) use the canonical
scanner, parser and index on actual dispatched root sets. They retain every
original referenced record and offset in their accounting. They show potential
record-byte sparsity, not a safe worker packet or observed runtime-access union.
Their source is `5101bf33e053d1a4f1af6d86df4bda59a20ec6bb`, Rust tree `14b997e`;
the dispatched root sets come from the frozen affinity diagnostic pair.
Diagnostic parsing/closure times are not worker-pool saved time.

The census excludes inverse/type scans, setup, header reads, existing cached
contexts and future recovery. Maximum reached original offsets remain near
the whole file's end. Concatenating reachable records would invalidate the
canonical global-offset index; allocating sparse storage to that high-water
address could erase the hoped-for capacity saving. Forward closure also does
not establish malformed-input or unobserved-reference completeness.

Before any producer prototype, record a bounded conservative dependency/access
contract that includes direct source reads, setup and replay. Preserve exact
IFC grammar, source-session ownership and one canonical load/geometry path.
Unknown dependencies must be explicit experimental refusal, not truncated
geometry. Prove either original-offset addressability without whole-file
allocation or one canonical validated accessor/remapping contract. Count
packet construction, overlapping records, copies and retained lifetimes before
claiming less storage. Reuse iterative/memoized bounded reference traversal;
never replace a missing closure proof with an unbounded walk.

Only after those prerequisites should a separate prototype face real parser,
placement/style/void/instance, cancellation/recovery and fresh full-ready
controls. Reject that prototype if completeness requires unsafe fallback,
original-offset capacity or construction/copy work erases the saving, or the
whole-load result does not improve beyond controls. This is a new feasibility
question, not permission to repeat the rejected #1445 shared-index conversion
or broader construction-sink grammar rewrite.

## Inspecting the archive

From the repository root:

```sh
gzip -dc scripts/perf/evidence/deferred-worker-mechanisms-6537/affinity-v2/runs.jsonl.gz
gzip -dc scripts/perf/evidence/deferred-worker-mechanisms-6537/compact-source/census-os1.json.gz | sha256sum
gzip -dc scripts/perf/evidence/deferred-worker-mechanisms-6537/os1-diagnostic/base-worker-diagnostics.json.gz.gz | gzip -dc
```

Compare with `originalSHA256` in the artifact index. The archive preserves raw
reviews, censuses and attempts, not new measurements or an optimization claim.
