# 06: Agent Integration (MCP)

## 6.1 Principle

There is no write API that targets a published layer or a ref. Every mutation, from any client (`@ifc-lite/mcp`, viewer, CLI, SDK), lands in a draft layer. Agents are not a special case with extra restrictions: they are the *normal* case of the only write path that exists. This symmetry is what makes the audit trail trustworthy.

## 6.2 Draft lifecycle

```text
create_draft_layer(base?, intent, scope?)   draft bound to base, held in the MCP session's layer workspace
  └─ draft_apply_ops(draft_id, ops)        each op checked against the draft's scope claims first
  └─ dry_run_merge(layer_or_draft, into)   optional, any time
publish_layer(draft_id)                    freeze: minimal layer + tombstones, canonicalize,
                                           blake3, manifest, re-verify ops against scope claims
request_review(layer_id, into, reviewers?) opens the review (the PR object)
```

As shipped, the layer workspace (drafts, layers, refs, reviews) lives in the MCP process (`packages/mcp/src/tools/layer-store.ts`); `request_review` stores the review there, not on the registry. Registry-backed reviews are the collab-server routes (10). `publish_layer` runs no declared checks yet: its `checks` array is always empty (`packages/mcp/src/tools/layer.ts`). The existing model write tools are not yet re-targeted to a draft (6.4); the draft write path is `draft_apply_ops`.

A draft may be co-edited live by humans and agents in the same CRDT session (`author.kind: hybrid`). A long-running agent task may publish a *stack* of small layers (one per sub-task) sharing a `session` id: reviewable individually, mergeable as a group.

## 6.3 New tool family (added to `packages/mcp`)

| Tool | Notes |
|---|---|
| `create_draft_layer(base?, intent, scope?)` | scope is a capability expression (07); omitted or empty means unrestricted |
| `publish_layer(draft_id)` | returns layer id, op count and `scope_verified` (plus any mismatches); `checks` is empty today |
| `diff_layer(layer_or_draft, against?)` | structured diff, same JSON the review UI consumes; `against` defaults to the candidate's base |
| `dry_run_merge(layer_or_draft, into)` | MergePlan preview: conflicts, auto-op count, whether the base resolved; no side effects. Does not evaluate checks |
| `list_conflicts(layer_or_draft, into)` | conflict records only |
| `request_review(layer_id, into, reviewers?)` | creates the review in the MCP layer workspace |
| `get_review_feedback(review_id)` | review status, per-entity decisions and topics, structured for the agent to act on |
| `respond_to_review(review_id, intent?)` | opens a follow-up draft on the reviewed layer's base and scope and records it on the review; publishing it is a separate `publish_layer` call |

Shipped beside this table (`packages/mcp/src/tools/layer.ts`, `layer-review.ts`): `draft_apply_ops` (apply entity ops to a draft, each checked against its scope claims first), `add_review_topic` (a BCF-shaped comment bound to review, entity and optional componentKey) and `add_review_feedback` (per-entity reviewer decisions, optionally with a status change).

`get_review_feedback` + `respond_to_review` close the loop: reviewer rejects 12 of 400 entities with a BCF comment, the agent reads the structured feedback, fixes, republishes. The PR becomes a genuine conversation between humans and agents with the model as the shared artifact.

## 6.4 Write-tool re-targeting

(Planned, not implemented: today only `draft_apply_ops` writes to a draft, with the per-op scope check below done in `packages/mcp/src/tools/layer-ops.ts` via `findCoveringClaim` from `@ifc-lite/extensions`.) Existing mutation tools gain a mandatory draft context (from `mcp/context.ts`). Op-level enforcement: each write is matched against the draft's scope grant via `extensions/capability/match.ts` *before* it touches the Y.Doc; violations return a structured error the agent can reason about ("scope does not permit model.delete; request elevation or narrow the task").

## 6.5 The agentic BIM team, restated

The six-agent orchestration concept becomes concrete: each agent role (classifier, QTO, fire-safety, LCA enrichment, clash triage, documentation) holds a distinct principal + key + standing scope. Their layers interleave in one DAG with per-role audit. A nightly "model gardener" agent proposing cleanup layers that merge automatically when conflict-free and all checks pass (10 §10.4 auto-merge policy) is the first fully autonomous loop worth shipping.
