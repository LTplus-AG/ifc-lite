// SPDX-License-Identifier: MPL-2.0
//! Per-model visibility filtering for the merged (federated) STEP exporter.
//!
//! Mirrors the ROLE `StepOptions.included` plays for single-model export
//! (`step.rs`): a caller-supplied root set plus a forward-`#`-reference
//! closure. Two things the single-model path doesn't need, that a
//! multi-model federation does:
//!
//! - An explicit `excluded` id set the closure must never walk INTO — so a
//!   hidden product's geometry can't re-enter through a relationship that
//!   also names it. This is `merged-exporter.ts`'s `hiddenProductIds`
//!   (`computeIncludedEntityIds`, `reference-collector.ts:865` builds it,
//!   `reference-collector.ts:379`'s `excludeIds` param consumes it).
//! - A pass that NARROWS a kept relationship (`IFCREL*`) entity's SET/LIST
//!   attribute to its surviving members instead of emitting the relationship's
//!   original bytes with a now-dangling `#ref`, dropping the whole line only
//!   when narrowing itself has no spelling for "omitted" (a single-valued
//!   slot, or a SET/LIST's only member). This mirrors
//!   `filterHiddenRefsFromRelationshipLine` in `reference-collector.ts`
//!   ([`narrow_relationship_line`], below) — `step_text::split_top_level_args`
//!   (originally written for `apply_attr_mutations`) already tells a
//!   parenthesised SET/LIST attribute apart from a single-valued one, so no
//!   second attribute-group parser was needed here. Before this module grew
//!   [`narrow_relationship_line`], the whole KEPT relationship was dropped
//!   the instant it named ANY excluded id, at every one of its callers —
//!   proven wrong on real IFC: an exporter that lists every element of a
//!   storey in one `IFCRELCONTAINEDINSPATIALSTRUCTURE` would lose that
//!   storey's containment for every visible element on it just because one
//!   sibling was hidden, not merely "conservative" but materially incorrect.
//!
//! Neither this module nor `filterHiddenRefsFromRelationshipLine` closes every
//! dangling-reference shape: an excluded id can still survive as a `#ref`
//! inside a NON-`IFCREL*` entity this pass never inspects — an
//! `IFCSTYLEDITEM.Item`, a product's `Representation`/`ObjectPlacement`. That
//! gap is inherited from the JS reference, not introduced here — `step-exporter.ts`
//! documents it openly (see the "What the filter can and cannot reach" section
//! of the doc above its own two `filterHiddenRefsFromRelationshipLine` call
//! sites), including a measurement of 80 dangling refs, before and after, on
//! `tests/models/AB22.ifc` — so this module makes no "never dangles" claim
//! either.

use crate::step_text::{refs_in_line, split_top_level_args};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

/// One model's visibility filter for merged export.
///
/// `roots: vec![]` with `excluded: vec![]` means exactly what it says —
/// nothing survives from this model (an explicit empty allowlist), which is
/// a different outcome than omitting the filter entirely (which includes the
/// model in full). Callers are expected to pass the SAME root ids the JS
/// `computeIncludedEntityIds` (`merged-exporter.ts:994`) would select for a
/// `visibleOnly` export of this model on its own — infrastructure, spatial
/// structure, and every `IFCREL*` entity are always roots there; this module
/// does not re-derive that classification, it only closes and dedangles
/// whatever root/excluded sets it is given.
#[derive(Debug, Default, Clone)]
pub struct VisibilityFilter {
    pub roots: Vec<u32>,
    pub excluded: Vec<u32>,
}

/// Walk the forward `#`-reference closure from `roots`, refusing to enqueue
/// (or keep) any id in `excluded`, or any id absent from `by_id` entirely (a
/// ref to nothing, e.g. one already dangling in the source, is left exactly
/// as absent as it started).
fn forward_closure(
    roots: &[u32],
    excluded: &HashSet<u32>,
    by_id: &HashMap<u32, (&str, &[u8])>,
) -> HashSet<u32> {
    let mut keep: HashSet<u32> = HashSet::new();
    let mut stack: Vec<u32> = roots.to_vec();
    let mut refs: Vec<u32> = Vec::new();
    while let Some(id) = stack.pop() {
        if excluded.contains(&id) || !by_id.contains_key(&id) {
            continue;
        }
        if !keep.insert(id) {
            continue;
        }
        let (_, bytes) = by_id[&id];
        refs.clear();
        refs_in_line(bytes, &mut refs);
        for &r in &refs {
            if !excluded.contains(&r) && !keep.contains(&r) && by_id.contains_key(&r) {
                stack.push(r);
            }
        }
    }
    keep
}

/// Kept `IFCREL*` ids in `keep` whose own line does NOT survive
/// [`narrow_relationship_line`] against `is_excluded(r) = !keep.contains(&r)`
/// — i.e. an excluded id sits in a single-valued slot, or was a SET/LIST's
/// only member, so narrowing itself has no way to keep the line. A
/// relationship that CAN be narrowed (an excluded id inside a SET/LIST that
/// still has surviving members) is not dangling and stays in `keep` — the
/// actual narrowed text is produced later, at emission time, by
/// [`narrow_for_emission`], using this same `keep` set as the final answer to
/// "what does this id resolve to".
///
/// `!keep.contains(&r)` is the right `is_excluded` predicate here (not a
/// separate `excluded`/`by_id` lookup) because [`forward_closure`] already
/// guarantees the equivalence for any ref `r` named by an already-kept id: `r`
/// is in `keep` iff it is neither in the current `excluded` set nor absent
/// from `by_id` — those are the only two reasons `forward_closure` would
/// refuse to walk into a ref it reached from a kept entity. So "not in keep"
/// and "excluded-or-absent" are the same fact, one iteration at a time, which
/// is also exactly the union `hiddenProductIds.has(id) || !completeIndex.has(id)`
/// computes at `merged-exporter.ts`'s own `filterHiddenRefsFromRelationshipLine`
/// call site (`renderEntity`, `packages/export/src/merged-exporter.ts:1150`).
fn dangling_relationship_ids(keep: &HashSet<u32>, by_id: &HashMap<u32, (&str, &[u8])>) -> Vec<u32> {
    let mut dangling = Vec::new();
    for &id in keep {
        let (ty, bytes) = by_id[&id];
        if !ty.starts_with("IFCREL") {
            continue;
        }
        let text = String::from_utf8_lossy(bytes);
        if narrow_relationship_line(&text, &|r| !keep.contains(&r)).is_none() {
            dangling.push(id);
        }
    }
    dangling
}

/// The ONE named exception to "a single-valued STEP attribute has no spelling
/// for omitted", ported from `isOptionalTrailingRef` in
/// `reference-collector.ts:713`: `IfcRelConnectsStructuralMember`'s 10th
/// attribute (`ConditionCoordinateSystem`, position 9 zero-based) is declared
/// `OPTIONAL` by both IFC4 and IFC4X3, so an excluded id there can be rewritten
/// to `$` instead of withholding the whole relationship. Matched on the exact
/// type token AND attribute count (10) so `IFCRELCONNECTSWITHECCENTRICITY`
/// (11 attributes — `ConditionCoordinateSystem` shifts to position 8 and a
/// mandatory `ConnectionConstraint` is appended) falls through to the general
/// withhold rule, same as the JS original.
fn is_optional_trailing_ref(entity_type: &str, attr_count: usize, index: usize) -> bool {
    entity_type == "IFCRELCONNECTSSTRUCTURALMEMBER" && attr_count == 10 && index == 9
}

/// Mirrors `filterHiddenRefsFromRelationshipLine`
/// (`packages/export/src/reference-collector.ts:630`): narrows a `#N=TYPE(...);`
/// line's SET/LIST attribute(s) to just the members `is_excluded` does not
/// reject, returning `None` to mean "withhold this line entirely" only when:
///
///  - an excluded id sits in a bare, single-valued attribute slot (no
///    parentheses) — a single-valued STEP attribute has no spelling for
///    "omitted", UNLESS [`is_optional_trailing_ref`] says this exact slot is
///    schema-optional, in which case it is rewritten to `$` instead; or
///  - a parenthesised SET/LIST attribute's excluded members were its ONLY
///    members — an empty SET/LIST is not valid STEP for an IFC schema
///    attribute, so an empty list is a second, different kind of invalid file,
///    not "no forward reference".
///
/// Returns the line unchanged (same underlying text) when nothing named is
/// excluded, and a line unparseable as a single `#N=TYPE(...);` record is
/// also returned unchanged — this function only ever narrows a well-formed
/// record, matching the JS original's own "return line unchanged" contract
/// for a regex miss.
pub(crate) fn narrow_relationship_line(line: &str, is_excluded: &dyn Fn(u32) -> bool) -> Option<String> {
    let trimmed = line.trim_end();
    let body = trimmed.strip_suffix(';')?;
    let eq = body.find('=')?;
    let after = &body[eq + 1..];
    let popen = after.find('(')?;
    let aclose = after.rfind(')')?;
    if aclose <= popen {
        return Some(line.to_string());
    }
    let entity_type = after[..popen].trim().to_uppercase();
    let attrs_text = &after[popen + 1..aclose];
    let attrs = split_top_level_args(attrs_text);
    let attr_count = attrs.len();

    let mut changed = false;
    let mut next_attrs: Vec<String> = Vec::with_capacity(attrs.len());
    for (index, attr) in attrs.into_iter().enumerate() {
        let t = attr.trim();
        if t.len() >= 2 && t.as_bytes()[0] == b'(' && t.as_bytes()[t.len() - 1] == b')' {
            let inner = &t[1..t.len() - 1];
            let items: Vec<String> = if inner.trim().is_empty() { Vec::new() } else { split_top_level_args(inner) };
            let mut survivors: Vec<String> = Vec::with_capacity(items.len());
            let mut any_dropped = false;
            for item in &items {
                if let Some(id) = parse_bare_ref(item) {
                    if is_excluded(id) {
                        any_dropped = true;
                        continue;
                    }
                }
                survivors.push(item.trim().to_string());
            }
            if any_dropped {
                if survivors.is_empty() {
                    return None;
                }
                changed = true;
                next_attrs.push(format!("({})", survivors.join(",")));
            } else {
                next_attrs.push(attr);
            }
            continue;
        }

        if let Some(id) = parse_bare_ref(t) {
            if is_excluded(id) {
                if is_optional_trailing_ref(&entity_type, attr_count, index) {
                    changed = true;
                    next_attrs.push("$".to_string());
                    continue;
                }
                return None;
            }
        }
        next_attrs.push(attr);
    }

    if !changed {
        return Some(line.to_string());
    }
    let prefix = &body[..=(eq + 1 + popen)];
    Some(format!("{prefix}{});", next_attrs.join(",")))
}

/// `#(\d+)` (no other characters, ignoring surrounding whitespace) — a bare
/// STEP forward reference, not a nested list or an inline typed value.
fn parse_bare_ref(s: &str) -> Option<u32> {
    let s = s.trim();
    let digits = s.strip_prefix('#')?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse::<u32>().ok()
}

/// Emission-time entry point for [`export_merged_with_stats`]: apply
/// [`narrow_relationship_line`] to a KEPT `IFCREL*` entity's raw line bytes,
/// using `keep` — the same set [`compute_keep_set`] already returned for this
/// model — as the exclusion predicate. Non-`IFCREL*` types, and any line
/// [`narrow_relationship_line`] finds nothing to change in, are returned
/// BORROWED (no allocation): [`compute_keep_set`]'s own fixpoint already
/// proved every `IFCREL*` id still in `keep` survives this exact narrowing (see
/// [`dangling_relationship_ids`]'s doc for why `!keep.contains` is the right
/// predicate both times), so the `None` arm below is unreached in practice and
/// only a defensive fallback to the original bytes, never a panic.
pub(crate) fn narrow_for_emission<'a>(type_name: &str, line: &'a [u8], keep: &HashSet<u32>) -> Cow<'a, [u8]> {
    if !type_name.starts_with("IFCREL") {
        return Cow::Borrowed(line);
    }
    let text = String::from_utf8_lossy(line);
    match narrow_relationship_line(&text, &|r| !keep.contains(&r)) {
        Some(narrowed) if narrowed.as_bytes() != line => Cow::Owned(narrowed.into_bytes()),
        _ => Cow::Borrowed(line),
    }
}

/// Compute the kept express-id set for one model's lines under `filter`.
///
/// `lines` is `(express_id, type_name, line_bytes)` for every entity in the
/// model, in source order — the same shape `export_merged_with_stats`
/// already collects. Fixpoint of two steps:
///
/// 1. [`forward_closure`] from `filter.roots`, excluding `filter.excluded`.
/// 2. [`dangling_relationship_ids`] — any kept `IFCREL*` naming an id outside
///    the kept set is added to the excluded set and dropped from the root
///    list, and the closure is recomputed. Excluding (not just removing) the
///    dropped relationship's own id ensures anything reachable ONLY through
///    it — e.g. a property set exclusively attached by that one relationship
///    — is pruned too, rather than surviving as an orphan the next model
///    reload can no longer explain. Terminates because the excluded set only
///    grows and is bounded by the model's entity count.
pub fn compute_keep_set(lines: &[(u32, &str, &[u8])], filter: &VisibilityFilter) -> HashSet<u32> {
    let mut by_id: HashMap<u32, (&str, &[u8])> = HashMap::with_capacity(lines.len());
    for &(id, ty, bytes) in lines {
        by_id.entry(id).or_insert((ty, bytes));
    }

    let mut excluded: HashSet<u32> = filter.excluded.iter().copied().collect();
    let mut roots: Vec<u32> = filter.roots.clone();

    loop {
        let keep = forward_closure(&roots, &excluded, &by_id);
        let dangling = dangling_relationship_ids(&keep, &by_id);
        if dangling.is_empty() {
            return keep;
        }
        for id in dangling {
            excluded.insert(id);
            roots.retain(|&r| r != id);
        }
    }
}

#[cfg(test)]
#[path = "merged_visibility_tests.rs"]
mod tests;
