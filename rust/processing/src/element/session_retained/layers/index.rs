// SPDX-License-Identifier: MPL-2.0
//! Snapshot-owned association lookup: scan source once, never once per product.
use super::*;
use ifc_lite_core::EntityScanner;
use rustc_hash::FxHashMap;
#[derive(Default)]
pub(crate) struct LayerAssociationIndex { products: FxHashMap<u32, Vec<u32>> }
impl LayerAssociationIndex {
    pub(super) fn for_product(&self, product: u32) -> &[u32] {
        self.products.get(&product).map(Vec::as_slice).unwrap_or(&[])
    }
}
pub(super) fn get<'a>(context: &'a OwnedMeshProductionContext, decoder: &mut EntityDecoder)
    -> Result<&'a LayerAssociationIndex, RetainedExecutionError> {
    if let Some(index) = context.retained_layer_associations.get() { return Ok(index); }
    let source = context.source().ok_or_else(invalid)?;
    // Bound the scan itself, including a file with no matching records.
    charge(source.bytes().len().div_ceil(4096))?;
    let mut scanner = EntityScanner::new(source.bytes());
    let mut index = LayerAssociationIndex::default();
    while let Some((id, name, _, _)) = scanner.next_entity() {
        if !ifc_lite_core::keyword_eq(name, "IFCRELASSOCIATESMATERIAL") { continue; }
        let association = decode(decoder, id)?;
        if association.ifc_type != IfcType::IfcRelAssociatesMaterial { return Err(invalid()); }
        let related = association.get_list(slot::IfcRelAssociatesMaterial::RELATED_OBJECTS.index()).ok_or_else(invalid)?;
        charge(related.len())?;
        for member in related {
            let product = reference_id(member)?;
            if !index.products.contains_key(&product) {
                resource::charge(resource::Cost { live_bytes:
                    (std::mem::size_of::<u32>() + std::mem::size_of::<Vec<u32>>()) as u64,
                    ..Default::default() }).map_err(RetainedExecutionError::Stopped)?.retain();
                index.products.try_reserve(1)
                    .map_err(|_| RetainedExecutionError::Stopped(resource::allocation_failure()))?;
            }
            let ids = index.products.entry(product).or_default();
            // A duplicate member / canonical duplicate STEP record is one relation.
            charge(ids.len())?;
            if !ids.contains(&id) { reserve(ids, 1)?; ids.push(id); }
        }
    }
    // Concurrent factory decoders may construct the same immutable index. A
    // losing initialization is dropped; a failed/partial index is never cached.
    let _ = context.retained_layer_associations.set(index);
    context.retained_layer_associations.get().ok_or_else(invalid)
}
