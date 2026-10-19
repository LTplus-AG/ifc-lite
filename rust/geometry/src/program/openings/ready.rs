// SPDX-License-Identifier: MPL-2.0
//! Exact geometry-only opening decisions and frame/capture arithmetic.
use super::requests::{OpeningReady, OpeningReply};
use crate::router::voids::{
    geom::{
        extract_rotation_columns, mesh_signed_volume, rotate_and_normalize, signed_permutation_map,
    },
    OpeningType,
};
impl OpeningReady {
    pub(crate) fn execute(self) -> OpeningReply {
        let tag = self.tag();
        let (reply, reports) = crate::processors::diagnostic_capture::capture(|| {
            if let Err(stop) = crate::resource::check_current() {
                return OpeningReply::Error(stop.into());
            }
            self.evaluate()
        });
        OpeningReply::Numerical(
            tag,
            Box::new(OpeningReply::Captured(Box::new(reply), reports)),
        )
    }
    fn evaluate(self) -> OpeningReply {
        match self {
            Self::Metrics(parts) => {
                let parts: std::collections::VecDeque<_> =
                    parts.into_iter().filter(|mesh| !mesh.is_empty()).collect();
                let triangles = parts.iter().map(crate::Mesh::triangle_count).sum();
                let vertices = parts.iter().map(crate::Mesh::vertex_count).sum();
                OpeningReply::Metrics(parts, triangles, vertices)
            }
            Self::BoundsDecision(bounds) => {
                let separable = bounds.len() > 1
                    && crate::router::voids::geom::spatial_cluster_count(&bounds) > 1;
                OpeningReply::BoundsDecision(bounds, separable)
            }
            Self::Decision(mut decisions) => {
                let opening = decisions.next();
                OpeningReply::Decision(decisions, opening)
            }
            Self::Fallback { mesh, bounds } => {
                let direction = bounds.into_iter().find_map(|(_, _, direction)| direction);
                let (min, max) = super::decision::world_bounds(&mesh);
                OpeningReply::Fallback(OpeningType::NonRectangular(mesh, min, max, direction))
            }
            Self::Merge(openings) => {
                let merged = crate::GeometryRouter::merge_rectangular_openings(&openings);
                OpeningReply::Merged(openings, merged)
            }
            Self::ProbePlacement {
                mut placement,
                scale,
                frame,
            } => {
                if scale != 1.0 {
                    placement[(0, 3)] *= scale;
                    placement[(1, 3)] *= scale;
                    placement[(2, 3)] *= scale;
                }
                OpeningReply::ProbePlacement(placement, frame)
            }
            Self::ProbeDirection { value, placement } => {
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
            Self::ProbeParts {
                parts,
                placement,
                frame,
                meshes,
                direction,
            } => place_probe_parts(parts, placement, frame, meshes, direction),
            Self::RectOrientation { host, boxes } => {
                let rotation = host.transpose();
                let mut eligible = true;
                for opening in &boxes {
                    if let Err(stop) = crate::resource::check_current() {
                        return OpeningReply::Error(stop.into());
                    }
                    if signed_permutation_map(&(rotation * opening.r), 1.0e-3).is_none() {
                        eligible = false;
                        break;
                    }
                }
                OpeningReply::RectOrientation(eligible.then_some(boxes))
            }
            Self::RectReconcile { boxes, meshes } => {
                let volume: f64 = meshes
                    .iter()
                    .map(|mesh| mesh_signed_volume(mesh).abs())
                    .sum();
                if volume < 1.0e-9 {
                    return OpeningReply::RectReconciled(None);
                }
                let box_volume: f64 = boxes
                    .iter()
                    .map(|rect| 8.0 * rect.half[0] * rect.half[1] * rect.half[2])
                    .sum();
                OpeningReply::RectReconciled(
                    (0.97..1.03)
                        .contains(&(box_volume / volume))
                        .then_some(boxes),
                )
            }
            Self::PlanarHost(host) => OpeningReply::PlanarHost(
                super::planar::PlanarHost::prepare(host).map(std::sync::Arc::new),
            ),
            Self::Footprint { host, solid } => {
                let footprint =
                    crate::router::voids::bool2d_path::footprint::opening_solid_footprint(
                        &solid,
                        &host.hm_inv,
                        &host.axis,
                        host.z_min,
                        host.z_max,
                        host.z_tol,
                    )
                    .filter(|footprint| {
                        crate::router::voids::bool2d_path::footprint::footprint_interior(
                            footprint,
                            &host.solid.profile,
                        )
                    });
                OpeningReply::Footprint(footprint)
            }
            Self::PlanarTransform { host, scale, rtc } => {
                let mut transform = host.solid.m;
                for i in 0..3 {
                    for j in 0..4 {
                        transform[(i, j)] *= scale;
                    }
                }
                transform[(0, 3)] -= rtc.0;
                transform[(1, 3)] -= rtc.1;
                transform[(2, 3)] -= rtc.2;
                OpeningReply::PlanarTransform(transform)
            }
            Self::FinishClassifier { output, diagnostic } => {
                OpeningReply::ClassifierFinished(output, diagnostic)
            }
            Self::Finish(output) => OpeningReply::Finished(output),
        }
    }
}

fn place_probe_parts(
    parts: Vec<crate::Mesh>,
    placement: nalgebra::Matrix4<f64>,
    frame: crate::router::transforms::WorldFrame,
    meshes: bool,
    direction: Option<crate::Vector3<f64>>,
) -> OpeningReply {
    let mut placed = Vec::new();
    let mut bounds = Vec::new();
    for mut mesh in parts.into_iter().filter(|mesh| !mesh.is_empty()) {
        if let Err(stop) = crate::resource::check_current() {
            return OpeningReply::Error(stop.into());
        }
        if meshes {
            let framed = frame.needs_local_frame(&mesh, &placement);
            frame.transform_mesh_world_framed(&mut mesh, &placement, framed);
            placed.push(mesh);
        } else {
            let (min, max) =
                crate::program::opening_bounds::evaluate(&mesh, &placement, frame.rtc_offset);
            bounds.push((min, max, direction));
        }
        if let Err(stop) = crate::resource::check_current() {
            return OpeningReply::Error(stop.into());
        }
    }
    OpeningReply::ProbeParts(placed, bounds)
}
