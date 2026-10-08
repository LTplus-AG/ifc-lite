# IDS Studio evaluation datasets (P-08)

Datasets for evaluating the IDS Studio agent. The plan is in
`docs/architecture/ids-studio/03-architecture/06-ai-agent.md` §9; the code that
reads and checks these files lives in `scripts/ai-eval/ids/`.

| Set | File | Cases | What a case is |
|---|---|---|---|
| E2 | `e2/cases.jsonl` | 307 (187 pass, 120 fail) | A plain-language requirement written for one buildingSMART corpus `pass-`/`fail-` case. The agent writes an IDS from the description. It is scored by validating that IDS against the paired corpus IFC: the case counts as agreeing when the verdict equals `expected`. |

## Licence

The buildingSMART corpus under `packages/ids/src/__corpus__/buildingsmart-ids`
is CC BY-ND 4.0. The datasets refer to corpus files by path and never copy or
change them. The descriptions are our own
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

`node --test scripts/ai-eval/ids/*.test.mjs` checks the datasets against the
corpus on disk. CI runs the same files through the `scripts/` glob catch-all
in the node-tests job.
