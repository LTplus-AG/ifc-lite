// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::{
    atlas_plan::AtlasSampler,
    page_raster::Raster,
    source::Source,
    transfer_budget::TransferBudget,
    transfer_math::*,
    transfer_surface::{Observation, Surface},
    transfer_target::{self, TargetTriangle},
    transfer_types::*,
    AppearanceItem,
};

pub(super) struct TransferSampler<'a> {
    pub surface: Surface,
    pub budget: TransferBudget,
    pub image: Raster<'a>,
    pub frame: &'a TransferFrame,
    pub repeat: [bool; 2],
    pub items: Vec<TransferItemCoverage>,
    targets: Vec<TargetTriangle>,
    samples: Vec<TransferCoverage>,
    current: Option<(u32, u32)>,
}
impl<'a> TransferSampler<'a> {
    pub fn new(
        surface: Surface,
        budget: TransferBudget,
        image: Raster<'a>,
        frame: &'a TransferFrame,
        repeat: [bool; 2],
    ) -> Self {
        Self {
            surface,
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
        count: bool,
    ) -> Result<(Observation, [f64; 2]), String> {
        let target = &self.targets[triangle];
        let work_before=self.budget.work;self.budget.calls[usize::from(count)]+=1;
        self.surface
            .prepare_region(target.points, &mut self.budget)?;
        let result = self.surface.observe(
            interpolate(target.points, weights),
            target.normal,
            &mut self.budget,
        );
        self.budget.sample_work[usize::from(count)]+=work_before-self.budget.work;
        let result=result.map_err(|e|format!("{e}; charges={:?}; calls={:?}; sample_work={:?}",self.budget.charges,self.budget.calls,self.budget.sample_work))?;
        if count {
            let coverage = &mut self.samples[triangle];
            coverage.samples += 1;
            match result.0 {
                Observation::Observed => coverage.observed_samples += 1,
                Observation::Distance => coverage.unknown_distance_samples += 1,
                Observation::Normal => coverage.unknown_normal_samples += 1,
                Observation::Ambiguous => coverage.unknown_ambiguous_samples += 1,
            }
        }
        Ok(result)
    }
}
impl AtlasSampler for TransferSampler<'_> {
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
        self.samples = vec![TransferCoverage::default(); triangles.len()];
        self.current = Some((product, item.geometry_item_id));
        // Even subpixel charts have one interior observation; padding never counts.
        for triangle in 0..triangles.len() {
            self.observe(triangle, [1. / 3.; 3], true)?;
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
        return Err(format!("PROBE COMPLETE; remaining={}; charges={:?}; calls={:?}; sample_work={:?}",self.budget.work,self.budget.charges,self.budget.calls,self.budget.sample_work));
        #[allow(unreachable_code)]
        self.items.push(TransferItemCoverage {
            product_id,
            geometry_item_id,
            coverage,
        });
        Ok(())
    }
    fn reserve_pixels(&mut self, pixels: usize) -> Result<(), String> {
        self.budget.category=5;
        self.budget.reserve(
            pixels
                .checked_mul(12)
                .ok_or("Transfer atlas allocation overflow")?,
        )?;
        self.budget.charge(pixels)
    }
    fn sample(
        &mut self,
        _: &AppearanceItem,
        triangle: usize,
        weights: Point,
        interior: bool,
        background: [f64; 4],
    ) -> Result<[u8; 4], String> {
        let (observation, uv) = self.observe(triangle, weights, interior)?;
        let color = if observation == Observation::Observed {
            // GLB top-down UVs become IFC bottom-up at the existing raster boundary.
            self.image.sample([uv[0], 1. - uv[1]], self.repeat)
        } else {
            background
        };
        Ok(color.map(|v| (v.clamp(0., 1.) * 255.).round() as u8))
    }
}
pub(super) fn accumulate(total: &mut TransferCoverage, item: &TransferCoverage) {
    total.samples += item.samples;
    total.observed_samples += item.observed_samples;
    total.unknown_distance_samples += item.unknown_distance_samples;
    total.unknown_normal_samples += item.unknown_normal_samples;
    total.unknown_ambiguous_samples += item.unknown_ambiguous_samples;
    total.observed_area_estimate_m2 += item.observed_area_estimate_m2;
    total.unknown_area_estimate_m2 += item.unknown_area_estimate_m2;
}
