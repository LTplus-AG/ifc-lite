// SPDX-License-Identifier: MPL-2.0
use super::GeometryRouter;
use crate::{construction::ConstructionBatch, Result};
use ifc_lite_core::EntityDecoder;

impl GeometryRouter {
    /// Plan raw representation-item constructions with this router's quality
    /// and extension-dispatch policy. The item limit bounds root scheduling,
    /// not memory. Unlowered constructors and custom processors are explicit
    /// requirements; they prevent batch evaluation. See [`ConstructionBatch`]
    /// for the file-unit coordinate and intentionally partial coverage contract.
    pub fn plan_construction_items(
        &self,
        decoder: &mut EntityDecoder,
        roots: &[u32],
        max_items: usize,
    ) -> Result<ConstructionBatch> {
        ConstructionBatch::compile(self, self.schema, decoder, roots, max_items)
    }
}
