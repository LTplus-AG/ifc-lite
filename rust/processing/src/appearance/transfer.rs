// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Bounded registered scan observations (textured mesh or RGB point cloud)
//! composed over canonical IFC appearance.
use super::{
    page_raster::Raster,
    transfer_budget::{self, TransferBudget},
    transfer_math::validate_frame,
    transfer_sampler::{accumulate, TransferSampler},
    transfer_source::ScanSource,
    transfer_types::*,
    *,
};
use sha2::{Digest, Sha256};

/// Textured mesh source. `rgba` carries the source image and the target's
/// existing rasters; a point source is refused here.
pub fn plan_mesh_transfer(
    bytes: &[u8],
    request: &MeshTransferRequest,
    rgba: &[u8],
) -> Result<MeshTransferPlan, String> {
    plan_transfer(bytes, request, rgba, None)
}
/// RGB point-cloud source (#4381). `rgba` carries only the target's existing
/// rasters; positions, colours and optional normals/stations arrive in `points`.
pub fn plan_point_transfer(
    bytes: &[u8],
    request: &MeshTransferRequest,
    rgba: &[u8],
    points: &TransferPointPayload<'_>,
) -> Result<MeshTransferPlan, String> {
    plan_transfer(bytes, request, rgba, Some(points))
}
fn plan_transfer(
    bytes: &[u8],
    request: &MeshTransferRequest,
    rgba: &[u8],
    points: Option<&TransferPointPayload<'_>>,
) -> Result<MeshTransferPlan, String> {
    if points.is_some_and(|p| p.positions.len() > 6 * 2_000_000) {
        return Err("Transfer point payload exceeds its budget".into());
    }
    if request.product_ids.is_empty()
        || request.product_ids.len() > 10_000
        || bytes.len() > 128 * 1024 * 1024
        || rgba.len() > 128 * 1024 * 1024
    {
        return Err("Transfer input or product scope exceeds its budget".into());
    }
    if !request.max_distance_metres.is_finite()
        || request.max_distance_metres <= 0.
        || request.max_distance_metres > 10.
        || !request.min_normal_dot.is_finite()
        || request.min_normal_dot <= 0.
        || request.min_normal_dot > 1.
        || !request.ambiguity_distance_metres.is_finite()
        || request.ambiguity_distance_metres < 0.
        || request.ambiguity_distance_metres > request.max_distance_metres
        || !request.max_behind_metres.is_finite()
        || request.max_behind_metres < 0.
        || request.max_behind_metres > request.max_distance_metres
    {
        return Err("Transfer requires bounded positive distance, oriented normal threshold, and nonnegative ambiguity and behind-surface distances within it".into());
    }
    if !matches!(request.schema.as_str(), "IFC4" | "IFC4X3")
        || request.source_revision.len() > 256
        || request.source_images.len() > 10_000
        || request
            .source_images
            .iter()
            .any(|image| image.image_uri.is_empty() || image.image_uri.len() > 4096)
    {
        return Err(
            "Transfer schema, revision or target raster identities exceed their bounds".into(),
        );
    }
    validate_frame(&request.target_from_ifc_world)?;
    let registration = register_scan_correspondences(&request.registration)?;
    if registration.request_sha256 != request.registration_sha256 {
        return Err(
            "Transfer registration digest does not match its frozen correspondence request".into(),
        );
    }
    if format!("{:x}", Sha256::digest(bytes)) != registration.target_frame.asset_sha256 {
        return Err("Transfer target snapshot does not match the frozen registration frame".into());
    }
    let source_frame = TransferFrame {
        rotation: registration.rotation,
        source_anchor: registration.source_anchor,
        target_anchor: registration.target_anchor,
    };
    let mut budget = TransferBudget::new();
    budget.reserve(rgba.len())?;
    let (image, repeat) = match (&request.source, &request.source_image) {
        (TransferSource::Mesh(mesh), Some(spec)) => {
            let image = Raster::supplied(spec, rgba)?;
            budget.charge(image.rgba.len() / 4)?;
            if image.rgba.chunks_exact(4).any(|p| p[3] != 255) {
                return Err("Transfer source image must be opaque; alpha appearance is unsupported".into());
            }
            (Some(image), [mesh.repeat_s, mesh.repeat_t])
        }
        (TransferSource::Points(_), None) => (None, [false; 2]),
        (TransferSource::Mesh(_), None) => return Err("Transfer mesh source needs its source image".into()),
        (TransferSource::Points(_), Some(_)) => return Err("Transfer point source carries colours per point, not a source image".into()),
    };
    let source = ScanSource::new(request, points, &source_frame, &mut budget)?;
    let prepared_sha256 = digest(bytes, request, rgba, points)?;
    let mut sampler = TransferSampler::new(
        source,
        budget,
        image,
        &request.target_from_ifc_world,
        repeat,
    );
    // Mapping is only canonical initial UV scaffolding; the sampler supplies all
    // final charts, using the same planner/material preservation as page overlays.
    let spec = AppearanceRequest {
        representation_policy: RepresentationPolicy::Preserve,
        schema: request.schema.clone(),
        source_revision: request.source_revision.clone(),
        next_express_id: request.next_express_id,
        product_ids: request.product_ids.clone(),
        image_uri: "textures/prepared-transfer.png".into(),
        repeat_s: false,
        repeat_t: false,
        mapping: Mapping::Box {
            frame: MappingFrame::Item,
            origin: [0.; 3],
            metres_per_tile: [1.; 3],
        },
        face_masks: Vec::new(),
    };
    let output = atlas_plan::plan_sampled_appearance(
        bytes,
        &spec,
        &request.source_images,
        rgba,
        request.texels_per_metre,
        &mut sampler,
    )?;
    let mut coverage = TransferCoverage::default();
    for item in &sampler.items {
        accumulate(&mut coverage, &item.coverage);
    }
    let sufficient_counts =
        request.registration.fit.len() >= 4 && request.registration.held_out.len() >= 4;
    let applicable = coverage.observed_raster_interior_texels > 0 && sufficient_counts;
    let mut diagnostics=vec!["Coverage is a triangle-area-weighted centroid/interior-texel estimate, not a registration accuracy approval".into(),
        "Unknown samples preserve the existing target albedo through the shared atlas; source GLB byte-to-decoded-mesh/image identity is verified by the host".into()];
    diagnostics.extend(registration.diagnostics.clone());
    if !sufficient_counts {
        diagnostics.push("Insufficient operational registration evidence: application acceptance requires at least 4 fit and 4 spatially distributed held-out observations; this is a calculation-only plan".into());
    }
    if coverage.observed_samples == 0 {
        diagnostics
            .push("No observed target samples; no applicable mutation plan was produced".into());
    }
    if coverage.observed_samples > 0 && coverage.observed_raster_interior_texels == 0 {
        diagnostics.push("No observed interior raster texels; centroid observations alone do not establish emitted scan appearance, so no applicable mutation plan was produced".into());
    }
    let exclusions = output.plan.exclusions.clone();
    Ok(MeshTransferPlan {
        output: applicable.then_some(output),
        texels_per_metre: request.texels_per_metre,
        transfer: MeshTransferSummary {
            prepared_sha256,
            source: ScanSource::summary(request),
            budget: TransferBudgetReport {
                work_used: (transfer_budget::WORK_LIMIT - sampler.budget.work) as u64,
                work_limit: transfer_budget::WORK_LIMIT as u64,
            },
            registration_sha256: registration.request_sha256.clone(),
            registration,
            applicable,
            coverage,
            items: sampler.items,
            exclusions,
            diagnostics,
        },
    })
}
fn digest(
    bytes: &[u8],
    request: &MeshTransferRequest,
    rgba: &[u8],
    points: Option<&TransferPointPayload<'_>>,
) -> Result<String, String> {
    struct Writer(Sha256);
    impl std::io::Write for Writer {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut hash = Writer(Sha256::new());
    hash.0.update(b"ifclite-scan-transfer-v4-source-kind\0");
    // Length-prefix binary portions; JSON is last and streamed without a duplicate allocation.
    hash.0.update((bytes.len() as u64).to_le_bytes());
    hash.0.update(bytes);
    hash.0.update((rgba.len() as u64).to_le_bytes());
    hash.0.update(rgba);
    if let Some(points) = points {
        for (label, length) in [("positions", points.positions.len()), ("colors", points.colors.len()), ("normals", points.normals.len()), ("stations", points.stations.len())] {
            hash.0.update(label.as_bytes());
            hash.0.update((length as u64).to_le_bytes());
        }
        for v in points.positions {
            hash.0.update(v.to_le_bytes());
        }
        hash.0.update(points.colors);
        for v in points.normals {
            hash.0.update(v.to_le_bytes());
        }
        for v in points.stations {
            hash.0.update(v.to_le_bytes());
        }
    }
    serde_json::to_writer(&mut hash, request).map_err(|e| e.to_string())?;
    Ok(format!("{:x}", hash.0.finalize()))
}
#[cfg(test)]
#[path = "transfer_tests.rs"]
pub(super) mod tests;
#[cfg(test)]
#[path = "transfer_acceptance_tests.rs"]
pub(super) mod acceptance_tests;
