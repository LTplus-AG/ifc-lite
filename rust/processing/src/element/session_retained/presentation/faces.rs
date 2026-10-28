// SPDX-License-Identifier: MPL-2.0
//! Persistent IFC face identity (#7955 M11-F). `FaceKey{item, via, role}` is
//! derived by source-surface incidence over the part's own Boolean lineage and
//! cross-checked against the kernel's revision-local faces; it is never a
//! `GetFaces` index. Unattributable or ambiguous parts refuse the product.
use super::face_attribution::{candidates, resolve, Choice, Operand, Unproven};
use super::face_surfaces::{self, NoFaces};
use super::{Context, Requirement, ShapeOnlyProduct};
use super::super::publication::{FaceKey, PartFaces};
use super::super::runtime::{NumericalReceipt, ReceiptEvidence};
use super::super::value::RuntimeRealization;
use super::super::RetainedExecutionError;
use ifc_lite_geometry::{program::transactions::relative_frame, resource, BoolOp};
use std::sync::Arc;

/// One part's construction leaves in left-first lineage order, or why none exist.
pub(in super::super) type FaceSources = Result<Vec<Operand>, Unproven>;

fn charge(work: usize, live_bytes: usize) -> Result<(), RetainedExecutionError> {
    resource::charge(resource::Cost { work: work as u64, live_bytes: live_bytes as u64, ..Default::default() })
        .map_err(RetainedExecutionError::Stopped)?.retain();
    Ok(())
}

/// Column-major `a * b`.
fn compose(a: &[f64; 16], b: &[f64; 16]) -> [f64; 16] {
    std::array::from_fn(|i| (0..4).map(|k| a[k * 4 + i % 4] * b[i / 4 * 4 + k]).sum())
}
fn transposed(m: &[f64; 16]) -> [f64; 16] { std::array::from_fn(|i| m[i % 4 * 4 + i / 4]) }
/// Column-major inverse of a sealed affine copy, through the shared row-major home.
fn inverse(m: &[f64; 16]) -> Option<[f64; 16]> {
    ifc_lite_geometry::math::mat4::affine_inverse(&transposed(m)).map(|r| transposed(&r))
}
fn determinant(m: &[f64; 16]) -> f64 {
    m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2])
}
/// Spectral norm of the linear part (power iteration on LᵀL; exactly 1 when rigid).
fn stretch(m: &[f64; 16]) -> f64 {
    let apply = |v: [f64; 3], t: bool| -> [f64; 3] {
        std::array::from_fn(|i| (0..3).map(|k| if t { m[i * 4 + k] } else { m[k * 4 + i] } * v[k]).sum())
    };
    let mut v = [1., 0.7548776662466927, 0.5698402909980532];
    let mut norm = 1.;
    for _ in 0..64 {
        let w = apply(apply(v, false), true);
        norm = w.iter().map(|x| x * x).sum::<f64>().sqrt();
        if !(norm > 0.) { return f64::NAN; }
        v = w.map(|x| x / norm);
    }
    norm.sqrt()
}
const MAX_LINEAGE_NODES: usize = 8192;
const IDENTITY: [f64; 16] = [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.];

/// Places every construction leaf in the part's frame through each Boolean's
/// own sealed frames (operand evaluation frames at its issuance; later
/// placements move the whole result rigidly). Subtracted leaves are reversed;
/// an M3 cut's sealed opening is the `via` of its cutter subtree.
pub(in super::super) fn sources<R: NumericalReceipt>(root: &Arc<RuntimeRealization<R>>)
    -> Result<FaceSources, RetainedExecutionError> {
    let unattributed = |entity| Ok(Err(Unproven::Unattributed { entity }));
    let mut operands = Vec::new();
    // (node, node evaluation <- part, orientation, via)
    let mut stack = vec![(root, IDENTITY, 1., 0)];
    let mut visits = 0;
    while let Some((node, from_part, sign, via)) = stack.pop() {
        // Shared operands (`A ∪ A`) expand a DAG into a tree: bound the expansion.
        visits += 1;
        if visits > MAX_LINEAGE_NODES { return unattributed(None); }
        charge(1, 0)?;
        match node.kind.evidence() {
            ReceiptEvidence::Construction(completion) => {
                let request = completion.request();
                let item = request.recipe().solid_id();
                let (faces, region) = match face_surfaces::faces(request.recipe(), request.payload()) {
                    Ok(faces) => faces,
                    // M5/M6 halfspace and M4 band provenance join here through their hooks.
                    Err(NoFaces::Hook(id)) => return unattributed(Some(id)),
                    Err(NoFaces::Malformed) => return unattributed(Some(item)),
                };
                charge(faces.len(), std::mem::size_of::<Operand>()
                    + faces.len() * std::mem::size_of::<super::face_attribution::SourceFace>())?;
                let stretch = stretch(&from_part);
                if !stretch.is_finite() { return unattributed(Some(item)); }
                operands.push(Operand { item, via, from_part, sign, stretch, faces, region });
            }
            ReceiptEvidence::Boolean { operation, world_from_left, world_from_right, world_from_evaluation, .. } => {
                let [Some(left), Some(right)] = &node._inputs else { return unattributed(None) };
                let place = |world: &[f64; 16]| relative_frame(*world, *world_from_evaluation).map(|m| compose(&m, &from_part));
                let (Ok(left_frame), Ok(right_frame)) = (place(world_from_left), place(world_from_right))
                    else { return unattributed(None) };
                let flip = if operation == BoolOp::Difference { -sign } else { sign };
                stack.push((right, right_frame, flip, node.opening.unwrap_or(via)));
                stack.push((left, left_frame, sign, via));
            }
            // A sealed affine copy keeps its input's surfaces, mapped by its matrix (mirrors reverse them).
            ReceiptEvidence::Affine { column_major, .. } => {
                let ([Some(input), None], Some(back)) = (&node._inputs, inverse(column_major)) else { return unattributed(None) };
                stack.push((input, compose(&back, &from_part), sign * determinant(column_major).signum(), via));
            }
        }
    }
    Ok(Ok(operands))
}

fn refuse(unproven: Unproven) -> RetainedExecutionError {
    match unproven {
        Unproven::Unattributed { entity } => RetainedExecutionError::FaceProvenance { cause: "unattributed", entity },
        Unproven::Ambiguous { entity } => RetainedExecutionError::FaceProvenance { cause: "ambiguous", entity },
    }
}

pub(super) fn apply(product: &mut ShapeOnlyProduct, context: &Context<'_>) -> Result<Vec<Requirement>, RetainedExecutionError> {
    // Curved incidence is bounded by the evaluation chord; a coarser caller chord fails closed (unattributed).
    let chord = super::super::model::ModelOptions::default().limits.chord_metres;
    let ShapeOnlyProduct { parts, _storage: storage, .. } = product;
    if parts.len() != context.faces.len() { return Err(refuse(Unproven::Unattributed { entity: None })); }
    for (part, sources) in parts.iter_mut().zip(context.faces) {
        let operands = sources.as_ref().map_err(|unproven| refuse(*unproven))?;
        let count = part.indices.len() / 3;
        let kernel = &part.revision_local_faces;
        if kernel.len() != count { return Err(refuse(Unproven::Unattributed { entity: None })); }
        let work: usize = operands.iter().map(|o| o.faces.len()).sum();
        let mut order: Vec<usize> = Vec::new();
        storage.reserve(context.resources, &mut order, count)?;
        order.extend(0..count);
        order.sort_unstable_by_key(|&t| (kernel[t], t));
        let mut choices: Vec<Choice> = Vec::new();
        storage.reserve(context.resources, &mut choices, count)?;
        choices.resize(count, (0, 0));
        for face in order.chunk_by(|&a, &b| kernel[a] == kernel[b]) {
            let mut lists = Vec::with_capacity(face.len());
            charge(face.len(), face.len() * std::mem::size_of::<super::face_attribution::Candidates>())?;
            for &t in face {
                charge(work, 0)?;
                let corner = |i: u32| -> Option<[f64; 3]> {
                    let at = (i as usize).checked_mul(3)?;
                    part.positions.get(at..at + 3).map(|p| [p[0], p[1], p[2]])
                };
                let (Some(a), Some(b), Some(c)) = (corner(part.indices[3 * t]), corner(part.indices[3 * t + 1]),
                    corner(part.indices[3 * t + 2])) else { return Err(refuse(Unproven::Unattributed { entity: None })) };
                lists.push(candidates(operands, &[a, b, c], chord).map_err(refuse)?);
            }
            let key = resolve(&lists).map_err(refuse)?;
            for &t in face { choices[t] = key; }
        }
        let mut used: Vec<Choice> = Vec::new();
        storage.reserve(context.resources, &mut used, count)?;
        used.extend_from_slice(&choices);
        used.sort_unstable();
        used.dedup();
        let mut table = Vec::new();
        storage.reserve(context.resources, &mut table, used.len())?;
        for &(o, f) in &used {
            let role = operands[o].faces[f].role.to_string();
            charge(1, role.len())?;
            table.push(FaceKey { item: operands[o].item, via: operands[o].via, role });
        }
        let mut triangles = Vec::new();
        storage.reserve(context.resources, &mut triangles, count)?;
        triangles.extend(choices.iter().map(|c| used.binary_search(c).unwrap_or(0) as u32));
        part.faces = Some(PartFaces { table, triangles });
    }
    Ok(vec![Requirement::PersistentFaces])
}
