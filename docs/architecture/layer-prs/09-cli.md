# 09: CLI and CI

## 9.1 Command reference (`packages/cli`, new `layer` namespace)

```shell
ifc layer create   --base <ref|stack|file.ifcx> --intent "..." [--scope "<capability>"]
ifc layer status                                   current draft: op count, scope usage
ifc layer publish  [--check <spec.ids>=<report.json>]... [--sign <key>]
                                                   freeze + hash; stamps verified check
                                                   evidence (pass/fail derived from the
                                                   `ifc ids --json` report, spec + report
                                                   content-addressed); prints layer id
ifc layer diff     <L> [--against <ref|L2>] [--components] [--json]
ifc layer merge    <L> --into <ref> [--preview] [--resolve ours|theirs:<selector>] [--allow-unrelated]
ifc layer checks   <L|ref> [--ids <spec.ids>] [--required-only]
ifc layer log      <ref> [--graph] [--author kind=agent]
ifc layer revert   <L>                             emits inverse-op layer
ifc layer rebase   <L> --onto <ref>
ifc layer bake     <ref> -o composed.ifcx          tombstone-free export for foreign tools
ifc ref            list|create|move|protect        ref + policy management (10 §10.4)
```

All commands emit `--json` for scripting; the diff/MergePlan JSON is byte-identical to what the MCP tools and the review UI consume.

## 9.2 GitHub Action (free funnel)

`ltplus-ag/ifc-layer-action`: on push of `.ifc`/`.ifcx` to a repo, parse, publish as layer, diff against the ref, run IDS checks, comment the PR with the structured diff + check table, upload the composed preview to the embed viewer (`@ifc-lite/embed-sdk`). "Models get PRs like code" with zero registry dependency: this is the headless-CI concept absorbed as a byproduct, and the lowest-friction adoption wedge for developer-adjacent AEC teams.

## 9.3 Exit codes and budgets

Stable exit codes (0 clean, 2 conflicts, 3 required-check failure, 4 scope violation, 5 unrelated base — the candidate declares a base that matches nothing on the target ref; override with `--allow-unrelated`) so CI gates compose. CLI cold-start budget < 300ms (matches existing CLI discipline).
