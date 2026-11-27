// SPDX-License-Identifier: MPL-2.0
//! Preserve the original boundary of a rectangular wall item that an aligned
//! recess only touches. The intersection is decided from IFC dimensions.
use super::{world_host_bounds, CutterKind, RectParam, VoidContext};
use crate::mesh_check::EdgeLedger;
use crate::program::openings::execute::Execution;
use crate::{Mesh, Point3, Vector3};
use rustc_hash::FxHashMap;
use std::sync::Arc;

pub(crate) struct AlignedOpening {
    pub(crate) hosts: Arc<[RectParam]>,
    pub(crate) openings: std::vec::IntoIter<RectParam>,
    pub(crate) partition: bool,
}

pub(crate) struct AlignedBodies {
    pub(crate) hosts: Arc<[RectParam]>,
    affected: [bool; 2],
}

impl AlignedBodies {
    pub(crate) fn for_opening(hosts: &Arc<[RectParam]>, opening: &RectParam) -> Option<Arc<Self>> {
        let [first, second] = hosts.as_ref() else {
            return None;
        };
        let affected = [
            first.intersects_interior(opening),
            second.intersects_interior(opening),
        ];
        (affected != [true; 2]).then(|| {
            Arc::new(Self {
                hosts: Arc::clone(hosts),
                affected,
            })
        })
    }
}

impl RectParam {
    pub(crate) fn intersects_interior(&self, opening: &RectParam) -> bool {
        let rt = self.r.transpose();
        let offset = rt * (opening.center - self.center);
        let projected = (rt * opening.r).abs() * Vector3::from(opening.half);
        // Allow only the roundoff of composing the two f64 placements.
        let scale = self
            .center
            .coords
            .amax()
            .max(opening.center.coords.amax())
            .max(projected.amax())
            .max(Vector3::from(self.half).amax());
        let roundoff = 16.0 * f64::EPSILON * scale;
        // At large world coordinates the subtraction itself is uncertain.
        // Hand that case back to the normal cut.
        if !roundoff.is_finite() || roundoff > 1e-9 || !offset.iter().all(|v| v.is_finite()) {
            return true;
        }
        (0..3).all(|k| self.half[k] + projected[k] - offset[k].abs() > roundoff)
    }

    /// Recognize the eight corners of the original extrusion in an emitted
    /// closed shell. A clipped, sliced or differently framed mesh defers.
    fn matches_shell(&self, mesh: &Mesh, indices: &[u32]) -> bool {
        let mut corners = 0u8;
        let rt = self.r.transpose();
        let center = self.center - Vector3::from(mesh.origin);
        for &i in indices {
            let Some(p) = mesh.positions.get(i as usize * 3..i as usize * 3 + 3) else {
                return false;
            };
            let p = Point3::new(f64::from(p[0]), f64::from(p[1]), f64::from(p[2]));
            let local = rt * (p - center);
            let tol = (8.0 * f64::from(f32::EPSILON) * p.coords.amax().max(1.0)).min(0.0001);
            let mut corner = 0;
            for k in 0..3 {
                if !((local[k].abs() - self.half[k]).abs() <= tol && tol < self.half[k]) {
                    return false;
                }
                corner |= usize::from(local[k] > 0.0) << k;
            }
            corners |= 1 << corner;
        }
        corners == u8::MAX
    }
}

impl Execution {
    pub(super) fn cut_intersected_bodies(
        &self,
        mesh: &Mesh,
        ctx: &VoidContext,
        id: u32,
    ) -> Option<Mesh> {
        let [CutterKind::DiagonalRectangular(_, frame)] = ctx.openings.as_slice() else {
            return None;
        };
        let bodies = frame.aligned_bodies.as_ref()?;
        // An unsubdivided cuboid has twelve triangles. Only the original
        // one-item or two-item stream can qualify for this partition.
        if !matches!(mesh.indices.len(), 36 | 72) {
            return None;
        }
        let ranges = EdgeLedger::closed_shell_ranges(mesh)?;
        if ranges.len() == 1 && bodies.affected == [false; 2] {
            // A single styled item with no sibling being cut already uses its
            // ordinary solitary-body path. There is no assembly to partition.
            return None;
        }
        let mut seen = [false; 2];
        let mut selected = Vec::with_capacity(ranges.len());
        for range in &ranges {
            let matches =
                [0, 1].map(|i| bodies.hosts[i].matches_shell(mesh, &mesh.indices[range.clone()]));
            let owner = match matches {
                [true, false] => 0,
                [false, true] => 1,
                _ => return None,
            };
            if std::mem::replace(&mut seen[owner], true) {
                return None;
            }
            selected.push(bodies.affected[owner]);
        }
        let before = mesh.triangle_count();
        let result = if !selected.iter().any(|&hit| hit) {
            mesh.clone()
        } else {
            // A manifold-gated cut can unite touching solids and remove both
            // contact faces. A positive intersection must go through that gate.
            if cfg!(feature = "csg_manifold_gate") || selected.iter().all(|&hit| hit) {
                return None;
            }
            let mut result = Mesh::new();
            for (range, hit) in ranges.into_iter().zip(selected) {
                let source = shell(mesh, &mesh.indices[range]);
                let part = if hit {
                    self.cut_whole_mesh(source, ctx, id)
                } else {
                    source
                };
                result.merge(&part);
            }
            result
        };
        self.record_host_cut_effect(
            id,
            before,
            result.triangle_count(),
            ctx.rect_opening_count(),
            world_host_bounds(mesh),
        );
        Some(result)
    }
}

pub(crate) fn shell(host: &Mesh, indices: &[u32]) -> Mesh {
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
