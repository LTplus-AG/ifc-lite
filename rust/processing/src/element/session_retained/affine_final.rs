// SPDX-License-Identifier: MPL-2.0
//! M10: bake only the linear part of sealed affine finals; translation stays rigid.
use super::*;
use super::runtime::{NumericalLimits, ReceiptEvidence, RuntimeFault};
use ifc_lite_geometry::analytic::{AnalyticCurveSegment, OwnedDirectrix};
use ifc_lite_geometry::document::{retained_wire, PrismSegment};
use nalgebra::Matrix3;
const IDENTITY: [f64; 16] = [1.,0.,0.,0., 0.,1.,0.,0., 0.,0.,1.,0., 0.,0.,0.,1.];
fn incomplete() -> RetainedExecutionError {
    RetainedExecutionError::Unsupported(Unsupported::RetainedFinalPublicationRequiresOpeningLayerAppearanceFaceProofs)
}
fn contract() -> RetainedExecutionError { RuntimeFault::contract("invalid affine final lineage or frame").into() }
fn linear(m: [f64; 16]) -> [f64; 9] { [m[0],m[1],m[2],m[4],m[5],m[6],m[8],m[9],m[10]] }
fn singular(l: [f64; 9]) -> (f64, f64) {
    if l.iter().any(|v| !v.is_finite()) { return (f64::NAN, f64::NAN); }
    let s = Matrix3::from_column_slice(&l).singular_values();
    (s.min(), s.max())
}
/// Conservative image curvature radius, including anisotropy (M10 §3.3).
pub fn effective_radius_through_affine(r: f64, l: [f64; 9]) -> f64 {
    if r == 0. { return 0.; }
    let (min, max) = singular(l);
    if min > 0. { r * max * max / min } else { f64::INFINITY }
}
/// Preregistered sagitta bound. Unknown radii permit only contraction/isometry.
pub fn affine_chord_admissible(sigma_max: f64, radius_m: f64, limits: NumericalLimits) -> bool {
    if !sigma_max.is_finite() || sigma_max <= 0. || radius_m.is_nan() || radius_m < 0.
        || limits.validate().is_err() { return false; }
    radius_m == 0. || sigma_max * limits.chord_metres.min(
        radius_m * (1. - limits.angle_degrees.to_radians().cos())) <= limits.chord_metres * (1. + 1e-12)
}
fn transform(m: [f64; 16], positions: &mut [f64], indices: &mut [u32]) {
    for p in positions.chunks_exact_mut(3) {
        let q = [p[0], p[1], p[2]];
        for i in 0..3 { p[i] = m[i]*q[0] + m[4+i]*q[1] + m[8+i]*q[2]; }
    }
    if Matrix3::from_column_slice(&linear(m)).determinant() < 0. {
        for triangle in indices.chunks_exact_mut(3) { triangle.swap(1, 2); }
    }
}
/// Pure witness of the production in-place transform; publication reserves before copying.
pub fn bake_mesh(m: [f64; 16], positions: &[f64], indices: &[u32]) -> (Vec<f64>, Vec<u32>, [f64; 3]) {
    let (mut p, mut i) = (positions.to_vec(), indices.to_vec());
    transform(m, &mut p, &mut i);
    (p, i, [m[12],m[13],m[14]])
}
fn chain<R: NumericalReceipt>(mut node: &RuntimeRealization<R>, bound: usize)
    -> Result<(&RuntimeRealization<R>, [f64; 16]), RetainedExecutionError> {
    let mut matrix = IDENTITY;
    for _ in 0..=bound {
        match node.kind.evidence() {
            ReceiptEvidence::Affine { input, column_major } => {
                matrix = retained_wire::multiply(matrix, *column_major);
                let [Some(parent), None] = &node._inputs else { return Err(contract()); };
                if parent.kind.object() != input { return Err(contract()); }
                node = parent;
            }
            _ => return Ok((node, matrix)),
        }
    }
    Err(contract())
}
fn segment_radius(s: &AnalyticCurveSegment) -> f64 {
    match s { AnalyticCurveSegment::Line { .. } => 0., AnalyticCurveSegment::Arc { radius, .. } => *radius }
}
fn recipe_radius(recipe: &RetainedRecipe) -> f64 {
    match recipe {
        RetainedRecipe::Extrusion(e) => e.source.profile.as_ref().map_or(f64::INFINITY, |p|
            p.loops.iter().flat_map(|b| &b.segments).map(segment_radius).fold(0., f64::max) * e.length_unit_scale),
        RetainedRecipe::SweptDisk(d) => {
            // Arbitrary rational curvature is unproven, never treated as a line.
            if matches!(d.source.owned_directrix, Some(OwnedDirectrix::Rational(_))) { return f64::INFINITY; }
            (d.source.radius + d.source.segments.iter().map(segment_radius).fold(0., f64::max)) * d.length_unit_scale
        }
        RetainedRecipe::Prism(p) => p.loops.iter().flat_map(|l| &l.segments).map(|s| match s {
            PrismSegment::Line { .. } => 0., PrismSegment::Arc { radius, .. } | PrismSegment::Circle { radius, .. } => *radius,
        }).fold(0., f64::max),
        _ => f64::INFINITY,
    }
}
fn radius<R: NumericalReceipt>(root: &RuntimeRealization<R>, resources: &OwnedResourceContext)
    -> Result<f64, RetainedExecutionError> {
    let mut stack = Vec::new();
    let mut storage = Storage::default();
    storage.reserve(resources, &mut stack, 1)?;
    stack.push((root, 1.));
    let mut result: f64 = 0.;
    let mut visits = 0;
    while let Some((node, factor)) = stack.pop() {
        visits += 1;
        if visits > 8192 { return Err(incomplete()); }
        resource::charge(resource::Cost { work: 1, ..Default::default() }).map_err(RetainedExecutionError::Stopped)?.retain();
        match node.kind.evidence() {
            ReceiptEvidence::Construction(c) => {
                let r = recipe_radius(c.request().recipe());
                result = result.max(if r == 0. { 0. } else { r * factor });
            }
            ReceiptEvidence::Affine { column_major, .. } => {
                let [Some(input), None] = &node._inputs else { return Err(contract()); };
                storage.reserve(resources, &mut stack, 1)?;
                stack.push((input, factor * effective_radius_through_affine(1., linear(*column_major))));
            }
            ReceiptEvidence::Boolean { .. } => {
                let [Some(a), Some(b)] = &node._inputs else { return Err(contract()); };
                storage.reserve(resources, &mut stack, 2)?;
                stack.push((a, factor)); stack.push((b, factor));
            }
        }
    }
    Ok(result)
}
pub(super) fn admit<R: NumericalReceipt>(witness: &witness::RuntimeProductWitness<R>, limits: NumericalLimits)
    -> Result<(), RetainedExecutionError> {
    witness.resources.with_scope(|| {
        for value in witness.plan.values() {
            let (_, node) = witness.ledger.iter().find(|(v, _)| v.as_ref().definition() == value.definition()).ok_or_else(contract)?;
            if !matches!(node.kind.evidence(), ReceiptEvidence::Affine { .. }) { continue; }
            let (base, matrix) = chain(node, witness.ledger.len())?;
            if !affine_chord_admissible(singular(linear(matrix)).1, radius(base, &witness.resources)?, limits) {
                return Err(incomplete());
            }
        }
        Ok(())
    })
}
pub(super) fn bake<R: NumericalReceipt>(ledger: &[(LogicalRetainedValue, Arc<RuntimeRealization<R>>)],
    realization: &Arc<RuntimeRealization<R>>, object_frame: &[f64;16], resources: &OwnedResourceContext, storage: &mut Storage)
    -> Result<(publication::ShapePart, presentation::FaceSources), RetainedExecutionError> {
    retained_wire::rigid(*object_frame).map_err(|_| contract())?;
    let (base, matrix) = chain(realization, ledger.len())?;
    let (mesh, curved) = match base.kind.evidence() {
        ReceiptEvidence::Construction(c) => (runtime::ReceiptMesh { positions: &c.tessellation.positions,
            indices: &c.tessellation.indices, faces: &c.tessellation.revision_local_faces }, publication::curved_recipe(c.request().recipe())),
        ReceiptEvidence::Boolean { .. } => (base.kind.mesh().ok_or_else(incomplete)?, true),
        _ => return Err(contract()),
    };
    if mesh.indices.is_empty() { return Err(incomplete()); }
    let mut translation = IDENTITY;
    translation[12..15].copy_from_slice(&matrix[12..15]);
    let frame = retained_wire::multiply(*object_frame, translation);
    let mut part = super::publication_mesh::copy_part(mesh, frame, curved, resources, storage)?;
    resource::charge(resource::Cost { work: 1, ..Default::default() }).map_err(RetainedExecutionError::Stopped)?.retain();
    transform(matrix, &mut part.positions, &mut part.indices);
    if part.positions.iter().chain(part.world_from_object.iter()).any(|x| !x.is_finite()) { return Err(contract()); }
    let mut sources = presentation::face_sources(realization)?;
    // M11-F pulls triangles back into source coordinates. Our local frame omits
    // the affine translation, so put it back before applying that pullback.
    if let Ok(operands) = &mut sources {
        for operand in operands { operand.from_part = retained_wire::multiply(operand.from_part, translation); }
    }
    Ok((part, sources))
}
