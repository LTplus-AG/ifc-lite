// SPDX-License-Identifier: MPL-2.0
//! Atomic final or shape-only publication after all available proofs.
use super::runtime::ReceiptEvidence;
use super::*;
use ifc_lite_geometry::program::transactions::Requirement;

#[derive(Debug)]
pub struct ShapeOnlyProduct {
    pub product_id: u32,
    pub ifc_type: IfcType,
    pub parts: Vec<ShapePart>,
    pub band_ms: f64,
    pub cap_ms: f64,
    pub max_snap_metres: f64,
    pub cuts: u64,
    pub consumed_parts: usize,
    pub cut_times_ms: Vec<f64>,
    /// Report-only M8 geometry diagnostic: attributed planes with off-plane vertices.
    pub normal_planar_fallbacks: usize,
    pub obligations: PresentationObligationsUnmet,
    pub(super) _storage: Storage,
}
impl ShapeOnlyProduct {
    /// M11-Z: publication is final exactly when every presentation proof is discharged.
    pub fn marker(&self) -> &'static str {
        if self.obligations.0.is_empty() { "final" } else { "PresentationObligationsUnmet" }
    }
}
#[derive(Debug)]
pub struct ShapePart {
    pub layer: Option<ifc_lite_geometry::program::transactions::ShapeLayer>,
    /// Closed kernel band volume before interface-cap removal.
    pub capped_volume_m3: Option<f64>,
    /// Object-local metres, never f32 display coordinates.
    pub positions: Vec<f64>,
    pub indices: Vec<u32>,
    /// Column-major object metres -> absolute IFC Z-up world metres.
    pub world_from_object: [f64; 16],
    pub curved: bool,
    /// An executed plain-plane clip on this part's host lineage; bounds skips are false.
    pub halfspace_clipped: bool,
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
        for (part_index, value) in self.plan.values().enumerate() {
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
                ReceiptEvidence::Affine { .. } => {
                    let (part, sources) = super::affine_final::bake(&self.ledger, realization,
                        value.object_frame(), &self.resources, &mut storage)?;
                    parts.push(part);
                    face_sources.push(sources);
                    continue;
                }
            };
            if indices.is_empty() {
                return Err(incomplete());
            }
            face_sources.push(presentation::face_sources(realization, self.plan.layers().is_some())?);
            let mut part = super::publication_mesh::copy_part(
                runtime::ReceiptMesh { positions, indices, faces },
                *value.object_frame(), curved, &self.resources, &mut storage,
            )?;
            part.layer = self.plan.layers().map(|l| l.tags[part_index]);
            // A band is curved through its interface family or its host's own
            // source (an arc-profile wall with planar layers, #7955).
            part.curved = self.plan.layers().map_or(curved, |l| {
                l.interfaces.iter().any(|&s| super::layer_caps::curved(s)) || host_curved(realization)
            });
            part.halfspace_clipped = realization.halfspace_clipped();
            parts.push(part);
        }
        if parts.is_empty() {
            return Err(incomplete());
        }
        let mut max_snap_metres = 0.;
        let mut cap_ms = 0.;
        if let Some(layers) = self.plan.layers() {
            // Conservative storage reservation for coordinate-key maps, triangle
            // copies and seam indices. Split growth is charged at each append.
            let units: usize = parts.iter().map(|p| p.positions.len()+p.indices.len()).sum();
            storage.charge(&self.resources, resource::Cost { live_bytes: (units as u64).saturating_mul(192),
                work: (units as u64)/3, ..Default::default() })?;
            for part in &mut parts {
                let origin = super::layer_mesh::point(part,part.indices[0]);
                part.capped_volume_m3 = Some(super::layer_mesh::volume(std::slice::from_ref(part),origin).abs());
            }
            let start = super::phase_timer::PhaseTimer::now();
            max_snap_metres = super::layer_caps::remove(&mut parts,layers)?;
            cap_ms = start.elapsed().as_secs_f64()*1000.;
        }
        let mut remaining = Vec::new();
        storage.reserve(
            &self.resources,
            &mut remaining,
            self.plan.requirements().count(),
        )?;
        remaining.extend(self.plan.requirements());
        let obligations = PresentationObligationsUnmet(remaining);
        let (_, cuts, consumed_parts) = self.plan.opening().unwrap_or_default();
        let mut cut_times_ms = Vec::new();
        storage.reserve(&self.resources, &mut cut_times_ms, self.cut_times_ms.len())?;
        cut_times_ms.extend_from_slice(&self.cut_times_ms);
        let mut product = ShapeOnlyProduct {
            cuts, consumed_parts, cut_times_ms, normal_planar_fallbacks: 0,
            band_ms: self.band_ms, cap_ms, max_snap_metres,
            product_id: self.product_id,
            ifc_type: self.ifc_type.clone(),
            parts,
            obligations,
            _storage: storage,
        };
        let discharged = presentation::apply(&mut product, &presentation::Context {
            layer_class: self.layer_class, plan: &self.plan, model: &self.presentation_context,
            resources: &self.resources, element_color: self.element_color, faces: &face_sources,
            chord_metres: self.limits.chord_metres,
            angle_degrees: self.limits.angle_degrees,
        })?;
        product.obligations.0.retain(|r| !discharged.contains(r));
        Ok(product)
    }
}
/// The left-most construction under a band's Intersection: the host's source,
/// through any opening cuts or affine copies.
fn host_curved<R: NumericalReceipt>(band: &RuntimeRealization<R>) -> bool {
    let mut node = band._inputs[0].as_deref();
    while let Some(host) = node {
        if let ReceiptEvidence::Construction(completion) = host.kind.evidence() {
            return curved_recipe(completion.request().recipe());
        }
        node = host._inputs[0].as_deref();
    }
    true
}
pub(super) fn curved_recipe(recipe: &RetainedRecipe) -> bool {

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
