// SPDX-License-Identifier: MPL-2.0
//! Public layer adapters drain the same common source/child/numerical machine.
use super::GeometryRouter;
use crate::material_layer_index::LayerBuildup;
use crate::{Result, SubMeshCollection};
use ifc_lite_core::{DecodedEntity, EntityDecoder};
use rustc_hash::FxHashMap;

impl GeometryRouter {
    /// Slice an element's actual voided host by the supplied material buildup.
    /// Direct callers retain every successful candidate, including fewer than
    /// two output bands; the styled gateway applies its own fallback policy.
    pub fn process_element_with_material_layers(&self, element: &DecodedEntity,
        decoder: &mut EntityDecoder, buildup: &LayerBuildup,
        void_index: &FxHashMap<u32, Vec<u32>>) -> Result<Option<SubMeshCollection>> {
        let mut program = crate::program::GeometryProgram::material_layers(element.clone(), buildup.clone());
        while let Some(request) = program.request().expect("canonical material-layer request") {
            let reply = program.execute_with_inputs(request, self, decoder, None, Some(void_index))
                .expect("canonical material-layer execution");
            program.accept(reply, self).expect("canonical material-layer acceptance");
        }
        program.finish_layer_candidate()
    }
}
