// SPDX-License-Identifier: MPL-2.0

//! Retry a rejected recess after removing the shared faces of closed host shells (#10512).

use crate::csg::{ClippingProcessor, GroupCut};
use crate::exact_topology::strict_closed_mesh;
use crate::mesh_check::{signed_volume, EdgeLedger};
use crate::Mesh;
use rustc_hash::FxHashMap;

/// Union consistently wound shells without losing material, then subtract
/// the authored cutter under the same accept gates as the first attempt.
pub(super) fn try_cut(host: &Mesh, cutter: &Mesh) -> Option<Mesh> {
    if crate::resource::check_current().is_err() || !strict_closed_mesh(cutter) {
        return None;
    }
    let cutter_volume = signed_volume(cutter);
    if !cutter_volume.is_finite() || cutter_volume <= 0.0 {
        return None;
    }
    let ranges = EdgeLedger::closed_shell_ranges(host)?;
    let mut shells: Vec<_> = ranges
        .into_iter()
        .map(|range| shell(host, &host.indices[range]))
        .collect();

    // Normalize uniformly inward-wound solids for the union. Mixed signs
    // may describe a solid and its cavity, so leave those hosts to the
    // existing fallback instead of turning the cavity into material.
    let winding = signed_volume(shells.first()?).signum();
    let source_volume = shells.iter_mut().try_fold(0.0, |total, shell| {
        let volume = winding * signed_volume(shell);
        if !volume.is_finite() || volume <= 0.0 {
            return None;
        }
        if winding < 0.0 {
            for triangle in shell.indices.chunks_exact_mut(3) {
                triangle.swap(1, 2);
            }
            for normal in &mut shell.normals {
                *normal = -*normal;
            }
        }
        Some(total + volume)
    })?;

    let clipper = ClippingProcessor::new();
    let union = clipper.union_meshes(&shells).ok()?;
    if clipper.failure_count() != 0 || !strict_closed_mesh(&union) {
        return None;
    }
    let union_volume = signed_volume(&union);
    // The same relative tolerance used when choosing between frame retries.
    let tolerance = source_volume * 1.0e-3;
    if !union_volume.is_finite() || (union_volume - source_volume).abs() > tolerance {
        return None;
    }
    let GroupCut::Cut(cut) = clipper.subtract_mesh(&union, cutter) else {
        return None;
    };
    if clipper.failure_count() != 0
        || !strict_closed_mesh(&cut)
        || crate::resource::check_current().is_err()
    {
        return None;
    }
    let cut_volume = signed_volume(&cut);
    let removed = union_volume - cut_volume;
    (cut_volume > 0.0 && removed > 0.0 && removed <= cutter_volume + tolerance).then_some(cut)
}

fn shell(host: &Mesh, indices: &[u32]) -> Mesh {
    let mut positions = Vec::new();
    let mut normals = Vec::new();
    let has_normals = host.normals.len() == host.positions.len();
    let mut remap = FxHashMap::default();
    let indices = indices
        .iter()
        .map(|&index| {
            *remap.entry(index).or_insert_with(|| {
                let compact = (positions.len() / 3) as u32;
                let start = index as usize * 3;
                positions.extend_from_slice(&host.positions[start..start + 3]);
                if has_normals {
                    normals.extend_from_slice(&host.normals[start..start + 3]);
                }
                compact
            })
        })
        .collect();
    host.rebuilt_like(positions, normals, indices)
}
