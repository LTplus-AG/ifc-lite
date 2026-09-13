// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::{
    atlas_plan::AtlasSampler,
    page_raster::Raster,
    source::Source,
    transfer_budget::TransferBudget,
    transfer_math::*,
    transfer_source::{Sample, ScanSource},
    transfer_surface::Observation,
    transfer_target::{self, TargetTriangle},
    transfer_types::*,
    AppearanceItem,
};

pub(super) struct TransferSampler<'a> {
    pub source: ScanSource,
    pub budget: TransferBudget,
    /// The mesh source's texture; a point source carries its colours per point.
    pub image: Option<Raster<'a>>,
    pub frame: &'a TransferFrame,
    pub repeat: [bool; 2],
    pub items: Vec<TransferItemCoverage>,
    targets: Vec<TargetTriangle>,
    samples: Vec<TransferCoverage>,
    current: Option<(u32, u32)>,
}
#[derive(Clone, Copy)]
enum SampleKind {
    Centroid,
    Interior,
    Guard,
}
impl<'a> TransferSampler<'a> {
    pub fn new(
        source: ScanSource,
        budget: TransferBudget,
        image: Option<Raster<'a>>,
        frame: &'a TransferFrame,
        repeat: [bool; 2],
    ) -> Self {
        Self {
            source,
            budget,
            image,
            frame,
            repeat,
            items: Vec::new(),
            targets: Vec::new(),
            samples: Vec::new(),
            current: None,
        }
    }
    fn observe(
        &mut self,
        triangle: usize,
        weights: Point,
        kind: SampleKind,
    ) -> Result<(Observation, Sample), String> {
        let target = &self.targets[triangle];
        let result = self.source.observe(
            interpolate(target.points, weights),
            target.normal,
            &mut self.budget,
        )?;
        if !matches!(kind, SampleKind::Guard) {
            let coverage = &mut self.samples[triangle];
            let observed = result.0 == Observation::Observed;
            match kind {
                SampleKind::Centroid => {
                    coverage.centroid_samples += 1;
                    coverage.observed_centroid_samples += u64::from(observed);
                }
                SampleKind::Interior => {
                    coverage.raster_interior_texels += 1;
                    coverage.observed_raster_interior_texels += u64::from(observed);
                }
                SampleKind::Guard => unreachable!(),
            }
            coverage.samples += 1;
            match result.0 {
                Observation::Observed => coverage.observed_samples += 1,
                Observation::Distance => coverage.unknown_distance_samples += 1,
                Observation::Normal => coverage.unknown_normal_samples += 1,
                Observation::Ambiguous => coverage.unknown_ambiguous_samples += 1,
                Observation::Behind => coverage.unknown_behind_samples += 1,
                Observation::Sparse => coverage.unknown_sparse_samples += 1,
            }
        }
        Ok(result)
    }
}
impl AtlasSampler for TransferSampler<'_> {
    fn raster_guards(&self) -> bool { true }
    fn begin_item(
        &mut self,
        source: &mut Source<'_>,
        product: u32,
        item: &AppearanceItem,
        points: &[Point],
        triangles: &[[u32; 3]],
        mesh: &crate::types::mesh::MeshData,
    ) -> Result<(), String> {
        self.budget
            .reserve(triangles.len() * 256 + points.len() * 24)?;
        self.budget.charge(triangles.len() * 8 + points.len())?;
        self.targets =
            transfer_target::prepare(source, product, points, triangles, mesh, self.frame)?;
        self.source.begin_item(&self.targets, &mut self.budget)?;
        self.samples = vec![TransferCoverage::default(); triangles.len()];
        self.current = Some((product, item.geometry_item_id));
        // Even subpixel charts have one centroid observation; padding never counts.
        for triangle in 0..triangles.len() {
            self.observe(triangle, [1. / 3.; 3], SampleKind::Centroid)?;
        }
        Ok(())
    }
    fn end_item(&mut self) -> Result<(), String> {
        let mut coverage = TransferCoverage::default();
        for (samples, target) in self.samples.iter_mut().zip(&self.targets) {
            let fraction = samples.observed_samples as f64 / samples.samples as f64;
            samples.observed_area_estimate_m2 = target.area * fraction;
            samples.unknown_area_estimate_m2 = target.area * (1. - fraction);
            accumulate(&mut coverage, samples);
        }
        let (product_id, geometry_item_id) = self
            .current
            .take()
            .ok_or("Missing transfer coverage item")?;
        self.items.push(TransferItemCoverage {
            product_id,
            geometry_item_id,
            coverage,
        });
        Ok(())
    }
    fn reserve_pixels(&mut self, pixels: usize) -> Result<(), String> {
        self.budget.reserve(
            pixels
                .checked_mul(17)
                .ok_or("Transfer atlas allocation overflow")?,
        )?;
        // Each bounded pixel visit is one unit, as in the existing atlas: paint,
        // seed classification, then one four-neighbor propagation visit.
        self.budget.charge(pixels.checked_mul(3).ok_or("Transfer guard work overflow")?)
    }
    fn sample(
        &mut self,
        _: &AppearanceItem,
        triangle: usize,
        weights: Point,
        interior: bool,
        background: [f64; 4],
    ) -> Result<[u8; 4], String> {
        let (observation, sample) = self.observe(
            triangle,
            weights,
            if interior {
                SampleKind::Interior
            } else {
                SampleKind::Guard
            },
        )?;
        let color = match (observation, sample) {
            // GLB top-down UVs become IFC bottom-up at the existing raster boundary.
            (Observation::Observed, Sample::Uv(uv)) => self
                .image
                .ok_or("Transfer mesh observation without its source image")?
                .sample([uv[0], 1. - uv[1]], self.repeat),
            (Observation::Observed, Sample::Rgba(rgba)) => rgba,
            _ => background,
        };
        Ok(color.map(|v| (v.clamp(0., 1.) * 255.).round() as u8))
    }
}
pub(super) fn accumulate(total: &mut TransferCoverage, item: &TransferCoverage) {
    total.samples += item.samples;
    total.observed_samples += item.observed_samples;
    total.centroid_samples += item.centroid_samples;
    total.observed_centroid_samples += item.observed_centroid_samples;
    total.raster_interior_texels += item.raster_interior_texels;
    total.observed_raster_interior_texels += item.observed_raster_interior_texels;
    total.unknown_distance_samples += item.unknown_distance_samples;
    total.unknown_normal_samples += item.unknown_normal_samples;
    total.unknown_ambiguous_samples += item.unknown_ambiguous_samples;
    total.unknown_behind_samples += item.unknown_behind_samples;
    total.unknown_sparse_samples += item.unknown_sparse_samples;
    total.observed_area_estimate_m2 += item.observed_area_estimate_m2;
    total.unknown_area_estimate_m2 += item.unknown_area_estimate_m2;
}
