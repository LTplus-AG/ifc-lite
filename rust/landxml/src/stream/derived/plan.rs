/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! One-at-a-time plan adapter derivation held behind stream credit.

use super::super::{event, LandXmlMetadataRecord};
use crate::{
    LandXmlError, LandXmlPlanDocument, LandXmlPlanGeometry, LandXmlPlanPointLocation,
    LandXmlPlanResolver, LandXmlSourceId,
};

const SOURCE_BATCH_SIZE: usize = 128;

#[derive(Clone, Copy)]
enum Phase {
    SourceBatches,
    ParcelProbes,
    Monuments,
    Geometry,
    Complete,
}

/// Owns the parsed plan until its derived records have each received credit.
/// Authored records are moved to `PlanStreamParts` only after this cursor has
/// completed, so no End payload or second plan document is needed.
pub(crate) struct PlanDerivedCursor {
    plan: Option<LandXmlPlanDocument>,
    phase: Phase,
    cogo_index: usize,
    monument_source_index: usize,
    feature_source_index: usize,
    feature_geometry_source_index: usize,
    parcel_source_index: usize,
    parcel_loop_source_index: usize,
    parcel_geometry_source_index: usize,
    parcel_probe_index: usize,
    monument_index: usize,
    feature_geometry_index: usize,
    parcel_geometry_index: usize,
    parcel_geometry_loop_index: usize,
}

impl PlanDerivedCursor {
    pub(crate) fn new(plan: LandXmlPlanDocument) -> Self {
        Self {
            plan: Some(plan),
            phase: Phase::SourceBatches,
            cogo_index: 0,
            monument_source_index: 0,
            feature_source_index: 0,
            feature_geometry_source_index: 0,
            parcel_source_index: 0,
            parcel_loop_source_index: 0,
            parcel_geometry_source_index: 0,
            parcel_probe_index: 0,
            monument_index: 0,
            feature_geometry_index: 0,
            parcel_geometry_index: 0,
            parcel_geometry_loop_index: 0,
        }
    }

    pub(crate) fn take_plan(&mut self) -> Option<LandXmlPlanDocument> {
        matches!(self.phase, Phase::Complete)
            .then(|| self.plan.take())
            .flatten()
    }

    pub(crate) fn next_record(&mut self) -> Result<Option<LandXmlMetadataRecord>, LandXmlError> {
        let Some(plan) = self.plan.take() else {
            return Ok(None);
        };
        let result = self.next_record_with(&plan);
        self.plan = Some(plan);
        result
    }

    fn next_record_with(
        &mut self,
        plan: &LandXmlPlanDocument,
    ) -> Result<Option<LandXmlMetadataRecord>, LandXmlError> {
        loop {
            match self.phase {
                Phase::SourceBatches => {
                    let mut source_ids = Vec::with_capacity(SOURCE_BATCH_SIZE);
                    while source_ids.len() < SOURCE_BATCH_SIZE {
                        let Some(source_id) = self.next_source_id(plan) else {
                            break;
                        };
                        source_ids.push(source_id);
                    }
                    if !source_ids.is_empty() {
                        return Ok(Some(LandXmlMetadataRecord::PlanSourceBatch(
                            crate::LandXmlPlanSourceBatch { source_ids },
                        )));
                    }
                    self.phase = Phase::ParcelProbes;
                }
                Phase::ParcelProbes => {
                    let Some(parcel) = plan.parcels.get(self.parcel_probe_index) else {
                        self.phase = Phase::Monuments;
                        continue;
                    };
                    self.parcel_probe_index += 1;
                    let max_work = plan_resolution_work_limit(plan);
                    let mut resolver = LandXmlPlanResolver::new(plan, max_work);
                    let probe = plan
                        .probe_parcels_with_resolver(std::slice::from_ref(parcel), &mut resolver)?
                        .into_iter()
                        .next()
                        .expect("one parcel produces one probe");
                    return Ok(Some(LandXmlMetadataRecord::PlanParcelProbe(
                        event::LandXmlPlanParcelProbe {
                            source_id: parcel.source_id.clone(),
                            probe,
                        },
                    )));
                }
                Phase::Monuments => {
                    let Some(monument) = plan.monuments.get(self.monument_index) else {
                        self.phase = Phase::Geometry;
                        continue;
                    };
                    self.monument_index += 1;
                    let point = match (&monument.point, &monument.pnt_ref) {
                        (Some(point), _) => Some(*point),
                        (None, Some(reference)) => {
                            LandXmlPlanResolver::new(plan, plan_resolution_work_limit(plan))
                                .resolve(
                                    monument.point_scope_id.as_ref(),
                                    &LandXmlPlanPointLocation::PointReference {
                                        pnt_ref: reference.clone(),
                                    },
                                )?
                        }
                        (None, None) => None,
                    };
                    return Ok(Some(LandXmlMetadataRecord::PlanResolvedMonument(
                        event::LandXmlPlanResolvedMonument {
                            source_id: monument.source_id.clone(),
                            point,
                        },
                    )));
                }
                Phase::Geometry => {
                    let Some(geometry) = self.next_geometry(plan) else {
                        self.phase = Phase::Complete;
                        continue;
                    };
                    return Ok(Some(LandXmlMetadataRecord::PlanResolvedGeometry(
                        resolve_geometry(plan, geometry)?,
                    )));
                }
                Phase::Complete => return Ok(None),
            }
        }
    }

    fn next_source_id(&mut self, plan: &LandXmlPlanDocument) -> Option<LandXmlSourceId> {
        if let Some(point) = plan.cogo_points().get(self.cogo_index) {
            self.cogo_index += 1;
            return Some(point.source_id.clone());
        }
        if let Some(monument) = plan.monuments.get(self.monument_source_index) {
            self.monument_source_index += 1;
            return Some(monument.source_id.clone());
        }
        while let Some(feature) = plan.plan_features.get(self.feature_source_index) {
            if self.feature_geometry_source_index == 0 {
                self.feature_geometry_source_index = 1;
                return Some(feature.source_id.clone());
            }
            let geometry_index = self.feature_geometry_source_index - 1;
            if let Some(geometry) = feature.geometry.get(geometry_index) {
                self.feature_geometry_source_index += 1;
                return Some(geometry.source_id.clone());
            }
            self.feature_source_index += 1;
            self.feature_geometry_source_index = 0;
        }
        while let Some(parcel) = plan.parcels.get(self.parcel_source_index) {
            if self.parcel_loop_source_index == 0 {
                self.parcel_loop_source_index = 1;
                return Some(parcel.source_id.clone());
            }
            let loop_index = self.parcel_loop_source_index - 1;
            let Some(loop_geometry) = parcel.loops.get(loop_index) else {
                self.parcel_source_index += 1;
                self.parcel_loop_source_index = 0;
                self.parcel_geometry_source_index = 0;
                continue;
            };
            if let Some(geometry) = loop_geometry.get(self.parcel_geometry_source_index) {
                self.parcel_geometry_source_index += 1;
                return Some(geometry.source_id.clone());
            }
            self.parcel_loop_source_index += 1;
            self.parcel_geometry_source_index = 0;
        }
        None
    }

    fn next_geometry<'a>(
        &mut self,
        plan: &'a LandXmlPlanDocument,
    ) -> Option<&'a LandXmlPlanGeometry> {
        while let Some(feature) = plan.plan_features.get(self.feature_geometry_index) {
            if let Some(geometry) = feature.geometry.get(self.parcel_geometry_index) {
                self.parcel_geometry_index += 1;
                return Some(geometry);
            }
            self.feature_geometry_index += 1;
            self.parcel_geometry_index = 0;
        }
        while let Some(parcel) = plan.parcels.get(self.parcel_geometry_index) {
            if let Some(loop_geometry) = parcel.loops.get(self.parcel_geometry_loop_index) {
                if let Some(geometry) = loop_geometry.get(self.feature_geometry_index) {
                    self.feature_geometry_index += 1;
                    return Some(geometry);
                }
                self.parcel_geometry_loop_index += 1;
                self.feature_geometry_index = 0;
                continue;
            }
            self.parcel_geometry_index += 1;
            self.parcel_geometry_loop_index = 0;
            self.feature_geometry_index = 0;
        }
        None
    }
}

fn plan_resolution_work_limit(plan: &LandXmlPlanDocument) -> usize {
    let requests = plan
        .monuments
        .len()
        .saturating_add(
            plan.plan_features
                .iter()
                .map(|feature| feature.geometry.len().saturating_mul(4))
                .sum::<usize>(),
        )
        .saturating_add(
            plan.parcels
                .iter()
                .map(|parcel| {
                    parcel
                        .loops
                        .iter()
                        .map(|loop_geometry| loop_geometry.len().saturating_mul(4))
                        .sum::<usize>()
                })
                .sum::<usize>(),
        );
    plan.cogo_points()
        .len()
        .saturating_mul(8)
        .saturating_add(requests.saturating_mul(8))
        .saturating_add(1_000)
}

fn resolve_geometry(
    plan: &LandXmlPlanDocument,
    geometry: &LandXmlPlanGeometry,
) -> Result<event::LandXmlPlanResolvedGeometry, LandXmlError> {
    let mut resolver = LandXmlPlanResolver::new(plan, plan_resolution_work_limit(plan));
    let resolve = |location: &LandXmlPlanPointLocation, resolver: &mut LandXmlPlanResolver<'_>| {
        resolver.resolve(geometry.point_scope_id.as_ref(), location)
    };
    Ok(event::LandXmlPlanResolvedGeometry {
        source_id: geometry.source_id.clone(),
        start: resolve(&geometry.start, &mut resolver)?,
        end: resolve(&geometry.end, &mut resolver)?,
        center: geometry
            .center
            .as_ref()
            .map(|point| resolve(point, &mut resolver))
            .transpose()?
            .flatten(),
        pi: geometry
            .pi
            .as_ref()
            .map(|point| resolve(point, &mut resolver))
            .transpose()?
            .flatten(),
    })
}
