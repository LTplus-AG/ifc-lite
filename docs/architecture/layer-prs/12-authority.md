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
3. **Disagreement.** Whether parties hold different values. Never resolved silently: differing opinions are retained (§12.4), surfaced as **contested** or **authority-split** (§12.5) and closed only by the authority (§12.6).

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

Selectors reuse the scope-claim grammar (07 §7.1, `extensions/src/capability/scope-claim.ts`) unchanged. The parser already splits capability targets on `.` (`capability/parse.ts`), so `Pset_WallCommon.FireRating` is already a valid two-segment target. What this spec adds is only its meaning: a two-segment target `<Set>.<Member>` names one member of a set.

A selector target matches IFCX attribute keys as follows:

| Target | Matches |
|---|---|
| `Pset_WallCommon.FireRating` | `bsi::ifc::v5a::Pset_WallCommon::FireRating` |
| `Pset_WallCommon` | every member of that set |
| `prop.FireRating` | `bsi::ifc::prop::FireRating` (flat IFC5 property) |
| `prop` | every flat IFC5 property |
| `geometry`, `geometry.<tier>` | `usd::*` geometry components (02 §2.2); `usd::xformop` is `placement` |
| `placement`, `attr.class`, `material` | the matching component keys |
| `*` | every attribute, including keys with no selector path |

A target matches a prefix of the attribute's path, so a set covers its members. The merge vocabulary spells `geometry:<tier>` and `attr:class` with a colon; inside a capability the first `:` already separates the action from the target, so the charter uses `.` instead. A rule with an `@<type>` selector never governs an attribute whose entity type is unknown.

Authority is evaluated **per IFCX attribute key**, the unit composition already resolves, not per merge `componentKey`. This matters because the merge engine buckets set members into `pset:<Set>` (`merge/src/component-state.ts`): the architect editing `Pset_WallCommon.IsExternal` and the fire consultant setting `Pset_WallCommon.FireRating` are one component for merge purposes but two separate authority questions.

### Specificity and ambiguity

The governing rule for an attribute is the most specific match, compared in this order: more target segments (member before set before component), more literal (non-glob) segments, exact type before glob before no type, more constraints before fewer. Two equally specific rules naming different roles is a **charter error**, rejected when the charter is published. Authority is never ambiguous at evaluation time.

### Principals

An opinion's principal is its layer's `author.principal` (03 §3.1). At trust level 3 (03 §3.2) a rule only counts an opinion as authoritative if its layer carries a valid signature from that principal. For whole-file deliveries ingested by ifc-git, the principal is the registered delivering party, never inferred from `IfcOwnerHistory` (same anti-fabrication rule as ifc-git §3).

## 12.4 Opinion retention

Composition keeps every layer's value per (path, attribute key) instead of only the winner:

```text
Opinion = { layerId, principal, value }      // list in precedence order, strongest last
```

This matches the shape of upstream `GetOpinions` (IFC5-development PR #153), so ifc-lite and the reference implementation can exchange the same information. In `federated-composition.ts` the list is a separate retained-opinions collection. `attributeSources` stays, but is projected from the opinion §12.5 selects as the shown value, not from the last list entry: when authority overrides stack order, the source must name the authoritative layer, not the strongest one. Retention is on whenever a charter applies or the viewer is in review mode; otherwise composition keeps today's cost.

**An opinion is what a layer asserts, not what it carries.** Layers are state-based (02 §2.2): a `set-component` carries the whole component, and merge layers emit the full `pset:<Set>` value (`merge/src/three-way.ts`). Counting every carried member as an opinion would put words in a party's mouth: an architect delivery that only changes `IsExternal` would re-assert its old `FireRating` and show up as dissent. So for authority, a layer's opinion on an attribute key exists only where its value differs from the same key in the layer's declared base (`manifest.base`). A layer without a base (a first delivery, an import) asserts everything it contains, which is correct: that party did state those values. This is a per-member comparison inside components the diff already marks as changed; it does not change `@ifc-lite/diff`'s `pset:<Set>` output shape. ifc-git's delivery → layer adapter follows the same rule by emitting only the changed members.

## 12.5 Resolution

For each (path, attribute key) with opinions `O`, the state is the **first** row that matches, so every input has exactly one state. "Values differ" always compares values, never principals: two principals holding the same value agree.

| # | Condition | State | Shown value | Surfaced |
|---|---|---|---|---|
| 1 | No governing rule `R` (§12.3); all opinions hold one value | `agreed` | That value | No |
| 2 | No governing rule; values differ | `divergent` | Stack-order winner (precedence) | Informational: a candidate for a new charter rule |
| 3 | Rule `R` applies; no opinion's principal holds `R.role` | `unconfirmed` | Stack-order winner | Lower-severity review flag |
| 4 | Authoritative opinions (principal holds `R.role`) hold more than one value | `authority-split` | Strongest authoritative opinion | BCF topic to the role (§12.6) |
| 5 | Authoritative opinions hold one value; some other opinion differs | `contested` | The authoritative value, **regardless of stack order** | BCF topic to the role (§12.6) |
| 6 | Authoritative opinions hold one value; no other opinion differs | `authoritative` | The authoritative value | No |

Opinions outside the role whose value differs from the shown value are **dissent** (rows 4 and 5). `authority-split` covers two layers from principals in the same role disagreeing, e.g. two fire consultants on one project, or one consultant's earlier and later deliveries composed together. It is resolved the same way as `contested` (§12.6), by a principal holding the role.

Resolution is a pure function of (stack, charter). The same inputs always give the same states, so viewer, CLI, MCP and the registry agree.

## 12.6 Contested lifecycle

- **Record.** `{ path, attributeKey, ruleId, state, authoritative: Opinion[], dissent: Opinion[] }` (`authoritative` holds one opinion for `contested`, several for `authority-split`), keyed by a hash of those fields so recomposition never duplicates it.
- **Surface.** One BCF topic per record (08 §8.6), assigned to the rule's role, bound to (entity, attribute key). The viewer colours contested entities through `@ifc-lite/lens` and the entity panel lists every opinion with its principal.
- **Resolve.** Only a principal holding the role can close it, by publishing a layer whose manifest records the resolution:
  - `uphold`: keep the authoritative value; the dissent is acknowledged with a reason.
  - `adopt`: the authority sets the dissenting value as its own opinion.
- **Reopen.** A resolution covers the specific dissent it answered (layer id and value hash). A new or changed dissenting opinion opens a new record.

Nobody else can resolve it. A reviewer in the merge conflict queue (08 §8.3) who picks `theirs` on a governed attribute against the authority produces a merge layer whose opinion is still dissent; the shown value does not change.

## 12.7 Integration

- **Attribution through merge layers.** A three-way merge appends only the merge layer to the ref (`merge/src/ref-flow.ts`), and that layer is authored by the resolver. Attributing its ops to the resolver would credit the resolver with every merged value. So the opinion pass expands a merge layer back into its sources: ops taken from the candidate (auto-merged ops and `theirs` resolutions) are attributed to the candidate layer's `author.principal`, read from the content-addressed candidate named in `manifest.merge.candidate`; `edited` resolutions are the resolver's own opinions; `ours` adds nothing, since that value is already in the stack under its original layer. Candidate opinions the merge did **not** apply (the losing side of an authority auto-resolution) are still read from the candidate layer and retained as dissent, so they reach §12.5 without being composed into the shown value. This requires the registry to keep every merged candidate layer; it already stores them by id.
- **Merge.** A concurrent-edit conflict (05 §5.3) on a governed attribute where exactly one side is authoritative resolves automatically to that side, recorded in `manifest.merge.resolutions` with the rule id as basis. The other side remains in the stack as dissent and the attribute becomes `contested`. Both sides authoritative (same role, two layers) stays an ordinary conflict and, if merged unresolved, composes as `authority-split`.
- **Merge granularity.** The merge conflict unit stays (entity, `componentKey`), so `@ifc-lite/diff`'s output shape does not change. A concurrent-edit on `pset:Pset_WallCommon` where the architect changed `IsExternal` and the fire consultant changed `FireRating` is resolved **inside** the component: the merge engine already holds the base, ours and theirs attribute values (`ComponentSnapshot.attributes`), so it compares them per attribute key. Members changed on only one side take that side; governed members follow the rule above; only a member both sides changed without a governing rule stays a conflict.
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
