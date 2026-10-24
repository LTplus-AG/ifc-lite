# Controlled large IFC preparation for #8042

**Unexecuted and unmeasured. No performance pass.** This is standalone parent
preparation, not a CI gate. No builds, tests, IFC reads/loads or mutations were
run while preparing this code. Follow `diff-e2e.md` for the reviewed protocol;
this recipe does not replace proof, output parity, noise, provenance, idle-host
or geometry requirements. No production CLI change is needed.

The v2 recipe changes only `Name` through canonical CLI `mutate --type`.
It does not regenerate GlobalIds or fabricate renamed-path coverage. The large
real pair legitimately has zero content matches for every benchmark option;
the existing real demo and synthetic stress exercise content/renamed paths
independently. This is a controlled derived IFC revision, not an independently
authored revision or external geometry ground truth.

The source is the 342657851-byte Bouwkundig IFC with SHA256
`e91ddbbd672bbde946af14631de4c732f0cf8a7cfae5dbbf06fbeab03b5c46df`.
Selection uses the exact CLI `createHeadlessContext` and
`bim.query().byType(...).toArray()` API. The most populous nonempty query among
`IfcWall`, `IfcWallStandardCase`, `IfcSlab`, `IfcDoor`, `IfcWindow` wins; ties
follow that order. These are canonical queries, including their subtype
expansion: an `IfcWall` query can include `IfcWallStandardCase`. The recipe
records all five query populations, the chosen query class, exact sorted target
express IDs, their actual EXPRESS classes, original/new keys (identical), old
Names, source attributes and requested new Name. Every target must have a
different old Name and belong to the comparable scope. It fails on empty or
duplicate targets. It requires at least half the comparable objects and at
least 100 objects to remain unchanged. These are explicit recipe guards, not
performance acceptance thresholds. It never silently chooses a smaller class
when the most populous class fails a guard.

Each generation is one fresh child running the built canonical CLI:
`mutate SOURCE --type CHOSEN_CLASS --set 'Name=IFC-Lite #8042 controlled Name revision' --out NEW_FILE --json`.
The CLI must report exactly the selected target count and no skips/warnings.
Inspection reissues the same canonical query and checks the exact IDs. Parsed
target attributes must equal their source attributes with only the schema's
`Name` slot changed. Identity keys cannot change, every selected fingerprint
must change, and every other fingerprint must remain identical. No invented
STEP parser, custom mutation writer or guessed geometry is involved.

Selection/inspection use complete-scan diagnostics, full `store.entityCount`,
source-index count, schema-derived `IfcObjectDefinition` count and actual
comparable count. Counts are separately reported: comparables require a
nonempty GlobalId and the general CLI adapter can retain unknown vendor types.
This preparer rejects unknown schema types rather than pretending to certify
their subtype membership. Equality of comparable/subtype counts is observed,
never assumed. Author, organization, authorization, originating system,
implementation level, schema and original description prefix must survive.
Both full parsed output headers are retained. The source fixture is never
written and its SHA256 is checked again at completion. Each IFC is bounded to
512 MiB; fingerprint inputs to one million rows.

The private TS oracle evaluates actual reparsed file fingerprints with all
three exact `OPTIONS` from `diff-e2e-protocol.mjs`. For each option it requires
`modified = number of selected targets`, `unchanged = comparable count minus
targets`, zero added/deleted, zero content matches (empty kind/tier distribution),
and zero split/merge/successor claims. `expected.json` records exact modified
IDs, observed modified fraction, unchanged count, all result counts and
content distributions, and a full result proof hash preserving reference
identity, Map/array order and optional fields. No fingerprint expansion is used.

Repeat generation starts from the same source in another fresh CLI process.
The following must agree across the two generated outputs:

- Every full indexed entity record's original bytes. SHA256 consumes the
  canonical index's records in file order, framed by express ID, type and byte
  length; no entity or attribute is filtered out.
- Every byte outside those records after the generated header, including
  `DATA`, inter-record trivia and the footer, with gap lengths framed.
- Actual canonical fingerprints (tagged proof digest, including absent versus
  undefined fields), serialized fingerprints and all three oracle result proofs.
- Full scan/count evidence and every parsed header field except `timeStamp`.

For each generated file the built parser's canonical `generateHeader`, supplied
that file's complete parsed header values and timestamp, must reproduce its
**exact byte prefix**. This accounts for all header bytes; it does not normalize
an unknown prefix or discard unrecognized differences. Combined with indexed
record and gap hashing, every file byte is accounted for. Missing timestamps,
unreproducible prefixes, record/gap/fingerprint/result differences or other
header-field changes fail and retain evidence. No retry or hidden exclusion is
offered. The repeated output and source are also checked against 512 MiB.

**Derivation is explicitly not claimed to be byte deterministic.** Canonical
CLI export uses wall-time `FILE_NAME.time_stamp`. There is no clock patch,
timestamp override, or rewritten IFC byte. Both whole-file SHA256s, actual
parsed headers, differing parsed fields and observed whole-file byte equality
are recorded. Unequal file hashes require an actual timestamp difference;
timestamp alone is never used to excuse differing records or unexplained bytes.
No requirement is added to make canonical timestamps identical.

After repeat qualification, the **first generated file** is published as
`controlled-revision.ifc` using atomic no-replace publication. Its exact size
and SHA256 are recorded as `frozenHeadForBothArms`. The parent must freeze this
ONE file's exact bytes, source, recipe and expected-result receipts into the
reviewed protocol bindings before timing. Both A/B arms must use that same
frozen source/head pair; do not regenerate per arm. Existing verifier/cohort
identity and exact-byte checks remain mandatory throughout measurement. The
preparation-only timestamp comparison changes none of those requirements.

One fresh child owns each load/mutation, exiting before the next. Children have
12 GiB V8 old-space, a 30-minute deadline and 256 KiB log limit. The single outer
admission supplies real memory/process bounds; V8 heap is not a host limit.
Commit the harness first. The following proposed command has not been submitted;
run outside any existing reservation on the parent's prepared host:

```bash
/home/louistrue/build-workers/run-heavy \
  --cwd /home/louistrue/dev/ifc-diff-completion --kind ordinary \
  --storage-task diff8042-large-revision-v2 --cpu 2 --memory 16 --timeout 18000 \
  --artifact /home/louistrue/build-workers/task-output/diff8042-large-revision-v2/evidence.json \
  -- node /home/louistrue/.t3/worktrees/ifc-lite/t3-5588b566/scripts/perf/prepare-diff-large-revision.mjs \
  /home/louistrue/dev/ifc-diff-completion \
  '/home/louistrue/dev/ifc-diff-completion/tests/models/various/O-S1-BWK-BIM architectural - BIM bouwkundig.ifc' \
  /home/louistrue/build-workers/task-output/diff8042-large-revision-v2
```

The output's parent directory must exist. The script exclusively creates a new
output directory and owned scratch directory; used destinations refuse reuse,
even after failure. Do not overwrite v1 receipts or failure artifacts. Preserve
the original admission receipt after interruption; never resubmit an uncertain
outcome blindly. Compact evidence, recipe, expected results and bounded logs
remain outside source. Success removes owned scratch IFCs/rows; failure retains
owned scratch and logs for diagnosis. `evidence.json` records source/output/
recipe/expectation SHA256s, exact successful command argv, runtime, source
commits, counts and repeat evidence. A failure remains `failed-unmeasured` with
its error and retained scratch location; it cannot qualify as preparation.

Runtime behavior, selected population/fraction, actual header reproduction,
memory/deadline sufficiency and source attribution remain unvalidated until
the parent's admitted execution. Built-byte freshness and full transitive
runtime inventory remain the parent's existing build-receipt obligation; this
script hashes the CLI entry, not its full dependency graph. It cannot establish
fleet admission by knowing a commit. Publish compact evidence and reconcile the
owning storage task before release, preserving source and original receipts.
