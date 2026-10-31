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

An additional actual-run validation request is queued on Pop:
`auto-724446bdd4c54d428175efdf95605ee0`, job
`195eba8d-5546-43bf-874a-01bdf2aa4dfc`, tested source `51934e40da`.
It will check full CLI/viewer logs, then require successful Playwright grep and
partial-shard runs and a successful filtered CLI run to FAIL the witness gate.
These runtime results are pending, not claimed as observed. Runtime source is
checked against the previously qualified `c9b69f3a01` engine; only tests, CI and
evidence changed. The supplied private Cargo target is deleted on exit.

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
