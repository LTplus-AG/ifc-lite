// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! One written relationship per entity and single-valued inverse across a
//! merge (a decomposition parent, and in IFC2X3 a property set's definer): the Rust twin of `claimInverses` in
//! `packages/export/src/merged-inverse-claims.ts` (#5471 / #5727 for
//! `IfcRelAggregates`, #5726 / #5802 for `IfcRelNests`, #5774 for IFC2X3
//! `IfcRelDefinesByProperties`).
//!
//! `IfcObjectDefinition.Decomposes` is `SET [0:1]` (and, from IFC4, so is
//! `Nests`), and `IfcSpatialStructureElement.WR41` requires exactly one for a
//! building or storey. A merge unifies entities (by GlobalId, and spatially)
//! but never relationships, so once a later model's entity unifies with an
//! earlier one, the earlier model's rel already gives it a parent, and a later
//! rel naming the same (final) id gives it a second one, whatever that rel's
//! RelatingObject is.
//!
//! The rule runs on the FINAL line, the text actually written: references are
//! already in the merged id space, after spatial and GlobalId unification and
//! after empty-container narrowing. Every written rel records its members; in
//! a later, unified model a member already recorded for the same inverse is
//! stripped, and a rel left with no members is not written. A unified member
//! with no parent yet is kept, since that rel is then its only parentage
//! statement (#3550).
//!
//! Known ordering difference from the TypeScript twin: claims are made in line
//! order, while TypeScript claims every aggregation of a model before any of
//! its nests. The two can only pick a different winner in IFC2X3 output when
//! ONE later model both nests and aggregates the same unclaimed object (legal
//! only in an IFC4 source converted down); both keep exactly one `Decomposes`
//! parent, which is the invariant this module enforces.

use std::collections::{HashMap, HashSet};

use super::line_edit::{append_to_list_attr, decide_line, LineDecision};
use super::plan::parse_ref_list;
use super::spatial::nth_attr;

/// One relationship attribute whose entities carry a single-valued inverse:
/// the entity named at `claimed` may be named there by at most one written rel
/// (of any type sharing `inverse`). The twin of `InverseRule` in
/// `merged-inverse-claims.ts`, whose test pins both tables to the EXPRESS schemas.
struct Rule {
    inverse: &'static str,
    /// Argument index of the side that carries the inverse.
    claimed: usize,
    /// Argument index of the other side.
    partner: usize,
    /// A WHERE rule bounds the partner list to one, so nothing can be folded into it.
    one_partner: bool,
}

const fn rule(inverse: &'static str, claimed: usize, partner: usize) -> Rule {
    Rule { inverse, claimed, partner, one_partner: false }
}

/// IFC2X3 `IfcPropertySetDefinition.PropertyDefinitionOf : SET [0:1]` (#5774);
/// IFC4 relaxes it to `DefinesOccurrence : SET [0:?]`.
const PROPERTY_DEFINITION_OF: Rule = rule("PropertyDefinitionOf", 5, 4);
/// `IfcRelOverridesProperties.WR1`: `SIZEOF(RelatedObjects) = 1`.
const PROPERTY_OVERRIDE_OF: Rule = Rule { one_partner: true, ..PROPERTY_DEFINITION_OF };

/// The single-valued inverses `rel_type` (uppercase) fills in the OUTPUT
/// schema (`schema_convert::canon`), list-side rules first: a fold only takes
/// members a list rule has not already stripped. Mirrors `inverseRules` in
/// `merged-inverse-claims.ts` row for row; that file's test pins the rows to
/// the EXPRESS schemas. In IFC2X3 `IfcRelAggregates` and `IfcRelNests` share
/// `Decomposes` (#5726), a type has one `IfcRelDefinesByType` (`ObjectTypeOf`)
/// and `IfcObject.WR1` (a WHERE rule) allows an object one; IFC4 splits off
/// `Nests`, names the typing inverses `IsTypedBy`/`Types`, and relaxes the
/// property-set side to `SET [0:?]`.
fn rules_of(rel_type: &str, schema: &str) -> &'static [Rule] {
    const CONTAINED: &[Rule] = &[rule("ContainedInStructure", 4, 5)];
    const VOIDS: &[Rule] = &[rule("VoidsElements", 5, 4)];
    const FILLS: &[Rule] = &[rule("FillsVoids", 5, 4)];
    const PROJECTS: &[Rule] = &[rule("ProjectsElements", 5, 4)];
    const COVERS_SPACES: &[Rule] = &[rule("CoversSpaces", 5, 4)];
    const FLOW_CONTROL: &[Rule] = &[rule("AssignedToFlowElement", 4, 5), rule("HasControlElements", 5, 4)];
    const PORTS: &[Rule] = &[rule("ConnectedTo", 4, 5), rule("ConnectedFrom", 5, 4)];
    const SERVICES: &[Rule] = &[rule("ServicesBuildings", 4, 5)];
    const PORT_TO_ELEMENT: &[Rule] = &[rule("ContainedIn", 4, 5)];
    const STRUCTURAL_ACTIVITY: &[Rule] = &[rule("AssignedToStructuralItem", 5, 4)];
    const DECOMPOSES: &[Rule] = &[rule("Decomposes", 5, 4)];
    const NESTS: &[Rule] = &[rule("Nests", 5, 4)];
    const TYPED_2X3: &[Rule] = &[rule("IsDefinedBy", 4, 5), rule("ObjectTypeOf", 5, 4)];
    const TYPED: &[Rule] = &[rule("IsTypedBy", 4, 5), rule("Types", 5, 4)];
    const COVERS: &[Rule] = &[rule("Covers", 5, 4)];
    const COVERS_ELEMENTS: &[Rule] = &[rule("CoversElements", 5, 4)];
    const GROUPED: &[Rule] = &[rule("IsGroupedBy", 6, 4)];
    const TIME_FOR_TASK: &[Rule] = &[rule("ScheduleTimeControlAssigned", 7, 6)];
    const DECLARED: &[Rule] = &[rule("IsDeclaredBy", 4, 5)];
    const CONTEXT: &[Rule] = &[rule("HasContext", 5, 4)];
    const ADHERES: &[Rule] = &[rule("AdheresToElement", 5, 4)];
    let ifc2x3 = schema == "IFC2X3";
    match rel_type {
        "IFCRELCONTAINEDINSPATIALSTRUCTURE" => CONTAINED,
        "IFCRELVOIDSELEMENT" => VOIDS,
        "IFCRELFILLSELEMENT" => FILLS,
        "IFCRELPROJECTSELEMENT" => PROJECTS,
        "IFCRELCOVERSSPACES" => COVERS_SPACES,
        "IFCRELFLOWCONTROLELEMENTS" => FLOW_CONTROL,
        "IFCRELCONNECTSPORTS" => PORTS,
        "IFCRELSERVICESBUILDINGS" => SERVICES,
        "IFCRELCONNECTSPORTTOELEMENT" => PORT_TO_ELEMENT,
        "IFCRELCONNECTSSTRUCTURALACTIVITY" => STRUCTURAL_ACTIVITY,
        "IFCRELAGGREGATES" => DECOMPOSES,
        "IFCRELNESTS" if ifc2x3 => DECOMPOSES,
        "IFCRELNESTS" => NESTS,
        "IFCRELDEFINESBYTYPE" if ifc2x3 => TYPED_2X3,
        "IFCRELDEFINESBYTYPE" => TYPED,
        "IFCRELCOVERSBLDGELEMENTS" if ifc2x3 => COVERS,
        "IFCRELCOVERSBLDGELEMENTS" => COVERS_ELEMENTS,
        "IFCRELDEFINESBYPROPERTIES" if ifc2x3 => std::slice::from_ref(&PROPERTY_DEFINITION_OF),
        "IFCRELOVERRIDESPROPERTIES" if ifc2x3 => std::slice::from_ref(&PROPERTY_OVERRIDE_OF),
        "IFCRELASSIGNSTOGROUP" if ifc2x3 => GROUPED,
        "IFCRELASSIGNSTASKS" if ifc2x3 => TIME_FOR_TASK,
        "IFCRELDEFINESBYOBJECT" if !ifc2x3 => DECLARED,
        "IFCRELDECLARES" if !ifc2x3 => CONTEXT,
        "IFCRELADHERESTOELEMENT" if schema == "IFC4X3" || schema == "IFC5" => ADHERES,
        _ => &[],
    }
}

/// The written rel a single-valued claimed entity already belongs to.
struct Owner {
    rel: u32,
    rel_type: String,
    partner: usize,
    partners: HashSet<u32>,
}

/// One side of a final rel line.
enum Side {
    List(Vec<u32>),
    Single(u32),
}

fn read_side(line: &str, index: usize) -> Option<Side> {
    let arg = nth_attr(line, index)?.trim();
    if arg.starts_with('(') {
        return Some(Side::List(parse_ref_list(arg)));
    }
    arg.strip_prefix('#')?.parse().ok().map(Side::Single)
}

/// The express id of a final line `#N=…`, tolerating STEP whitespace around
/// `=` (`#4 = IFCREL…`). `claim` and `apply_folds` must read it the same way,
/// or a fold recorded against an owner never finds its line.
fn rel_id(line: &str) -> Option<u32> {
    line.strip_prefix('#')?.split('=').next()?.trim().parse().ok()
}

/// Which final ids already fill each single-valued inverse of the output
/// schema. One instance per merge.
pub(super) struct ParentClaims {
    /// The output schema, canonical (`IFC2X3`, `IFC4`, `IFC4X3`, `IFC5`).
    schema: &'static str,
    /// Claimed through a list side (RelatedObjects): the ids alone.
    claimed: HashMap<&'static str, HashSet<u32>>,
    /// Claimed through a single side (RelatingPropertyDefinition): the rel that owns each.
    owners: HashMap<&'static str, HashMap<u32, Owner>>,
    /// Final rel id → (partner index, ids a later, folded rel adds to its partner list).
    folds: HashMap<u32, (usize, Vec<u32>)>,
    /// Later rels withheld with partners no owner could take: final rel id → how many.
    unfolded: Vec<(u32, usize)>,
}

impl ParentClaims {
    /// Test shorthand: IFC2X3 or IFC4 output.
    #[cfg(test)]
    pub(super) fn new(ifc2x3: bool) -> Self {
        Self::for_schema(if ifc2x3 { "IFC2X3" } else { "IFC4" })
    }

    /// The claims of a merge written as `schema` (any spelling `canon` reads).
    pub(super) fn for_schema(schema: &str) -> Self {
        Self { schema: crate::schema_convert::canon(schema), claimed: HashMap::new(), owners: HashMap::new(), folds: HashMap::new(), unfolded: Vec::new() }
    }

    /// Decide how to write one final line of type `rel_type`, recording what it
    /// claims. `dedupe` is false for the first model and for a federated one,
    /// which only record. `None`: do not write the line.
    ///
    /// A list side (an object's parent) strips the members already claimed and
    /// drops a rel left with none: the first parent wins. A single side (a
    /// property set's one definer, #5774) drops the later rel and folds the
    /// objects only it names into the owning rel's list ([`Self::apply_folds`]);
    /// where no fold is possible (another rel type, a one-partner rel) the
    /// first rel wins and the loss is reported.
    pub(super) fn claim(&mut self, rel_type: &str, line: String, dedupe: bool) -> Option<String> {
        let rules = rules_of(rel_type, self.schema);
        if rules.is_empty() {
            return Some(line);
        }
        let Some(rel) = rel_id(&line) else {
            return Some(line);
        };
        let mut strip: HashSet<u32> = HashSet::new();
        let mut new_owners: Vec<(&'static str, u32, usize)> = Vec::new();
        for rule in rules {
            match read_side(&line, rule.claimed) {
                Some(Side::List(members)) => {
                    let claimed = self.claimed.entry(rule.inverse).or_default();
                    if dedupe {
                        strip.extend(members.iter().copied().filter(|m| claimed.contains(m)));
                    }
                }
                Some(Side::Single(entity)) => {
                    let partners: Vec<u32> = match read_side(&line, rule.partner) {
                        Some(Side::List(ids)) => ids.into_iter().filter(|id| !strip.contains(id)).collect(),
                        Some(Side::Single(id)) => vec![id],
                        None => Vec::new(),
                    };
                    let foldable = matches!(read_side(&line, rule.partner), Some(Side::List(_))) && !rule.one_partner;
                    let Some(owner) = self.owners.entry(rule.inverse).or_default().get_mut(&entity) else {
                        new_owners.push((rule.inverse, entity, rule.partner));
                        continue;
                    };
                    if !dedupe {
                        continue;
                    }
                    let mut fresh: Vec<u32> = Vec::new();
                    for id in partners {
                        if !owner.partners.contains(&id) && !fresh.contains(&id) {
                            fresh.push(id);
                        }
                    }
                    if !fresh.is_empty() && foldable && owner.rel_type == rel_type {
                        owner.partners.extend(fresh.iter().copied());
                        let fold = self.folds.entry(owner.rel).or_insert_with(|| (owner.partner, Vec::new()));
                        fold.1.extend(fresh);
                        // Folded, its surviving members are now written: record their list claims.
                        for list_rule in rules {
                            if let Some(Side::List(members)) = read_side(&line, list_rule.claimed) {
                                let claimed = self.claimed.entry(list_rule.inverse).or_default();
                                claimed.extend(members.into_iter().filter(|m| !strip.contains(m)));
                            }
                        }
                    } else if !fresh.is_empty() {
                        self.unfolded.push((rel, fresh.len()));
                    }
                    return None;
                }
                None => {}
            }
        }
        let line = if strip.is_empty() {
            line
        } else {
            match decide_line(&line, &strip) {
                LineDecision::Keep => line,
                LineDecision::Skip => return None,
                LineDecision::Rewrite(text) => text,
            }
        };
        for rule in rules {
            if let Some(Side::List(members)) = read_side(&line, rule.claimed) {
                self.claimed.entry(rule.inverse).or_default().extend(members);
            }
        }
        for (inverse, entity, partner) in new_owners {
            let partners = match read_side(&line, partner) {
                Some(Side::List(ids)) => ids.into_iter().collect(),
                Some(Side::Single(id)) => HashSet::from([id]),
                None => HashSet::new(),
            };
            self.owners.entry(inverse).or_default().insert(entity, Owner { rel, rel_type: rel_type.to_string(), partner, partners });
        }
        Some(line)
    }

    /// Write the folds of [`Self::claim`] into the finished DATA section `out`
    /// (an owner may be written before the rel folded into it), and return a
    /// warning per later rel whose objects lost the relationship.
    pub(super) fn apply_folds(&self, out: &mut String) -> Vec<String> {
        let mut warnings: Vec<String> = self.unfolded.iter().map(|(rel, count)| format!(
            "A later model's relationship (merged id #{rel}) was not written: an earlier model already wrote one for the same merged entity, and it could not take the {count} other object(s) the later one named, so those objects lost that relationship."
        )).collect();
        if self.folds.is_empty() {
            return warnings;
        }
        let mut pending: HashMap<u32, &(usize, Vec<u32>)> = self.folds.iter().map(|(k, v)| (*k, v)).collect();
        let mut rebuilt = String::with_capacity(out.len() + 64 * pending.len());
        for line in out.split_inclusive('\n') {
            let id = rel_id(line);
            let patched = id.and_then(|id| pending.get(&id).map(|fold| (id, *fold))).and_then(|(id, (partner, ids))| {
                append_to_list_attr(line.trim_end_matches('\n'), *partner, ids).map(|text| (id, text))
            });
            match patched {
                Some((id, text)) => {
                    rebuilt.push_str(&text);
                    rebuilt.push('\n');
                    pending.remove(&id);
                }
                None => rebuilt.push_str(line),
            }
        }
        *out = rebuilt;
        let mut unwritten: Vec<(&u32, &&(usize, Vec<u32>))> = pending.iter().collect();
        unwritten.sort_by_key(|(rel, _)| **rel); // a stable warning order, not the map's
        warnings.extend(unwritten.into_iter().map(|(rel, (_, ids))| format!(
            "Could not add {} object(s) to relationship #{rel}, which a later model's duplicate relationship was merged into; those objects lost that relationship.",
            ids.len()
        )));
        warnings
    }
}

#[cfg(test)]
#[path = "single_parents_tests.rs"]
mod tests;
