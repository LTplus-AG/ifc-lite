// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Load-time context shared by both canonical appearance passes.
use crate::stream_meta::{resolve_stream_meta, MetaMode, StreamMeta};
use ifc_lite_core::{EntityDecoder, EntityScanner, IfcType};
use ifc_lite_geometry::{GeometryRouter, MaterialLayerIndex};
use std::sync::Arc;

pub(super) struct Context {
    pub meta: StreamMeta,
    pub layers: Arc<MaterialLayerIndex>,
}
impl Context {
    pub fn new(bytes: &[u8], decoder: &mut EntityDecoder<'_>) -> Self {
        let mut scanner = EntityScanner::new(bytes);
        let mut jobs = Vec::new();
        let mut project = None;
        let mut site = None;
        while let Some((id, name, start, end)) = scanner.next_entity() {
            if name == "IFCPROJECT" && project.is_none() {
                project = Some(id);
            }
            if name == "IFCSITE" && site.is_none() {
                site = Some((id, start, end));
            }
            if name == "IFCSITE"
                || ifc_lite_core::has_geometry_by_name(name)
                || (ifc_lite_core::is_representationless_spatial_container_by_name(name)
                    && ifc_lite_core::nth_attribute_is_present(&bytes[start..end], 6))
            {
                jobs.push((id, start, end, IfcType::from_str(name)));
            }
        }
        let meta = resolve_stream_meta(
            MetaMode::SmallFileSingle,
            bytes,
            project,
            site,
            &jobs,
            decoder,
        );
        let layers = Arc::new(MaterialLayerIndex::from_content(bytes, decoder));
        Self { meta, layers }
    }
    pub fn router(&self) -> GeometryRouter {
        let mut router = GeometryRouter::with_scale(self.meta.length_unit_scale);
        if self.meta.needs_shift {
            router.set_rtc_offset(self.meta.rtc_offset);
        }
        router.set_material_layer_index(Arc::clone(&self.layers));
        router
    }
}
