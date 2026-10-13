# #7543: an IDS boolean written as 1 or 0

Evidence for the fix to #7543: an IDS boolean written as `1` or `0` now matches the boolean it names.
Every output here comes from a run of the script beside it. No timing is claimed here.

## The builds

`make-builds.mjs` makes three builds of `@ifc-lite/ids` from this checkout's `packages/ids`.
They differ only in the three production files of the change:
`packages/ids/src/constraints/comparators.ts`, `xsd-cast.ts` and `xsd-lexical.ts`.

| Build | The three files from |
|---|---|
| `head` | this checkout |
| `20e2a5d6b` | 20e2a5d6b, the commit qualified in #7543 |
| `main` | the `<main ref>` you pass. The outputs here used fb5642432. |

The three files are the same at the merge base bad0dbdc3, at fb5642432, at b43067985 and at 596c892f1.
Each build links its `node_modules` to `packages/ids/node_modules`, so all three load the same `@ifc-lite/parser`.
That parser is read from `packages/parser/dist`, as in the package's own tests, so build the workspace first.
The builds go to a new folder outside the repository. The script deletes nothing.

## Commands

Run from the repository root. The outputs here come from Windows 11, Node 22.20.0 and pnpm 10.8.1.

```sh
E=docs/architecture/evidence/7543-boolean-one-zero
B=/tmp/7543-builds   # a new folder outside the repository
node $E/make-builds.mjs $B origin/main

# Acceptance domain: every changed function and the public functions that reach them.
node $E/acceptance-domain.mjs $B main head > $E/out/acceptance-domain-main-vs-head.txt
node $E/acceptance-domain.mjs $B 20e2a5d6b head > $E/out/acceptance-domain-20e2a5d6b-vs-head.txt

# The script from #7543, unchanged, and the enumeration probe. Both write their .ifc and .ids to fixtures/.
for b in main head; do for s in IFC2X3 IFC4 IFC4X3_ADD2; do
  node $B/$b/boolean-one-zero.mjs $s $E/fixtures/$s; done > $E/out/issue-script-$b.txt; done
for s in IFC2X3 IFC4 IFC4X3_ADD2; do
  node $E/enumeration-probe.mjs $B $E/fixtures/$s $s main head; done > $E/out/enumeration.txt

# The text of the new parsed-wall tests, as files.
node $E/dump-test-fixture.mjs $E/fixtures

# IfcTester and both builds on every fixture, then row by row.
C="boolean-one-zero enumeration wall-sv wall-sv-p wall-enum wall-enum-p"
for s in IFC2X3 IFC4 IFC4X3_ADD2; do python -I $E/ifctester-run.py $E/fixtures/$s $C; done > $E/out/ifctester.txt
for b in main head; do for s in IFC2X3 IFC4 IFC4X3_ADD2; do
  node $E/run-files.mjs $B $b $E/fixtures/$s $C; done; done > $E/out/ifclite.txt
node $E/compare-verdicts.mjs $E/out/ifctester.txt $E/out/ifclite.txt > $E/out/compare.txt

# The ids-authoring lints, with each build of @ifc-lite/ids.
pnpm --filter @ifc-lite/ids-authoring build
for b in main head; do node $E/authoring-lints.mjs $B $b > $E/out/authoring-lints-$b.txt; done
```

The revert oracle needs a clean working tree, so its outputs go outside the repository first.
They were then copied to `out/oracle/`.

```sh
O=/tmp/7543-oracle; mkdir -p $O
node scripts/check-test-revert-oracle.mjs --base origin/main > $O/all.txt 2>&1
for f in comparators xsd-cast xsd-lexical; do
  node scripts/check-test-revert-oracle.mjs --base origin/main \
    --only packages/ids/src/constraints/$f.ts > $O/only-$f.txt 2>&1; done
for m in xsd-cast-gate-line xsd-lexical-string is-boolean-literal; do
  node scripts/check-test-revert-oracle.mjs --base origin/main \
    --mutation $E/mutations/$m.patch > $O/mutation-$m.txt 2>&1; done
```

In the runs here, `origin/main` was written `upstream/main`, the name of LTplus-AG/ifc-lite in this clone.
The oracle ran on a commit with this commit's code and tests. Its outputs were copied here afterwards.
The oracle ignores `docs/`.
The other outputs leave `stderr` out. For the script from #7543 it holds only the parser's two notes,
"No buildings found in spatial hierarchy" and "No storeys found in spatial hierarchy".
The other scripts wrote nothing to it.
In the committed outputs, the checkout's folder reads `<repo>`.

## What each file shows

- `out/acceptance-domain-main-vs-head.txt`: each function called on both builds with the same inputs.
  No input that returned on `main` throws on `head`.
  Every changed output of a public function is a `1` or `0` against a stored value that is the boolean it names.
  `validateIDS` is held to that per entity row.
  One input widens: `isValidLexicalForXsType` with a `Symbol` threw on `main` and returns `false` on `head`.
  The calls that threw on both builds threw the same error on both. The output lists them by error.
  Each one has a literal or constraint value that is not a string.
- `out/acceptance-domain-20e2a5d6b-vs-head.txt`: what the last commit alone changes.
  It is the audit's reading of values that are not strings, back to `main`'s answers.
  Two odd objects (`Object.create(null)` and one whose `toString` throws) throw again inside
  `isValidLexicalForXsType`, as on `main`. Through `auditIDSStructure` they throw on all three builds.
- `out/issue-script-main.txt`, `out/issue-script-head.txt`: the script from #7543 under three schemas.
  On IFC4, each is line for line the matching output in #7543.
- `out/enumeration.txt`: 14 enumeration requirements on one wall, on both builds, with the audit's issues.
- `out/ifctester.txt`, `out/ifclite.txt`, `out/compare.txt`: IfcTester against both builds on every fixture.
  `head` matches IfcTester on every row but two. Those are IFC2X3 task rows.
  There, IFC Lite reads an IFC2X3 `IfcTask` attribute at its IFC4 position, a separate defect that `main` has too.
  IfcTester raises `IndexError` on a model without an `IfcProject`, so `wall-sv-p` and `wall-enum-p` add one.
  Both builds give the same rows with and without it.
- `out/authoring-lints-main.txt`, `out/authoring-lints-head.txt`: the `@ifc-lite/ids-authoring` lints on `1` and `true`.
  The lint lines are the same with both builds.
  The checker lines show where the lints now disagree with the checker.
- `out/oracle/`: the repository's revert oracle on the three changed test files (95 tests).
  With `--mutation`, the report still lists all three production files under "reverted".
  Only the patch is reverse-applied, as the failure counts show.
  The oracle prints how long each test run took. Nothing is claimed from those numbers.
  In its summary it puts a long dash between a run's kind and its counts. The copies here write a colon,
  and drop trailing spaces and the empty last line, so that `git diff --check` stays clean.
- `mutations/`: the patches for the `--mutation` runs, each written as a diff from the mutant to `head`.

## Tools

IfcTester: the `ifctester` package 0.8.3 on `ifcopenshell` 0.8.4, with Python 3.13 (`pip install ifcopenshell ifctester`).
`ifctester-run.py` opens each IDS with `validate=True`, so it is checked against the IDS 1.0 schema first.
