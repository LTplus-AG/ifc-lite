# 06: Agent Integration (MCP)

## 6.1 Principle

There is no write API that targets a published layer or a ref. Every mutation, from any client (`@ifc-lite/mcp`, viewer, CLI, SDK), lands in a draft layer. Agents are not a special case with extra restrictions: they are the *normal* case of the only write path that exists. This symmetry is what makes the audit trail trustworthy.

## 6.2 Draft lifecycle

```text
create_draft_layer(base, intent, scope)   draft is a CollabSession bound to base
  └─ n × write tools (existing 47, re-targeted to the draft)
  └─ dry_run_merge(draft, into)           optional, any time
publish_layer(draft)                      freeze: minimal layer + tombstones, canonicalize,
                                          blake3, manifest, run declared checks
request_review(layer, into, reviewers?)   opens the PR object on the registry
```

A draft may be co-edited live by humans and agents in the same CRDT session (`author.kind: hybrid`). A long-running agent task may publish a *stack* of small layers (one per sub-task) sharing a `session` id: reviewable individually, mergeable as a group.

## 6.3 New tool family (added to `packages/mcp`)

| Tool | Notes |
|---|---|
| `create_draft_layer(base, intent, scope)` | scope is a capability expression (07); rejected if it exceeds the session token's grants |
| `publish_layer(draft_id)` | returns layer id + check results |
| `diff_layer(layer_or_draft, against?)` | structured diff, same JSON the review UI consumes |
| `dry_run_merge(layer_or_draft, into)` | MergePlan preview: conflicts + would-fail checks, no side effects (pattern: `extensions/dryrun/`) |
| `list_conflicts(layer, into)` | conflict records only |
| `request_review(layer, into, reviewers?)` | creates/updates the PR object |
| `get_review_feedback(review_id)` | BCF topics + per-entity decisions, structured for the agent to act on |
| `respond_to_review(review_id, draft_id)` | opens a follow-up draft on the same base; publishes as a child layer of the PR |

`get_review_feedback` + `respond_to_review` close the loop: reviewer rejects 12 of 400 entities with a BCF comment, the agent reads the structured feedback, fixes, republishes. The PR becomes a genuine conversation between humans and agents with the model as the shared artifact.

## 6.4 Write-tool re-targeting

Existing mutation tools gain a mandatory draft context (from `mcp/context.ts`). Op-level enforcement: each write is matched against the draft's scope grant via `extensions/capability/match.ts` *before* it touches the Y.Doc; violations return a structured error the agent can reason about ("scope does not permit model.delete; request elevation or narrow the task").

## 6.5 The agentic BIM team, restated

The six-agent orchestration concept becomes concrete: each agent role (classifier, QTO, fire-safety, LCA enrichment, clash triage, documentation) holds a distinct principal + key + standing scope. Their layers interleave in one DAG with per-role audit. A nightly "model gardener" agent proposing cleanup layers that merge automatically when conflict-free and all checks pass (10 §10.4 auto-merge policy) is the first fully autonomous loop worth shipping.
