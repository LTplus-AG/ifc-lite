# Independent slice registration (#7955)

A new slice adds `tests/evidence/<slice>/oracle.json` alongside its patch:

```json
{
  "issue": 7955,
  "key": "rust/example/src/new_module.rs",
  "mutation": "tests/evidence/<slice>/behaviour.oracle.patch",
  "test": "rust/example/tests/witness.rs",
  "why": "Keep the new API while reversing the behavior the witness observes."
}
```

`key` must be a production file added in the PR. `test` is optional: without
it the oracle selects the changed test collection. An explicit witness can be
unchanged. Paths must resolve to files inside the checkout. Discovery reads only
manifests added against the merge base; existing slice manifests are inert.
Invalid registrations fail with the manifest path and a remedy.

CI appends every registration. Repeated `--mutation` options run independent
experiments, each restored before the next, and every experiment must pass.
Following `--test` options belong to that mutation; leading test options are
shared. Existing single-mutation callers retain their behavior.

Before handoff, commit and run `node scripts/pre-handoff.mjs --base origin/main`
through the fleet when its witnesses need heavy validation. The command checks
CI invariants, discovers registrations, and runs each mutation with a two-minute
hard timeout per runner, restoring and rerunning the witness green. A timed-out
mutation fails with `test hangs under mutation: likely leaked handle/timer`;
assertion failures, import/build failures and unobserved mutations are distinct.
Unavailable dependencies and absent viewer dist are explicitly SKIPPED; explain
unverified coverage in the handoff. Runtime non-browser witnesses are supported
by this local bounded mode; specialized browser/type-only witnesses fail with a
remedy to run the existing specialized oracle separately.

`dead-clauses.json` records the exact main commit and 53 removed sentinel paths,
each verified present with `git cat-file -e`. Two absent sentinels remain in the
workflow: their paths could be added again, so presence on main cannot prove
them dead. All non-#7955 conditional clauses retain their order and arguments.

The manifest here exercises discovery itself: the mutation changes added-file
selection to modified-file selection. The fixture tests must reject that loss
of discovery and validation, and pass again after restoration.
