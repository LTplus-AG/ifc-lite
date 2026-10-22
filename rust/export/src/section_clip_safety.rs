// SPDX-License-Identifier: MPL-2.0
//! Strict section-export receipts, source integrity and texture refusal (#7711).
use std::collections::{BTreeSet, HashMap, HashSet};
use ifc_lite_core::{AttributeValue, EntityDecoder, EntityScanner, IfcType};
use ifc_lite_processing::{ProcessingSink, ProcessingStats, ProductGeometryAudit};

#[derive(Default)]
pub(super) struct Safety {
    audit: ProductGeometryAudit,
    // Inverse presentation attachments cannot be reached by a forward body walk.
    attachments: HashMap<u32, Vec<u32>>,
}

impl ProcessingSink for Safety {
    fn product_geometry_audit(&self) -> Option<ProductGeometryAudit> { Some(self.audit.clone()) }
}

impl Safety {
    pub(super) fn index_attachments(&mut self, content: &[u8], decoder: &mut EntityDecoder) -> Result<(), String> {
        let mut scanner = EntityScanner::new(content);
        while let Some((id, name, _, _)) = scanner.next_entity() {
            let slot = match name {
                "IFCSTYLEDITEM" | "IfcStyledItem" => 0,
                "IFCINDEXEDTRIANGLETEXTUREMAP" | "IFCINDEXEDPOLYGONALTEXTUREMAP" => 1,
                "IFCTEXTUREMAP" => 2,
                _ => continue,
            };
            let entity = decoder.decode_by_id(id).map_err(|e| format!("section presentation #{id}: {e}"))?;
            if let Some(target) = entity.ref_at(slot) { self.attachments.entry(target).or_default().push(id); }
        }
        Ok(())
    }

    /// A clean mesh group is insufficient. Require an actual clean job receipt
    /// AND readable forward body/placement references. Global drops/refusals also
    /// refuse the crop: shared source caches do not carry per-product loss provenance.
    /// No aggregate top-N list is used as evidence that an omitted product is clean.
    pub(super) fn require_product(
        &self, id: u32, decoder: &mut EntityDecoder, stats: &ProcessingStats,
    ) -> Result<bool, String> {
        self.audit.require_complete(id).map_err(|e| format!("section export {e}"))?;
        let (body, mut textured) = source_graph(id, decoder)
            .map_err(|e| format!("section export incomplete product #{id}: {e}"))?;
        for attachment in body.iter().filter_map(|target| self.attachments.get(target)).flatten() {
            let (_, has_texture) = source_graph(*attachment, decoder)
                .map_err(|e| format!("section export incomplete product #{id}: {e}"))?;
            let is_map = decoder.decode_by_id(*attachment).map_err(|e| e.to_string())?.ifc_type != IfcType::IfcStyledItem;
            textured |= has_texture || is_map;
            // Unavailable images/UVs must not make a textured body look untextured.
        }
        let d = stats.geometry_diagnostics.as_ref();
        if stats.total_csg_failures > 0 || stats.refused_input_elements > 0
            || stats.refused_prepass_records > 0 || stats.degenerate_triangles_dropped > 0
            || d.is_some_and(|d| d.has_issues() || d.oversized_ref_drops > 0) {
            return Err(format!("section export cannot certify product #{id}: model processing diagnostics may affect shared geometry"));
        }
        Ok(textured)
    }
}

/// Integrity is a pure property of an id, so global visitation within this walk
/// is correct for DAGs. Iteration avoids stack overflow; the work bound includes
/// attribute/list visits, not only ids. This does not implement any geometry.
fn source_graph(root: u32, decoder: &mut EntityDecoder) -> Result<(BTreeSet<u32>, bool), String> {
    const MAX_SOURCE_WORK: usize = 1_000_000;
    let mut visited = HashSet::new();
    let mut pending = vec![root];
    let mut work = 0usize;
    let mut textured = false;
    while let Some(id) = pending.pop() {
        if !visited.insert(id) { continue; }
        let entity = decoder.decode_by_id(id).map_err(|e| format!("unreadable reference #{id}: {e}"))?;
        textured |= entity.ifc_type == IfcType::IfcSurfaceStyleWithTextures;
        let mut values: Vec<_> = entity.attributes.iter().collect();
        while let Some(value) = values.pop() {
            work += 1;
            if work > MAX_SOURCE_WORK { return Err("source integrity work budget exceeded".into()); }
            match value {
                AttributeValue::EntityRef(id) => pending.push(*id),
                AttributeValue::List(items) => values.extend(items),
                AttributeValue::Typed { value, .. } => values.push(value),
                _ => {}
            }
        }
    }
    Ok((visited.into_iter().collect(), textured))
}
