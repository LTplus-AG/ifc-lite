// SPDX-License-Identifier: MPL-2.0
//! Geometry patch: give a product a new body, built from a caller mesh, and
//! prune what its old shape leaves behind.
//!
//! The product's `Representation` is repointed at a new
//! `IfcProductDefinitionShape`; nothing in the old one is edited. Every patch
//! names the one edge it cut (product -> old shape), and [`sweep`] walks
//! forward from all of them together once every patch has resolved, so two
//! products that shared an old shape and both got new bodies release it
//! between them.
//!
//! The sweep is the placement patch's, counted rather than listed, with one
//! addition. Some records point at a representation only to annotate it: an
//! `IfcStyledItem` names the item it colours, an
//! `IfcPresentationLayerAssignment` lists what sits on the layer, an
//! `IfcShapeAspect` names the shape it is part of. Counted as referrers they
//! would keep every styled item alive forever. So a representation, its
//! shape or one of its top-level items that nothing but such annotations
//! still names is pruned too, and the annotations go with it through
//! delete: a styled item or shape aspect is deleted (delete repairs anything
//! naming it and prunes its style records by count), and a layer has the
//! entry stripped from its list.

use std::collections::{HashMap, HashSet, VecDeque};

use crate::step_ids::IdAllocator;

use super::attrs::attribute_index;
use super::index::FileIndex;
use super::tessellation::{body_shape, find_body_context, mesh_item, synthesize_context, validate_colour, validate_mesh, Emit};
use super::types::GeometryPatch;

/// The body context every geometry patch in one plan writes into: found once,
/// or synthesized once by the first patch that needs it.
#[derive(Default)]
pub(crate) struct BodyContext {
    chosen: Option<u32>,
    /// Set when [`resolve_geometry`] created the context; the caller attaches
    /// it to the project.
    pub(crate) synthesized: Option<u32>,
}

#[derive(Debug)]
pub(crate) struct GeometryWrite {
    pub(crate) new_records: Vec<(u32, String)>,
    /// `(product, Representation attribute index, new value)`.
    pub(crate) repoint: (u32, usize, String),
    /// The `IfcProductDefinitionShape` the product named before, if any.
    pub(crate) old_shape: Option<u32>,
    /// Non-Body representations of the old shape: `(id, identifier)`.
    pub(crate) dropped: Vec<(u32, Option<String>)>,
}

pub(crate) fn resolve_geometry(
    index: &FileIndex,
    schema: &str,
    object_id: u32,
    patch: &GeometryPatch,
    ids: &mut IdAllocator,
    removed: &HashSet<u32>,
    context: &mut BodyContext,
) -> Result<GeometryWrite, String> {
    validate_mesh(&patch.mesh)?;
    if let Some(c) = &patch.colour {
        validate_colour(c)?;
    }
    let object_type = index.type_of(object_id).unwrap_or_default();
    let rep_idx = attribute_index(schema, &object_type, "Representation")
        .ok_or_else(|| format!("{object_type} has no Representation attribute in {schema}"))?;
    let old_shape = index.attrs(object_id).and_then(|a| a.get(rep_idx).and_then(|a| a.scalar));
    if let Some(old) = old_shape {
        let old_type = index.type_of(old).unwrap_or_default();
        if old_type != "IFCPRODUCTDEFINITIONSHAPE" {
            return Err(format!("Representation is {old_type}, not an IfcProductDefinitionShape"));
        }
    }

    let mut new_records = Vec::new();
    let mut emit = Emit { schema, ids, out: &mut new_records };
    if context.chosen.is_none() {
        context.chosen = find_body_context(index, schema, removed);
    }
    let (ctx, synthesized) = match context.chosen {
        Some(ctx) => (ctx, None),
        None => {
            let ctx = synthesize_context(&mut emit)?;
            (ctx, Some(ctx))
        }
    };
    let (item, rep_type) = mesh_item(&mut emit, &patch.mesh)?;
    let shape = body_shape(&mut emit, ctx, item, rep_type, patch.colour.as_ref())?;
    if synthesized.is_some() {
        context.chosen = synthesized;
        context.synthesized = synthesized;
    }

    let dropped = old_shape.map(|old| non_body_representations(index, schema, old)).unwrap_or_default();
    Ok(GeometryWrite { new_records, repoint: (object_id, rep_idx, format!("#{shape}")), old_shape, dropped })
}

/// Every representation of `shape` whose identifier is not `Body`.
fn non_body_representations(index: &FileIndex, schema: &str, shape: u32) -> Vec<(u32, Option<String>)> {
    let Some(reps_idx) = attribute_index(schema, "IFCPRODUCTDEFINITIONSHAPE", "Representations") else {
        return Vec::new();
    };
    let reps = index.attrs(shape).and_then(|a| a.into_iter().nth(reps_idx)).and_then(|a| a.list).unwrap_or_default();
    reps.into_iter()
        .flatten()
        .filter_map(|rep| {
            let entity = index.type_of(rep)?;
            let identifier = index.string_attr(schema, rep, &entity, "RepresentationIdentifier");
            (identifier.as_deref() != Some("Body")).then_some((rep, identifier))
        })
        .collect()
}

/// What [`sweep`] found: records to drop, annotations to delete, and
/// `(layer, attribute index, member)` strips, the last two for
/// [`super::delete::resolve_deletes`].
pub(crate) struct Sweep {
    pub(crate) pruned: HashSet<u32>,
    pub(crate) delete: HashSet<u32>,
    pub(crate) detach: Vec<(u32, usize, u32)>,
}

/// How far below the old shape a record sits: the shape itself, one of its
/// representations, or one of their items. Only these are checked for
/// annotation-only referrers.
const ANNOTATED_DEPTH: u8 = 2;

/// At most this many referrers besides the ones already gone are listed to
/// see whether they only annotate. A record with more is kept; a styled item
/// and a layer or two is the ordinary case.
const ANNOTATION_LIMIT: usize = 4;

/// Prune what the cut edges `(product, old shape)` leave with no referrer
/// but annotations. `already_removed` is everything else leaving the output,
/// counted as gone too.
pub(crate) fn sweep(index: &FileIndex, schema: &str, cuts: &[(u32, u32)], already_removed: &HashSet<u32>) -> Sweep {
    let mut pruned: HashSet<u32> = HashSet::new();
    let mut delete = HashSet::new();
    let mut detach = Vec::new();
    // Distinct referrers of each record already gone: pruned here, removed
    // elsewhere, or a product that stopped naming it.
    let mut gone: HashMap<u32, usize> = HashMap::new();
    let mut cut_from: HashMap<u32, HashSet<u32>> = HashMap::new();
    // Each record is judged at the smallest depth it is reached at, and the
    // records a pruned one names are queued in id order, so the order a
    // record's references were read in does not change the result.
    let mut depth_of: HashMap<u32, u8> = HashMap::new();
    let mut queue: VecDeque<u32> = VecDeque::new();
    for &(product, shape) in cuts {
        if cut_from.entry(shape).or_default().insert(product) {
            *gone.entry(shape).or_default() += 1;
        }
        depth_of.insert(shape, 0);
        queue.push_back(shape);
    }
    if !cuts.is_empty() {
        for &r in already_removed {
            for t in index.refs_of(r) {
                *gone.entry(t).or_default() += 1;
            }
        }
    }

    // `from` stops naming what it names (all but `except`): each loses a
    // referrer and is queued one level below `at`.
    let release = |from: u32, at: u32, except: Option<u32>, gone: &mut HashMap<u32, usize>, depth_of: &mut HashMap<u32, u8>, queue: &mut VecDeque<u32>| {
        let below = depth_of.get(&at).copied().unwrap_or(0).saturating_add(1);
        let mut targets: Vec<u32> = index.refs_of(from).into_iter().filter(|&t| Some(t) != except).collect();
        targets.sort_unstable();
        for t in targets {
            *gone.entry(t).or_default() += 1;
            depth_of.entry(t).and_modify(|d| *d = (*d).min(below)).or_insert(below);
            queue.push_back(t);
        }
    };
    let prune = |id: u32, pruned: &mut HashSet<u32>, gone: &mut HashMap<u32, usize>, depth_of: &mut HashMap<u32, u8>, queue: &mut VecDeque<u32>| {
        if pruned.insert(id) {
            release(id, id, None, gone, depth_of, queue);
        }
    };

    while let Some(id) = queue.pop_front() {
        if pruned.contains(&id) || already_removed.contains(&id) {
            continue;
        }
        let depth = depth_of.get(&id).copied().unwrap_or(0);
        let entity = index.type_of(id).unwrap_or_default();
        if matches!(entity.as_str(), "IFCPROJECT" | "IFCGEOMETRICREPRESENTATIONCONTEXT" | "IFCGEOMETRICREPRESENTATIONSUBCONTEXT") {
            continue;
        }
        let Some(referrers) = index.referrer_count(id) else { continue };
        let left = referrers.saturating_sub(gone.get(&id).copied().unwrap_or(0));
        if left == 0 {
            prune(id, &mut pruned, &mut gone, &mut depth_of, &mut queue);
            continue;
        }
        if depth > ANNOTATED_DEPTH || left > ANNOTATION_LIMIT {
            continue;
        }
        // Empty means not collected yet (`left > 0` says there are some).
        let listed = index.referrers(id);
        if listed.is_empty() {
            continue;
        }
        let cut = cut_from.get(&id);
        let mut annotations = Vec::new();
        let mut used = false;
        for &(r, idx) in listed {
            if pruned.contains(&r) || delete.contains(&r) || already_removed.contains(&r) || cut.is_some_and(|c| c.contains(&r)) {
                continue;
            }
            match annotation(index, schema, r, idx) {
                Some(kind) => annotations.push((r, idx, kind)),
                None => {
                    used = true;
                    break;
                }
            }
        }
        if used {
            continue;
        }
        prune(id, &mut pruned, &mut gone, &mut depth_of, &mut queue);
        for (r, idx, kind) in annotations {
            match kind {
                // A deleted annotation stops naming what else it names (an
                // aspect's `ShapeRepresentations`), so those lose a referrer.
                Annotation::Scalar => {
                    if delete.insert(r) {
                        release(r, id, Some(id), &mut gone, &mut depth_of, &mut queue);
                    }
                }
                Annotation::ListEntry => detach.push((r, idx, id)),
            }
        }
    }
    Sweep { pruned, delete, detach }
}

enum Annotation {
    /// The annotation names this one record; it is deleted with it.
    Scalar,
    /// The annotation lists this record among others; only the entry goes.
    ListEntry,
}

/// Whether `referrer` names a record through attribute `idx` only to
/// annotate it.
fn annotation(index: &FileIndex, schema: &str, referrer: u32, idx: usize) -> Option<Annotation> {
    let entity = index.type_of(referrer)?;
    let name = *ifc_lite_core::attribute_names_for_schema(schema, &entity)?.get(idx)?;
    match (entity.as_str(), name) {
        // Deleted with the record only when nothing names the annotation
        // itself: a styled item listed in an `IfcStyledRepresentation` is
        // part of that representation, and deleting it could empty its
        // `Items`.
        ("IFCSTYLEDITEM", "Item") | ("IFCSHAPEASPECT", "PartOfProductDefinitionShape") => {
            (index.referrer_count(referrer) == Some(0)).then_some(Annotation::Scalar)
        }
        (entity, name) if super::delete::is_layer_items(entity, name) => Some(Annotation::ListEntry),
        _ => None,
    }
}

#[cfg(test)]
#[path = "geometry_tests.rs"]
mod tests;
