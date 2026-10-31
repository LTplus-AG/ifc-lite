# Registered scenario execution — Refs #7955, review of #8435

`tests/evidence/real-fixtures/witnesses.txt` requires five CLI and seven viewer
records. Each record is emitted after that scenario's final assertions. The
previously missing SketchUp, reverse-add refusal and primary-replacement records
are now emitted as well. Linear CLI comparison emits one record per authoring
tool only after all its assertions finish; each all-refused CLI scenario emits
its own record.

`check-retained-witnesses.mjs` checks native, CLI and viewer logs separately.
Legacy unscoped registrations retain native end-anchored matching. Scoped CLI
and viewer records must match an exact marker and have an object/array JSON
payload. Test names, marker prefixes and another lane's output do not count.
The CLI and viewer workflow steps preserve command failures with pipefail,
capture actual runner output and invoke the checker independently of test grep
or shard selection. Those logs are uploaded with the lane evidence.

Five regression tests pass without skips. In particular, each of the twelve
registered CLI/viewer records is removed in turn from an otherwise green log:
the actual checker CLI must exit 1 and name the missing record. Empty selections
also fail. The registered mutation disables the missing-witness error; the
revert oracle reports **OBSERVED**, with assertion failures (not load failures)
and restored witnesses green. The original real-fixtures helper oracle also
remains OBSERVED. Post-commit pre-handoff uses explicit main SHA
`92a277622e397c130b83cc15d509bb24a64d66d4`.

Actual Pop validation ran on source `51934e40da`, request
`auto-724446bdd4c54d428175efdf95605ee0`, job
`195eba8d-5546-43bf-874a-01bdf2aa4dfc`:

- Three CLI tests pass with no skips; the gate observes all five CLI records.
- All eighteen viewer tests pass; the gate observes all seven viewer records.
- A successful Playwright `--grep 'a real ArchiCAD export'` run emits one
  record, and the gate exits 1 naming the six missing viewer records.
- The first shard experiment was incorrectly constructed: with the repository's
  `fullyParallel: false`, Playwright shards by file and shard 1 ran all seven
  scenarios together. The gate correctly accepted all seven witnesses. The
  external wrapper exited 1 because it wrongly expected that complete log to
  fail; this is not a missing-witness escape. Original logs are preserved.

The corrected negative control completed with exit 0 on Pop:
request `auto-6172fdfc14394faaab712ab88907d17b`, receipt
`worker-state/jobs/916389a3-fddd-4f39-a3b5-33bd45ff5105/receipt.json`,
source `7b7217b4c0d9c7e73209000209363b3656560bd1`, source unchanged and
immutable evidence publication verified.

- `--fully-parallel --workers=1 --shard=1/2` ran four of the seven viewer
  scenarios successfully. The witness gate exited 1 naming the three missing
  records: federation-replaced, federation-reverse-add, and primary-replaced.
- CLI `--test-name-pattern='a SketchUp model'` ran one test successfully with
  no skips. The witness gate exited 1 naming the other four CLI records.

Together with the actual grep control above, these are measured filtering
failures, not just constructed log fixtures. Checker, scenario tests and
registry are identical between the two tested sources. Runtime source was
checked against the qualified `c9b69f3a01` engine without relabeling that engine's
provenance. The private Cargo target is deleted on exit.

The main merge brought a retained-file trigger using character-class glob
syntax unsupported by the path-coverage gate. Equivalent lowercase/uppercase
patterns preserve the intended match. The checker reads only witness files;
fixture inputs are explicitly covered by the narrowed native-adapter trigger.
Path coverage and test wiring pass. Node setup precedes native witness checks.
No ruleset was changed: native-adapter enforces these regressions and is required
by merge-when-green.sh, but is not yet repository-required (#8396).

Local pre-handoff passes its available gates. Its TypeScript, YAML and default
viewer checks are explicitly skipped because dependencies/bundle are absent;
the earlier Pop default-build receipt remains distinct from this follow-up.
