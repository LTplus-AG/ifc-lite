// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Load-time context shared by both canonical appearance passes.
use crate::stream_meta::{resolve_stream_meta, MetaMode, StreamMeta};
use ifc_lite_core::{keyword_eq, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{GeometryRouter, MaterialLayerIndex};
use std::sync::Arc;

pub(super) struct Context {
    pub meta: StreamMeta,
    pub layers: Arc<MaterialLayerIndex>,
}
impl Context {
    pub fn new(bytes: &[u8], decoder: &mut EntityDecoder<'_>) -> Self {
        // Only the project-id hint and the site span are collected here; the
        // RTC sample window is the file's, resolved inside the detector (#4611).
        let mut scanner = EntityScanner::new(bytes);
        let mut project = None;
        let mut site = None;
        while let Some((id, name, start, end)) = scanner.next_entity() {
            if keyword_eq(name, "IFCPROJECT") && project.is_none() {
                project = Some(id);
            }
            if keyword_eq(name, "IFCSITE") && site.is_none() {
                site = Some((id, start, end));
            }
            if project.is_some() && site.is_some() {
                break;
            }
        }
        let meta = resolve_stream_meta(MetaMode::SmallFileSingle, bytes, project, site, decoder);
        let layers = Arc::new(MaterialLayerIndex::from_content(bytes, decoder));
        Self { meta, layers }
    }
    pub fn router(&self) -> GeometryRouter {
        self.configure(GeometryRouter::with_scale(self.meta.length_unit_scale))
    }
    /// Evaluated-occurrence identity and replacement use one frame on every
    /// target. Other appearance paths retain their established native output.
    pub fn evaluated_router(&self) -> GeometryRouter {
        self.configure(GeometryRouter::with_scale_and_local_frame(self.meta.length_unit_scale, true))
    }
    fn configure(&self, mut router: GeometryRouter) -> GeometryRouter {
        if self.meta.length_unit_refused.is_some() {
            router.refuse_length_unit(); // #7678: no mesh against a refused unit
        }
        router.set_rtc_offset(self.meta.frame.rtc_offset());
        router.set_material_layer_index(Arc::clone(&self.layers));
        router
    }
}
