// SPDX-License-Identifier: MPL-2.0
//! Validate reachable shape/aspect engineering contexts without changing geometry.
use super::{preflight, Record};
use ifc_lite_core::{EntityDecoder, IfcType, MAX_PLACEMENT_DEPTH};
use std::collections::{HashMap, HashSet};

/// All representation identifiers remain local to their product. Follow only
/// mapped representation edges; never alter their geometry or add a wrapper.
pub(super) fn representation_contexts(
    roots: &HashSet<u32>,
    shapes: &HashSet<u32>,
    records: &[Record<'_>],
    declared: &HashSet<u32>,
    context: u32,
    decoder: &mut EntityDecoder,
) -> Result<HashSet<u32>, String> {
    let budget = records
        .len()
        .saturating_mul(ifc_lite_core::limits::MAX_MAPPED_ITEM_DEPTH as usize);
    let mut work = roots.len();
    if work > budget {
        return Err("representation context walk exceeded its reference-work bound".into());
    }
    let mut pending: Vec<_> = roots.iter().map(|id| (*id, false)).collect();
    let mut validated = HashSet::from([context]);
    let mut aspect_roots = Vec::new();
    let mut aspects: HashMap<u32, Vec<u32>> = HashMap::new();
    for record in records
        .iter()
        .filter(|record| record.kind == IfcType::IfcShapeAspect)
    {
        let aspect = decoder
            .decode_by_id(record.id)
            .map_err(|error| error.to_string())?;
        if let Some(parent) = aspect.get_ref(4) {
            aspects.entry(parent).or_default().extend(
                aspect
                    .get_refs(0)
                    .ok_or("ShapeAspect has invalid ShapeRepresentations")?,
            );
        }
    }
    for shape in shapes {
        if let Some(reps) = aspects.get(shape) {
            work = work
                .checked_add(reps.len())
                .filter(|value| *value <= budget)
                .ok_or("ShapeAspect context walk exceeded its reference-work bound")?;
            pending.extend(reps.iter().map(|id| (*id, false)));
        }
    }
    let mut depths: HashMap<u32, usize> = HashMap::new();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut active = HashSet::new();
    let mut seen = HashSet::new();
    while let Some((id, exiting)) = pending
        .pop()
        .or_else(|| aspect_roots.pop().map(|id| (id, false)))
    {
        if exiting {
            let depth = children.get(&id).map_or(Ok(0), |children| {
                children.iter().try_fold(0usize, |longest, child| {
                    depths
                        .get(child)
                        .map(|depth| longest.max(depth.saturating_add(1)))
                        .ok_or("mapped representation depth could not be resolved")
                })
            })?;
            if depth >= ifc_lite_core::limits::MAX_MAPPED_ITEM_DEPTH as usize {
                return Err("mapped representation exceeds the renderer depth bound".into());
            }
            depths.insert(id, depth);
            active.remove(&id);
            continue;
        }
        if active.contains(&id) {
            return Err("mapped representation context is cyclic".into());
        }
        if work > budget {
            return Err("representation context walk exceeded its reference-work bound".into());
        }
        if !seen.insert(id) {
            continue;
        }
        active.insert(id);
        pending.push((id, true));
        let rep = decoder
            .decode_by_id(id)
            .map_err(|error| error.to_string())?;
        if rep.ifc_type != IfcType::IfcShapeRepresentation {
            return Err(format!(
                "representation #{id} is not an IfcShapeRepresentation"
            ));
        }
        let mut current = rep
            .get_ref(0)
            .ok_or("representation has no ContextOfItems")?;
        let mut contexts = HashSet::new();
        while !validated.contains(&current) {
            if contexts.len() >= MAX_PLACEMENT_DEPTH || !contexts.insert(current) {
                return Err("representation context chain is cyclic or exceeds its bound".into());
            }
            let node = decoder
                .decode_by_id(current)
                .map_err(|error| error.to_string())?;
            if node.ifc_type == IfcType::IfcGeometricRepresentationContext
                && declared.contains(&current)
            {
                preflight::context_frame(current, decoder)?;
                validated.insert(current);
                break;
            }
            if node.ifc_type != IfcType::IfcGeometricRepresentationSubContext {
                return Err(format!(
                    "representation #{id} belongs to another map context"
                ));
            }
            current = node.get_ref(6).ok_or("subcontext has no ParentContext")?;
        }
        let items = rep
            .get_refs(3)
            .filter(|refs| !refs.is_empty())
            .ok_or("representation has no Items")?;
        work = work
            .checked_add(items.len())
            .filter(|value| *value <= budget)
            .ok_or("representation context walk exceeded its reference-work bound")?;
        for item_id in items {
            let item = decoder
                .decode_by_id(item_id)
                .map_err(|error| error.to_string())?;
            if !item.ifc_type.is_subtype_of(IfcType::IfcRepresentationItem) {
                return Err(format!("representation item #{item_id} has the wrong type"));
            }
            if item.ifc_type == IfcType::IfcMappedItem {
                let source = decoder
                    .decode_by_id(item.get_ref(0).ok_or("mapped item has no MappingSource")?)
                    .map_err(|error| error.to_string())?;
                if source.ifc_type != IfcType::IfcRepresentationMap {
                    return Err("invalid MappingSource type".into());
                }
                work = work
                    .checked_add(1)
                    .filter(|value| *value <= budget)
                    .ok_or("representation context walk exceeded its reference-work bound")?;
                if let Some(reps) = aspects.get(&source.id) {
                    work = work
                        .checked_add(reps.len())
                        .filter(|value| *value <= budget)
                        .ok_or("ShapeAspect context walk exceeded its reference-work bound")?;
                    aspect_roots.extend(reps.iter().copied());
                }
                let child = source.get_ref(1).ok_or("map has no MappedRepresentation")?;
                if active.contains(&child) {
                    return Err("mapped representation context is cyclic".into());
                }
                children.entry(id).or_default().push(child);
                pending.push((child, false));
            }
        }
    }
    Ok(validated)
}
