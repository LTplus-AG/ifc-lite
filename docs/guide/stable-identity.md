# Stable Element Identity

An architect issues a model. You key external data on its GlobalIds: cost lines, inspection records, room bookings, a defect list. In the next issue the architect has deleted a wall and redrawn it, split it into layers, changed its buildup, or swapped a chair for another family. Each of those mints a **new GlobalId**, and your key breaks.

This page is the task-oriented tour of what ifc-lite offers against that, from the cheapest answer to the most involved. The reference for each piece is [Model Diff](model-diff.md).

## The short version

| What the architect did | What ifc-lite reports | What you do with it |
|---|---|---|
| Re-exported the model from scratch (every GlobalId new, nothing changed) | `renamed` content match | Replay it as an [identity map](#step-2-save-what-the-engine-decided); the churn disappears |
| Deleted a wall and redrew it in the same place (the tool auto-renamed it) | `respecified` content match | Same: it is an identity the engine committed to |
| Split a wall along its length, or into layers | a `split` claim | Carry the row to the pieces with a [lineage](#step-3-carry-external-data-across-a-split) and a policy |
| Changed the buildup, swapped a family | a **successor suggestion** | A person accepts or rejects it; accepted pairs become identity |
| Maintains a real asset code in a property set | nothing, until you say so | Key the comparison on that code with [`--key-from`](#the-real-fix-an-authored-key) |

Two rules run through all of it. Nothing ever rewrites a GlobalId in a file: identity lives in a sidecar you can review and commit next to the models. And the engine never guesses: whatever it cannot decide on strong, one-to-one evidence is reported as a suggestion or a group for a human, never silently paired.

## The real fix: an authored key

A GlobalId is the default key because every `IfcRoot` has one. It is also the one identifier the authoring tool regenerates whenever an element is redrawn. If the model carries an identifier the author maintains on purpose — an asset code in a property set, a `Tag` the tool keeps stable — that identifier survives a redraw, and the comparison can key on it instead:

```bash
ifc-lite diff model-v1.ifc model-v2.ifc --key-from Pset_Asset.AssetId --json
```

An element carrying a non-empty, unique value under that spec is keyed `prop:<value>`; every other element keeps its GlobalId. A value two elements share is refused for both (they fall back to GlobalId and the command warns), because a key that names two things is not a key. The viewer's Compare panel has the same option — a **Key on** field in the run controls, next to the content-matching checkbox (see [Comparing on an authored key](model-diff.md#comparing-on-an-authored-key)) — and the MCP `model_diff` tool (`key_from`) takes the same spec.

Every identity map and lineage records the scheme it was written under, and replaying one under a different scheme is refused like a digest mismatch. A map written under authored keys is stamped format version 2, so an older reader refuses it outright rather than applying it under GlobalId.

If you can arrange for an authored key, do that and stop reading. The rest of this page is what to do when you cannot.

## Step 1: compare, and read the answer honestly

```bash
ifc-lite diff model-v1.ifc model-v2.ifc --by-content --json
```

Every element the key pass left as an add plus a delete goes through [content matching](model-diff.md#content-keyed-matching-unreliable-globalids). The result tells you *why* it paired each one:

- **`renamed`** — same data, same shape in the same place, new GlobalId. The re-export.
- **`respecified`** — same shape in the same place, *different* data. The wall that was deleted, redrawn and auto-renamed (`Wall-023` became `Wall-041`). Its `changedComponents` list which data slices moved.
- **`moved`** / **`reshaped`** — same data, different geometry.
- **`ambiguous`** / **`duplicated`** / **`deduplicated`** — the engine could not decide and says so; the elements stay listed as added and deleted for you to resolve.

!!! note "Geometry on the CLI"
    By default the CLI compares data only. Add `--geometry` to run the wasm mesh pass and attach world geometry hashes, bounding boxes and volumes to both files — this promotes the comparison to `scope: 'both'`, so `respecified`/`moved`/`reshaped` are told apart correctly. `--split-merge` and `--successors` then opt into the two geometry-backed detection stages:

    ```bash
    ifc-lite diff model-v1.ifc model-v2.ifc --by-content --geometry --split-merge --successors --json
    ```

    `--geometry` needs the `@ifc-lite/wasm` runtime built on the host. If it is missing, the command warns on stderr and falls back to a data-only comparison rather than failing outright — run `pnpm build:wasm:fetch` to fetch a prebuilt binary. Everything in this page about lineage files, `rekey` and authored keys works on the CLI either way.

## Step 2: save what the engine decided

The matches the engine committed to (`renamed`, `moved`, `reshaped`, `respecified`, one entity per side) can be written to an **identity map**, a small JSON file pinned to the SHA-256 of both models:

```bash
# Run 1: recognise the re-GUIDed elements and write the claims down.
ifc-lite diff model-v1.ifc model-v2.ifc --by-content --identity-out renames.json

# Review renames.json. Then replay it: those pairs are matched by key and no longer show as churn.
ifc-lite diff model-v1.ifc model-v2.ifc --identity-in renames.json
```

Each entry is `{ base, here, reason }`: the old key, the new key, and the evidence (`content-match:renamed`, `content-match:respecified`, …). Commit the file next to the models. It is a reviewed claim, and the digest pinning is what makes it one: replayed against a different pair of files it is refused, not silently applied. See [Identity maps](model-diff.md#identity-maps). An identity map is a human decision artifact regardless of how the reason got there, so a hand-written or viewer-exported entry whose `reason` starts with `successor:` is honoured as a replacement (lineage relation `replaced`) on replay, exactly as if it had come from accepting a suggestion in Step 4 below — the map does not have to originate from `--accept` for that to hold.

An identity map is strictly one-to-one. That is deliberate — identity is not a relation that survives being split — and it is why the next step exists.

## Step 3: carry external data across a split

When one wall became three, a row keyed on the old wall has to go *somewhere*. A **lineage** records the relation the engine (or you) established, one-to-many where needed:

```bash
# Write the lineage this comparison establishes (identity entries, splits, merges, accepted replacements).
ifc-lite diff model-v1.ifc model-v2.ifc --by-content --lineage-out lineage.json

# Carry a cost table across. Rows for a split wall are copied to every piece; rows with nowhere to go are set aside.
ifc-lite rekey costs.csv --lineage lineage.json --key-column GlobalId --out costs-v2.csv --orphans orphans.csv
```

A lineage entry is `{ base[], head[], relation, reason, shares? }` with one of four relations:

| `relation` | meaning | arity |
|---|---|---|
| `identity` | a content match the engine committed to, or a replayed identity entry | 1:1 |
| `split` | one base element became these head elements (`shares` = each piece's fraction of the volume, when every piece was measured) | 1:k |
| `merge` | these base elements became one head element | k:1 |
| `replaced` | a successor suggestion a person accepted | 1:1 |

`rekey` applies it to a CSV or a JSON array of objects. A row whose key is in no entry keeps its key — the element was unchanged — unless the lineage's `deleted` list names it, in which case the row is an orphan. Split rows follow the policy:

| `--policy` | a split row goes to |
|---|---|
| `copy-to-all` (default) | every piece |
| `largest-share` | the piece with the largest volume share; orphaned rather than guessed when shares are missing or tied |
| `orphan-on-split` | nowhere; only one-to-one relations rekey |

Merges and replacements rekey under every policy. `rekey` treats `identity` and `replaced` identically — both are 1:1, so both simply follow the row's key to its new one under every `--policy`; the two relations exist to tell a reader HOW the pairing was established (committed by the engine vs. accepted by a person), not to change what rekeying does with the row. The output gains `lineage_relation` and `lineage_from` columns so each row says where it came from, and orphans are always written aside (to `--orphans`, or to `<out>.orphans.<ext>` when you gave none), never dropped.

`--lineage-in lineage.json --lineage-out lineage.json` on the next comparison replays the one-to-one entries as key aliases and carries the rest forward, so the file is a stable round trip rather than something that erodes on every run. See [Lineage and rekeying external data](model-diff.md#lineage-and-rekeying-external-data).

## Step 4: let a person decide the rest

A wall whose buildup changed, or a chair swapped for another family, agrees on nothing a hash can see: its data and its geometry both changed. The engine argues from *where things are* and offers **successor suggestions** rather than deciding:

- **`footprint`** — the new box overlaps the old one heavily (a 200 → 250 mm thickening scores 0.8) and nothing else on either side comes close.
- **`position`** — same class family, same room or storey, comparable size, and each is the other's nearest candidate with the runner-up at least twice as far.

In the viewer's Compare panel these appear under **Suggestions**, next to the split and merge claims and the unresolved groups, each with its evidence line. **Accept** turns a successor suggestion into an identity entry (reason `successor:footprint` or `successor:position`); **Not the same** hides it for the session. A pair chosen from an ambiguous group instead carries `accepted:ambiguous`. Accepted pairs are replayed on the next compare, and the panel exports both the identity map and the lineage: successor reasons become `replaced`, while an accepted ambiguous pairing remains `identity`. On the CLI, hand a reviewed identity map to `--accept` and it is folded into the lineage by that same reason-prefix rule:

```bash
ifc-lite diff model-v1.ifc model-v2.ifc --accept reviewed.json --lineage-out lineage.json
```

The suggestion is never promoted on its own. `docs/architecture/layer-prs/04-identity.md` states the rule the whole design follows: human-in-the-loop identity beats wrong automatic identity. See [Successor claims](model-diff.md#successor-claims) and [Suggestions and accepting identity](model-diff.md#suggestions-and-accepting-identity).

## What is deliberately not done

- **Two stacked copies with different names** are reported as a group, not paired: members that differ in data are not interchangeable, and picking one would be a coin flip that a later revision would have to live with.
- **Two pieces in the same place** are never read as a split of anything; they are copies.
- **A tiny fixture inside a deleted element's box** is never its successor; the `position` profile requires comparable size.
- **A symmetric relocation** of identical elements abstains: no unique nearest neighbour, no pairing.
- **A split across class families** (a wall becoming a covering) is invisible; a wall becoming `IfcWallStandardCase` pieces or `IfcBuildingElementPart` layers is seen.

Each of these is measured, not hoped for: the [validation harness](https://github.com/LTplus-AG/ifc-lite/blob/main/scripts/xmatch/SPEC.md) mutates real models with a known answer key, pre-registers a floor for every stratum, and holds the false-pair count at a ceiling of zero.
