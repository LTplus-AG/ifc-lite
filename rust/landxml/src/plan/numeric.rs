/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

pub(super) use super::{
    LandXmlGeometryKind, LandXmlParcel, LandXmlParcelProbe, LandXmlParcelState,
    LandXmlPlanDocument, LandXmlPlanGeometry, LandXmlPlanPoint, LandXmlPlanPointLocation,
    LandXmlPlanResolver,
};

mod measure;
mod parcel_measure;
mod parcel_probe;
pub mod references;
mod topology;
use measure::same_point;

const EPSILON: f64 = 1e-9;

/// The parcel probe's resolution and topology passes must charge the same
/// caller-owned work counter. The ordinary single-parcel API owns a local
/// counter; bulk adapters provide their document-scoped resolver instead.
pub(super) trait ParcelProbeWork {
    fn check(&mut self) -> std::result::Result<(), crate::LandXmlError>;

    fn resolve(
        &mut self,
        document: &LandXmlPlanDocument,
        scope: Option<&crate::LandXmlSourceId>,
        location: &LandXmlPlanPointLocation,
    ) -> std::result::Result<Option<LandXmlPlanPoint>, crate::LandXmlError>;
}

impl ParcelProbeWork for LandXmlPlanResolver<'_> {
    fn check(&mut self) -> std::result::Result<(), crate::LandXmlError> {
        self.check_work()
    }

    fn resolve(
        &mut self,
        _document: &LandXmlPlanDocument,
        scope: Option<&crate::LandXmlSourceId>,
        location: &LandXmlPlanPointLocation,
    ) -> std::result::Result<Option<LandXmlPlanPoint>, crate::LandXmlError> {
        LandXmlPlanResolver::resolve(self, scope, location)
    }
}

impl LandXmlPlanDocument {
    /// Partition plan-source identities without coupling semantic records to a
    /// renderer allocation or introducing a second model-load path.
    pub fn source_batches(&self, max_records: usize) -> Vec<super::LandXmlPlanSourceBatch> {
        if max_records == 0 {
            return Vec::new();
        }
        let source_ids = self
            .cogo_points()
            .iter()
            .map(|point| point.source_id.clone())
            .chain(
                self.monuments
                    .iter()
                    .map(|monument| monument.source_id.clone()),
            )
            .chain(self.plan_features.iter().flat_map(|feature| {
                std::iter::once(feature.source_id.clone()).chain(
                    feature
                        .geometry
                        .iter()
                        .map(|geometry| geometry.source_id.clone()),
                )
            }))
            .chain(self.parcels.iter().flat_map(|parcel| {
                std::iter::once(parcel.source_id.clone()).chain(
                    parcel
                        .loops
                        .iter()
                        .flatten()
                        .map(|geometry| geometry.source_id.clone()),
                )
            }));
        let mut batches = Vec::new();
        let mut current = Vec::new();
        for source_id in source_ids {
            current.push(source_id);
            if current.len() == max_records {
                batches.push(super::LandXmlPlanSourceBatch {
                    source_ids: current,
                });
                current = Vec::new();
            }
        }
        if !current.is_empty() {
            batches.push(super::LandXmlPlanSourceBatch {
                source_ids: current,
            });
        }
        batches
    }
}
