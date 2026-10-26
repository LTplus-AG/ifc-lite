// SPDX-License-Identifier: MPL-2.0
//! Source-owned classification feeding the canonical type geometry planner.
use super::*;
use ifc_lite_core::{AttributeValue, EntityScanner, SourceBundle};
use super::error::inspection_checkpoint;

pub(super) struct PreparedSource {
    pub(super) router: GeometryRouter,
    pub(super) entity: DecodedEntity,
    pub(super) kind: ElementJobKind,
    // The job borrows this selection through completion of every type map.
    pub(super) _storage: Storage,
}

pub(super) fn prepare(source: &SourceBundle, snapshot: &OwnedMeshProductionContext,
    decoder: &mut EntityDecoder, product: u32, mode: TypeGeometryMode)
    -> Result<PreparedSource, RetainedExecutionError> {
    snapshot.validate_decoder(decoder).map_err(RetainedExecutionError::Source)?;
    let mut owner = decoder.try_execution_lease()
        .map_err(|_| protocol(super::super::session_protocol::WorkError::OwnerBusy))?;
    let work = owner.begin_synchronous_work(decoder.execution_identity())
        .map_err(|_| protocol(super::super::session_protocol::WorkError::WrongOwner))?;
    let scope = work.source_borrow_scope_with_resources(resource::current_source_context());
    let result = resource::with_source_stop(scope.resource_stop_handle(), || {
        let resources = OwnedResourceContext::capture_current();
        let router = GeometryRouter::with_units(source.bytes(), decoder);
        let entity = decoder.decode_by_id(product).map_err(RetainedExecutionError::Core)?;
        let mut storage = Storage::default();
        let kind = classify(source, decoder, &entity, mode, &resources, &mut storage)?;
        inspection_checkpoint()?;
        Ok(PreparedSource { router, entity, kind, _storage: storage })
    });
    drop(scope);
    work.commit(decoder.execution_identity())
        .map_err(|_| protocol(super::super::session_protocol::WorkError::StaleSource))?;
    result
}

fn classify(source: &SourceBundle, decoder: &mut EntityDecoder, root: &DecodedEntity,
    mode: TypeGeometryMode, resources: &OwnedResourceContext, storage: &mut Storage)
    -> Result<ElementJobKind, RetainedExecutionError> {
    use ifc_lite_core::slot;
    if !root.ifc_type.is_subtype_of(IfcType::IfcTypeProduct) { return Ok(ElementJobKind::Product); }
    let malformed = || RetainedExecutionError::InvalidTypeSource;
    let mut maps = Vec::new();
    match root.get(slot::IfcTypeProduct::REPRESENTATION_MAPS.index()) {
        Some(AttributeValue::List(values)) => {
            storage.reserve(resources, &mut maps, values.len())?;
            for value in values {
                resource::charge(resource::Cost { work: 1, ..Default::default() })
                    .map_err(RetainedExecutionError::Stopped)?.retain();
                let AttributeValue::EntityRef(id) = value else { return Err(malformed()) };
                maps.push(*id);
            }
        }
        Some(AttributeValue::Null) => {},
        _ => return Err(malformed()),
    }
    // A conservative envelope for the bounded set and canonical planner's
    // collected Vec. No storage scales with unrelated mapped items in the file.
    let bytes = maps.len().checked_mul(128).and_then(|n| n.checked_add(4096))
        .ok_or_else(|| RetainedExecutionError::Stopped(resource::overflow()))?;
    storage.charge(resources, resource::Cost { live_bytes: bytes as u64, ..Default::default() })?;
    let mut referenced = FxHashSet::default();
    let mut instantiated = false;
    let mut scanner = EntityScanner::new(source.bytes());
    while let Some((id, name, start, end)) = scanner.next_entity() {
        inspection_checkpoint()?;
        resource::charge(resource::Cost { work: maps.len() as u64 + 1, ..Default::default() })
            .map_err(RetainedExecutionError::Stopped)?.retain();
        if !matches!(name, "IFCMAPPEDITEM" | "IFCRELDEFINESBYTYPE") { continue; }
        // SourceBundle's last-occurrence rule is authoritative, including when
        // an earlier duplicate had a different type or relationship target.
        if decoder.get_raw_bytes(id).map(|raw| raw.as_ptr()) != Some(source.bytes()[start..end].as_ptr()) { continue; }
        let entity = decoder.decode_by_id(id).map_err(RetainedExecutionError::Core)?;
        if name == "IFCMAPPEDITEM" {
            let Some(AttributeValue::EntityRef(map)) = entity.get(slot::IfcMappedItem::MAPPING_SOURCE.index())
                else { return Err(malformed()) };
            if maps.contains(map) { referenced.insert(*map); }
        } else {
            let Some(AttributeValue::EntityRef(type_id)) = entity.get(slot::IfcRelDefinesByType::RELATING_TYPE.index())
                else { return Err(malformed()) };
            instantiated |= *type_id == root.id;
        }
    }
    if scanner.malformed_record_start().is_some() || scanner.skipped_oversized_ids() != 0 { return Err(malformed()); }
    Ok(ElementJobKind::TypeProduct { rep_maps: plan_type_geometry(&maps, &referenced, instantiated, mode) })
}
