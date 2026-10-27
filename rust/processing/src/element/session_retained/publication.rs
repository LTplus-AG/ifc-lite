// SPDX-License-Identifier: MPL-2.0
//! Atomic shape-only publication; no opening, layer, or display authority.
use super::runtime::ReceiptEvidence;
use super::*;
use ifc_lite_geometry::program::transactions::Requirement;

#[derive(Debug)]
pub struct ShapeOnlyProduct {
    pub product_id: u32,
    pub ifc_type: IfcType,
    pub parts: Vec<ShapePart>,
    pub obligations: PresentationObligationsUnmet,
    _storage: Storage,
}
#[derive(Debug)]
pub struct ShapePart {
    /// Object-local metres, never f32 display coordinates.
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
    /// Column-major object metres -> absolute IFC Z-up world metres.
    pub world_from_object: [f64; 16],
    pub curved: bool,
}
#[derive(Debug)]
pub struct PresentationObligationsUnmet(pub Vec<Requirement>);

fn incomplete() -> RetainedExecutionError {
    RetainedExecutionError::Unsupported(
        Unsupported::RetainedFinalPublicationRequiresOpeningLayerAppearanceFaceProofs,
    )
}
impl<R: NumericalReceipt> witness::RuntimeProductWitness<R> {
    pub fn publish_shape(self) -> Result<ShapeOnlyProduct, RetainedExecutionError> {
        self.validate()?;
        let result = self.resources.with_scope(|| self.shape_in_scope());
        // Atomic even if the source/runtime expires during copying.
        self.validate()?;
        result
    }
    fn shape_in_scope(&self) -> Result<ShapeOnlyProduct, RetainedExecutionError> {
        require_placement(self.plan.requirements())?;
        let mut parts = Vec::new();
        let mut storage = Storage::default();
        storage.reserve(&self.resources, &mut parts, self.plan.values().len())?;
        for value in self.plan.values() {
            let (_, realization) = self
                .ledger
                .iter()
                .find(|(v, _)| v.as_ref().definition() == value.definition())
                .ok_or_else(|| protocol(ReceiptFailure::UndischargedDefinition))?;
            if realization.is_empty() {
                return Err(protocol(ReceiptFailure::EmptyConstructionResult));
            }
            let (positions, indices, curved) = match realization.kind.evidence() {
                ReceiptEvidence::Construction(completion) => (
                    completion.tessellation.positions.as_slice(),
                    completion.tessellation.indices.as_slice(),
                    curved_recipe(completion.request().recipe()),
                ),
                ReceiptEvidence::Boolean { .. } => {
                    let mesh = realization.kind.mesh().ok_or_else(incomplete)?;
                    // Boolean comparisons have no nominal source expectation and
                    // follow the report-only curved policy, even with flat inputs.
                    (mesh.positions, mesh.indices, true)
                }
                ReceiptEvidence::Affine { .. } => return Err(incomplete()),
            };
            if indices.is_empty() {
                return Err(incomplete());
            }
            let mut copied_positions = Vec::new();
            let mut copied_indices = Vec::new();
            storage.reserve(&self.resources, &mut copied_positions, positions.len())?;
            storage.reserve(&self.resources, &mut copied_indices, indices.len())?;
            copied_positions.extend_from_slice(positions);
            copied_indices.extend_from_slice(indices);
            parts.push(ShapePart {
                positions: copied_positions,
                indices: copied_indices,
                // The controller composes each placement once in frame::compose_frame;
                // object_frame is already the final accumulated occurrence frame.
                world_from_object: *value.object_frame(),
                curved,
            });
        }
        if parts.is_empty() {
            return Err(incomplete());
        }
        let mut remaining = Vec::new();
        storage.reserve(
            &self.resources,
            &mut remaining,
            self.plan.requirements().count(),
        )?;
        remaining.extend(self.plan.requirements());
        let obligations = PresentationObligationsUnmet(remaining);
        // M1 plan completion always retains opening/layer/appearance/face
        // obligations; the public plan exposes no way to discharge them. This
        // guards the shape-only invariant, not a supported fully discharged
        // path: final-product publication needs separate authority, and
        // require_final_product deliberately still refuses (M1 spec section 3).
        if obligations.0.is_empty() {
            return Err(incomplete());
        }
        Ok(ShapeOnlyProduct {
            product_id: self.product_id,
            ifc_type: self.ifc_type.clone(),
            parts,
            obligations,
            _storage: storage,
        })
    }
}
fn curved_recipe(recipe: &RetainedRecipe) -> bool {
    match recipe {
        RetainedRecipe::Extrusion(value) => value.source.profile.as_ref().is_none_or(|profile| {
            profile
                .loops
                .iter()
                .flat_map(|boundary| &boundary.segments)
                .any(|segment| {
                    !matches!(
                        segment,
                        ifc_lite_geometry::analytic::AnalyticCurveSegment::Line { .. }
                    )
                })
        }),
        _ => true,
    }
}

fn require_placement(
    mut requirements: impl Iterator<Item = Requirement>,
) -> Result<(), RetainedExecutionError> {
    if requirements.any(|r| r == Requirement::ProductPlacement) {
        return Err(incomplete());
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    // #7955: a type-map plan has geometry but no product placement authority.
    #[test]
    fn publication_refuses_outstanding_product_placement() {
        let error = require_placement(
            [Requirement::IfcAppearance, Requirement::ProductPlacement].into_iter(),
        )
        .unwrap_err();
        assert_eq!(error.refusal().0.code(), "incomplete");
        assert!(require_placement([Requirement::IfcAppearance].into_iter()).is_ok());
    }
}
