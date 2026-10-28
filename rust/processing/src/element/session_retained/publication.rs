// SPDX-License-Identifier: MPL-2.0
//! Atomic shape-only publication; layer and display obligations remain.
use super::runtime::ReceiptEvidence;
use super::*;
use ifc_lite_geometry::program::transactions::Requirement;

#[derive(Debug)]
pub struct ShapeOnlyProduct {
    pub product_id: u32,
    pub ifc_type: IfcType,
    pub parts: Vec<ShapePart>,
    pub cuts: u64,
    pub consumed_parts: usize,
    pub cut_times_ms: Vec<f64>,
    pub obligations: PresentationObligationsUnmet,
    pub(super) _storage: Storage,
}
#[derive(Debug)]
pub struct ShapePart {
    /// Object-local metres, never f32 display coordinates.
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
    /// Column-major object metres -> absolute IFC Z-up world metres.
    pub world_from_object: [f64; 16],
    pub curved: bool,
    /// Kernel revision-local diagnostics, never persistent IFC face identity.
    pub revision_local_faces: Vec<u32>,
    /// Per-corner unit normals in absolute IFC Z-up axes (placement already applied).
    pub normals: Option<Vec<f64>>,
    pub appearance: Option<PartAppearance>,
    pub faces: Option<PartFaces>,
    pub instance_key: Option<[u8; 32]>,
}
#[derive(Debug)]
pub struct PartAppearance {
    pub rgba: [f32; 4],
    pub geometry_class: u8,
    pub style_id: Option<u32>,
    pub material_name: Option<String>,
    pub geometry_item_id: Option<u32>,
    pub material_id: Option<u32>,
}
/// Source-derived key: item + optional cutter + canonical source role, never a kernel face index.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FaceKey {
    pub item: u32,
    pub via: u32,
    pub role: String,
}
impl std::fmt::Display for FaceKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.via == 0 { write!(f, "#{}:{}", self.item, self.role) }
        else { write!(f, "#{}>#{}:{}", self.item, self.via, self.role) }
    }
}
#[derive(Debug)]
pub struct PartFaces {
    pub table: Vec<FaceKey>,
    /// One table index per triangle.
    pub triangles: Vec<u32>,
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
        let mut face_sources = Vec::new();
        storage.reserve(&self.resources, &mut face_sources, self.plan.values().len())?;
        for value in self.plan.values() {
            let (_, realization) = self
                .ledger
                .iter()
                .find(|(v, _)| v.as_ref().definition() == value.definition())
                .ok_or_else(|| protocol(ReceiptFailure::UndischargedDefinition))?;
            if realization.is_empty() {
                return Err(protocol(ReceiptFailure::EmptyConstructionResult));
            }
            let (positions, indices, faces, curved) = match realization.kind.evidence() {
                ReceiptEvidence::Construction(completion) => (
                    completion.tessellation.positions.as_slice(),
                    completion.tessellation.indices.as_slice(),
                    completion.tessellation.revision_local_faces.as_slice(),
                    curved_recipe(completion.request().recipe()),
                ),
                ReceiptEvidence::Boolean { .. } => {
                    let mesh = realization.kind.mesh().ok_or_else(incomplete)?;
                    // Boolean comparisons have no nominal source expectation and
                    // follow the report-only curved policy, even with flat inputs.
                    (mesh.positions, mesh.indices, mesh.faces, true)
                }
                ReceiptEvidence::Affine { .. } => return Err(incomplete()),
            };
            if indices.is_empty() {
                return Err(incomplete());
            }
            face_sources.push(presentation::face_sources(realization)?);
            parts.push(super::publication_mesh::copy_part(
                runtime::ReceiptMesh { positions, indices, faces },
                *value.object_frame(), curved, &self.resources, &mut storage,
            )?);
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
        // Layer/appearance/face obligations remain after opening completion. This
        // guards the shape-only invariant, not a supported fully discharged
        // path: final-product publication needs separate authority, and
        // require_final_product deliberately still refuses (M1 spec section 3).
        if obligations.0.is_empty() {
            return Err(incomplete());
        }
        let (_, cuts, consumed_parts) = self.plan.opening().unwrap_or_default();
        let mut cut_times_ms = Vec::new();
        storage.reserve(&self.resources, &mut cut_times_ms, self.cut_times_ms.len())?;
        cut_times_ms.extend_from_slice(&self.cut_times_ms);
        let mut product = ShapeOnlyProduct {
            cuts, consumed_parts, cut_times_ms,
            product_id: self.product_id,
            ifc_type: self.ifc_type.clone(),
            parts,
            obligations,
            _storage: storage,
        };
        let discharged = presentation::apply(&mut product, &presentation::Context {
            plan: &self.plan, model: &self.presentation_context,
            resources: &self.resources, element_color: self.element_color, faces: &face_sources,
            chord_metres: self.chord_metres,
        })?;
        product.obligations.0.retain(|r| !discharged.contains(r));
        if product.obligations.0.is_empty() { return Err(incomplete()); }
        Ok(product)
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
