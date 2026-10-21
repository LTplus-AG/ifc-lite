// SPDX-License-Identifier: MPL-2.0
//! Exact geometry-only opening decisions and cutter placement arithmetic.
use super::planar::PlanarHost;
use super::requests::{OpeningReady, OpeningReply};
use crate::program::opening::OpeningBounds;
use crate::router::processing::SourceHygiene;
use crate::router::transforms::WorldFrame;
use crate::router::voids::geom::{extract_rotation_columns, rotate_and_normalize, spatial_cluster_count};
use crate::router::voids::OpeningType;
use crate::{Mesh, Vector3};
use nalgebra::Matrix4;

/// A probe's captured numerical placement policy and its output so far. The
/// output moves through each packet, so placement allocates no per-item buffer.
pub(crate) struct ProbePlacement {
    pub(crate) hygiene: SourceHygiene,
    pub(crate) placement: Matrix4<f64>,
    pub(crate) frame: WorldFrame,
    pub(crate) meshes: bool,
    pub(crate) direction: Option<Vector3<f64>>,
    pub(crate) placed: Vec<Mesh>,
    pub(crate) bounds: OpeningBounds,
}

impl OpeningReady {
    pub(crate) fn execute(self) -> OpeningReply {
        match self {
            Self::Metrics(mut parts) => {
                // In place, and the deque takes the same buffer: no new allocation.
                parts.retain(|mesh| !mesh.is_empty());
                let parts = std::collections::VecDeque::from(parts);
                // Triangle count, not raw position-buffer length: welding (#4103)
                // merges duplicate vertex slots without touching `indices`, so
                // byte-identical cutters must not straddle the gate (#4119).
                let triangles = parts.iter().map(Mesh::triangle_count).sum();
                let vertices = parts.iter().map(Mesh::vertex_count).sum();
                OpeningReply::Metrics(parts, triangles, vertices)
            }
            Self::BoundsDecision(bounds) => {
                // Several SPATIALLY SEPARATE void solids under one opening (a
                // row of windows, #1367) are classified per item; touching parts
                // of one logical void stay merged.
                let separable = bounds.len() > 1 && spatial_cluster_count(&bounds) > 1;
                OpeningReply::BoundsDecision(bounds, separable)
            }
            Self::Decision(mut decisions) => {
                let opening = decisions.next();
                OpeningReply::Decision(decisions, opening)
            }
            Self::Fallback { mesh, bounds } => {
                // The full mesh AABB is the only safe over-approximation of a
                // high-triangle opening (#635); the direction is best-effort
                // from the first item that has one.
                let direction = bounds.into_iter().find_map(|(_, _, direction)| direction);
                let (min, max) = super::decision::world_bounds(&mesh);
                OpeningReply::Fallback(OpeningType::NonRectangular(mesh, min, max, direction))
            }
            Self::ProbeDirection { value, placement } => {
                // A zero-length IFCDIRECTION drops only THIS item's direction
                // (coarser bounds), never every sibling item's bounds.
                let direction = value.and_then(|(local, position)| {
                    let rotation = extract_rotation_columns(&placement);
                    if let Some(position) = position {
                        let position = extract_rotation_columns(&position);
                        rotate_and_normalize(&position, &local)
                            .ok()
                            .and_then(|world| rotate_and_normalize(&rotation, &world).ok())
                    } else {
                        rotate_and_normalize(&rotation, &local).ok()
                    }
                });
                OpeningReply::ProbeDirection(direction)
            }
            Self::ProbeParts { parts, placement } => place_probe_parts(parts, placement),
            Self::FinishClassifier { output, diagnostic } => {
                OpeningReply::ClassifierFinished(output, diagnostic)
            }
            Self::Merge(openings) => {
                let merged = crate::GeometryRouter::merge_rectangular_openings(&openings);
                OpeningReply::Merged(openings, merged)
            }
            Self::RectOrientation { host, boxes } => {
                OpeningReply::RectOrientation(super::rectangular::share_frame(&host, boxes))
            }
            Self::RectReconcile { boxes, meshes } => {
                OpeningReply::RectReconciled(super::rectangular::reconcile(boxes, &meshes))
            }
            Self::PlanarHost(solid) => OpeningReply::PlanarHost(PlanarHost::prepare(solid)),
            Self::Footprint { host, solid } => {
                let footprint = host.footprint(&solid);
                OpeningReply::Footprint(host, footprint)
            }
            Self::PlanarTransform { placement, scale, rtc } => {
                OpeningReply::PlanarTransform(super::planar::world_transform(placement, scale, rtc))
            }
        }
    }
}

/// Mesh and bounds probes retain exactly the same cleaned item parts, one
/// entry per frame part in emission order (#6446).
fn place_probe_parts(parts: Vec<Mesh>, mut probe: ProbePlacement) -> OpeningReply {
    for mesh in parts {
        let Some(mut mesh) = crate::router::voids::hygiene::clean_opening_item(mesh, probe.hygiene)
        else {
            continue;
        };
        if probe.meshes {
            // Keep ordinary opening cutters in the world/RTC frame. A large
            // mapped origin, or a cutter far from the RTC origin (#6478), would
            // lose its fractional translation when the world point is cast to
            // f32; the void context folds each cutter's origin into the host
            // frame before cutting.
            let framed = probe.frame.needs_local_frame(&mesh, &probe.placement);
            probe.frame.transform_mesh_world_framed(&mut mesh, &probe.placement, framed);
            probe.placed.push(mesh);
        } else {
            let (min, max) = crate::program::opening_bounds::evaluate(
                &mesh,
                &probe.placement,
                probe.frame.rtc_offset,
            );
            probe.bounds.push((min, max, probe.direction));
        }
    }
    OpeningReply::ProbeParts(probe)
}
