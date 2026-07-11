---
'@ifc-lite/cli': minor
'@ifc-lite/mcp': minor
---

Layer PRs surfaces:

- **cli**: new `layer` namespace (`create`, `status`, `publish`, `diff`, `merge --preview`, `log`, `bake`, `revert`, `rebase`) and `ref` namespace (`list`, `create`, `move`, `protect`) over a local content-addressed layer store, with stable exit codes (0 clean, 2 conflicts, 3 required-check/policy failure, 4 scope violation).
- **mcp**: draft-layer tool family — `create_draft_layer`, `draft_apply_ops` (write-time scope enforcement), `publish_layer` (publish-time claim-vs-ops verification), `diff_layer`, `dry_run_merge`, `list_conflicts`, `request_review`, `add_review_feedback`, `get_review_feedback`, `respond_to_review`.
