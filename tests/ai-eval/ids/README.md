# IDS Studio evaluation datasets (P-08)

Datasets for evaluating the IDS Studio agent. The plan is in
`docs/architecture/ids-studio/03-architecture/06-ai-agent.md` §9; the code that
reads and checks these files lives in `scripts/ai-eval/ids/`.

| Set | File | Cases | What a case is |
|---|---|---|---|
| E2 | `e2/cases.jsonl` | 307 (187 pass, 120 fail) | A plain-language requirement written for one buildingSMART corpus `pass-`/`fail-` case. The agent writes an IDS from the description. It is scored by validating that IDS against the paired corpus IFC: the case counts as agreeing when the verdict equals `expected`. |
| E4 | `e4/cases.jsonl` + `e4/ids/*.ids` | 24 tasks on 5 input documents | An edit task: an input IDS, an instruction, and the IDS expected after the edit. `changes` lists the kinds of edit, such as `restrict-value` or `add-specification`. |
| E5 | `e5/cases.jsonl` | 19 | An adversarial input (a request, a requirement document or an IFC string) and the expected behaviour. The behaviour is one of three. `reject`: an invented property set or class appears in `mustNotEmit`, and the schema test proves the name is invented. `unresolved`: a geometry, relationship, uniqueness or count statement is marked unresolved with a category. `ignore-injection`: the embedded instruction is ignored and the requirements in `mustCover` are still authored. |

## Licence

The buildingSMART corpus under `packages/ids/src/__corpus__/buildingsmart-ids`
is CC BY-ND 4.0. The datasets refer to corpus files by path and never copy or
change them. The descriptions, edit tasks and adversarial inputs are our own
work, released under the repository's licence. They contain no client data and
no vendor names.

## Review status

Every E2 description has `reviewed: false`. Before E2 numbers are published,
someone has to review the descriptions by hand: check each one against its
IDS, rewrite it in an information manager's wording, and set `reviewed: true`.
This task is tracked in `docs/architecture/ids-studio/worklog/P-08.md`.

## Conventions in E2 descriptions

- A description names the IFC class in brackets, for example "walls
  (IfcWall)". It also gives the data type where the oracle checks it, for
  example "a text label (IfcLabel)".
- Unless a description says "optional check", the specification is
  *required*: the model must contain at least one applicable element. This is
  the IDS default.
- Values are quoted exactly. Lengths are in metres, matching the SI units IDS
  uses.

## Checks

`node --test scripts/ai-eval/ids/*.test.mjs` checks the datasets. It checks E2 against
the corpus on disk. It runs the E4 IDS files through the parser and the audit.
It checks the invented names in E5 against the IFC schema tables. The E4/E5
checks need the built packages (`pnpm turbo build --filter=@ifc-lite/ids...`).
In CI, the node-tests job runs the same files through its `scripts/` glob
catch-all after it downloads the build output.
