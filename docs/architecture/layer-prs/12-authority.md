# 12: Authority and Disagreement

**Status: Draft v0.1, for discussion. Tracking: [#8203](https://github.com/LTplus-AG/ifc-lite/issues/8203#issuecomment-6446094066).** (Number 11 stays reserved for the upstream-standardization doc that 01 and 02 already cite.)

## 12.1 The problem

The architect's layer says a wall is EI 60. The fire consultant's layer says EI 90. Which one is right?

Nothing in the system can answer that today:

| Mechanism | What it decides | Why it doesn't answer the question |
|---|---|---|
| Stack order (`layer-stack.ts`, `federated-composition.ts`) | Which opinion is *shown*: strongest layer wins per attribute | Whoever orders the stack decides the outcome. `attributeSources` records the winner; the losing value is discarded, so nobody sees there was a disagreement |
| Three-way merge (05 §5.3) | Concurrent edits against a **shared base** | Two independent discipline deliveries stacked side by side never share a base, so they never meet in a merge |
| `scope_claim` (03, 07) | What a layer *says it touches* | It is the author's own declaration, not an entitlement to decide anything |
| `RefPolicy` (`merge/src/ref-flow.ts`) | Whether a ref needs human approval, which checks, auto-merge | No notion of who owns a value |
| Conflict resolution (`ResolutionInput`) | `ours` / `theirs` / `edited` | Records the choice, not on whose authority it was made |

Upstream IFCX is in the same position. Composition is order-based and replaces whole attribute values; IFC5-development PR #148 settles import precedence and PR #153 adds an opt-in `GetOpinions` list so a disagreement can be *seen*. No proposal yet says who *reconciles* it.

## 12.2 Three separate questions

This spec keeps three things apart that stack order currently collapses into one:

1. **Precedence.** Which opinion is shown when nobody claims authority. Unchanged: stack order (02 §2.2). This is the fallback and keeps every existing stack composing exactly as it does today.
2. **Authority.** Who is entitled to decide a value. A **responsibility map** (§12.3), the machine-readable form of an ISO 19650 responsibility matrix.
3. **Disagreement.** Whether parties hold different values. Never resolved silently: differing opinions are retained (§12.4), surfaced as **contested** (§12.5) and closed only by the authority (§12.6).

## 12.3 The responsibility map (charter)

### Container

A **charter** is a published layer whose header carries an `ifclite::authority` block. It contains no model opinions. It lives on its own ref (default `charter`), never inside the stack it governs: a layer cannot grant itself authority by being composed into the model it is judged against.

```json
{
  "ifclite::authority": {
    "v": 1,
    "basis": "BEP rev C, responsibility matrix §4.2",
    "roles": {
      "architect": ["arch@studio.example"],
      "fire-consultant": ["fire@consult.example"],
      "information-manager": ["im@client.example"]
    },
    "rules": [
      { "id": "fire-rating-walls", "selector": "model.mutate:Pset_WallCommon.FireRating@IfcWall*", "role": "fire-consultant" },
      { "id": "fire-rating-doors", "selector": "model.mutate:Pset_DoorCommon.FireRating@IfcDoor*", "role": "fire-consultant" },
      { "id": "wall-geometry", "selector": "model.mutate:geometry@IfcWall*", "role": "architect" }
    ]
  }
}
```

Changes to the charter are themselves layers on the `charter` ref, governed by the reserved rule that only the `information-manager` role (the ISO 19650 appointing party's representative) may publish there. A charter revision is how responsibility moves between project stages.

### Selectors

Selectors reuse the scope-claim grammar (07 §7.1, `extensions/src/capability/scope-claim.ts`) with one extension: the target segment may name a single member as `<Set>.<Member>`. Today `SEGMENT_RE` in `capability/parse.ts` rejects `.`, so this is a grammar change, not a new grammar.

A selector target matches IFCX attribute keys as follows:

| Target | Matches |
|---|---|
| `Pset_WallCommon.FireRating` | `bsi::ifc::v5a::Pset_WallCommon::FireRating` |
| `Pset_WallCommon` | every member of that set |
| `prop.FireRating` | `bsi::ifc::prop::FireRating` (flat IFC5 property) |
| `geometry`, `geometry:<tier>` | `usd::*` geometry components (02 §2.2) |
| `placement`, `attr:class`, `material` | the matching component keys |

Authority is evaluated **per IFCX attribute key**, the unit composition already resolves, not per merge `componentKey`. This matters because the merge engine buckets set members into `pset:<Set>` (`merge/src/component-state.ts`): the architect editing `Pset_WallCommon.IsExternal` and the fire consultant setting `Pset_WallCommon.FireRating` are one component for merge purposes but two separate authority questions.

### Specificity and ambiguity

The governing rule for an attribute is the most specific match: member before set before component; exact type before glob; more constraints before fewer. Two equally specific rules naming different roles is a **charter error**, rejected when the charter is published. Authority is never ambiguous at evaluation time.

### Principals

An opinion's principal is its layer's `author.principal` (03 §3.1). At trust level 3 (03 §3.2) a rule only counts an opinion as authoritative if its layer carries a valid signature from that principal. For whole-file deliveries ingested by ifc-git, the principal is the registered delivering party, never inferred from `IfcOwnerHistory` (same anti-fabrication rule as ifc-git §3).

## 12.4 Opinion retention

Composition keeps every layer's value per (path, attribute key) instead of only the winner:

```text
Opinion = { layerId, principal, value }      // list in precedence order, strongest last
```

This matches the shape of upstream `GetOpinions` (IFC5-development PR #153), so ifc-lite and the reference implementation can exchange the same information. In `federated-composition.ts` it replaces the winner-only `attributeSources` map, which becomes a projection of the list (last entry). Retention is on whenever a charter applies or the viewer is in review mode; otherwise composition keeps today's cost.

## 12.5 Resolution

For each (path, attribute key) with opinions `O`:

1. Find the governing rule `R` (§12.3). If none, the value is the stack-order winner (precedence).
2. Otherwise let `A` be the opinions whose principal holds `R.role`.
3. If `A` is non-empty, the shown value is the strongest opinion in `A`, **regardless of stack order**. Opinions outside `A` with a different value are **dissent**.
4. If `A` is empty, the shown value is the stack-order winner, marked as not yet confirmed by the authority.

Every attribute ends in one of these states:

| State | Meaning | Surfaced |
|---|---|---|
| `agreed` | All opinions hold the same value | No |
| `authoritative` | The authority has spoken; nobody differs | No |
| `contested` | The authority has spoken; at least one other party holds a different value | Yes: BCF topic to the authority (§12.6) |
| `unconfirmed` | A rule exists but the authority has not set a value | Yes, as a lower-severity review flag |
| `divergent` | No rule applies and principals differ; stack order decided | Yes, informational: a candidate for a new charter rule |

Resolution is a pure function of (stack, charter). The same inputs always give the same states, so viewer, CLI, MCP and the registry agree.

## 12.6 Contested lifecycle

- **Record.** `{ path, attributeKey, ruleId, authoritative: Opinion, dissent: Opinion[] }`, keyed by a hash of those fields so recomposition never duplicates it.
- **Surface.** One BCF topic per record (08 §8.6), assigned to the rule's role, bound to (entity, attribute key). The viewer colours contested entities through `@ifc-lite/lens` and the entity panel lists every opinion with its principal.
- **Resolve.** Only a principal holding the role can close it, by publishing a layer whose manifest records the resolution:
  - `uphold`: keep the authoritative value; the dissent is acknowledged with a reason.
  - `adopt`: the authority sets the dissenting value as its own opinion.
- **Reopen.** A resolution covers the specific dissent it answered (layer id and value hash). A new or changed dissenting opinion opens a new record.

Nobody else can resolve it. A reviewer in the merge conflict queue (08 §8.3) who picks `theirs` on a governed attribute against the authority produces a merge layer whose opinion is still dissent; the shown value does not change.

## 12.7 Integration

- **Merge.** A concurrent-edit conflict (05 §5.3) on a governed attribute where exactly one side is authoritative resolves automatically to that side, recorded in `manifest.merge.resolutions` with the rule id as basis. The other side remains in the stack as dissent and the attribute becomes `contested`. Both sides authoritative (same role, two layers) stays an ordinary conflict.
- **Ref policy.** `RefPolicy` gains `charter?: string` (the ref holding the charter) and `rejectDissent?: boolean`. By default a non-authoritative opinion merges as an opinion (it is information, not a write); with `rejectDissent` the ref refuses layers that would create new contested records.
- **Scope claims.** Unchanged. A scope claim is what a layer says it touches; authority is who decides. Publish-time claim checking (07 §7.2) still runs.
- **ifc-git.** Each ingested whole-file delivery becomes a layer attributed to its delivering principal, so two discipline deliveries go through exactly this resolution. Most real disagreements arrive this way.
- **Geometry tiers.** Authority binds at the source tier; derived tiers carry no independent identity and follow it (04 §4.4). Order of decisions: authority (or precedence) chooses *whose* geometry, then the tier rule (highest tier present wins) chooses *within that contributor's* opinions. A weaker layer's procedural shape never beats a stronger or authoritative layer's mesh just because its tier is higher.

## 12.8 Upstream

The charter is layer metadata in an extension namespace, so it needs nothing from the IFCX schema; tools unaware of `ifclite::authority` compose by stack order as before. What we take upstream:

- Support for PR #153's opinion list as the common representation of disagreement, and #148's precedence as the fallback.
- The precedence / authority / disagreement split, with `ifclite::authority` offered as a candidate for standardized layer metadata.

## 12.9 Open questions

- **Inherited values.** A type object carries `FireRating` and an occurrence overrides it. Does the rule judge the occurrence's own opinion, the effective value, or both?
- **Entity deletion.** The architect (who owns the wall's existence) deletes a wall whose fire rating the fire consultant owns. Proposed: deletion is allowed and notifies the attribute's authority, but this needs a decision.
- **Joint authority.** Some values need two roles to agree (e.g. structural fire resistance). Possible `role: ["fire-consultant", "structural-engineer"], mode: "all"`; not in v1.
- **Federation.** One charter per model identity space (04 §4.2), or one per project spanning federated models?

## 12.10 Delivery

Behind a feature flag, `layers.authority`, one step per PR:

1. Opinion retention in `@ifc-lite/ifcx` composition and an opinions list in the viewer entity panel. Useful on its own: `divergent` becomes visible before any charter exists.
2. Charter format, the `<Set>.<Member>` selector extension in `@ifc-lite/extensions`, and the pure resolution function (§12.5), with golden tests.
3. Merge and `RefPolicy` integration (§12.7).
4. Contested records as BCF topics and resolution layers (§12.6).
5. Upstream proposal (§12.8).
