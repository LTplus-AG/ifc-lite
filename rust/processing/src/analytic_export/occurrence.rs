// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Derived occurrence measurements and their serialized representation.

use super::{DirectrixMetrics, SweptDiskOccurrence};
use ifc_lite_geometry::analytic::AnalyticStatus;
use serde::{ser::SerializeStruct, Serialize, Serializer};

impl SweptDiskOccurrence {
    /// Measurements of a complete world-space directrix, or `None` when its
    /// description or derived measurements are unsupported.
    pub fn directrix_metrics(&self) -> Option<DirectrixMetrics> {
        if !matches!(self.status, AnalyticStatus::Complete) {
            return None;
        }
        DirectrixMetrics::from_segments(&self.directrix).ok()
    }
}

impl Serialize for SweptDiskOccurrence {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut record = serializer.serialize_struct("SweptDiskOccurrence", 9)?;
        record.serialize_field("solid_id", &self.solid_id)?;
        record.serialize_field("directrix_id", &self.directrix_id)?;
        record.serialize_field("mapping_path", &self.mapping_path)?;
        record.serialize_field("source_modified", &self.source_modified)?;
        record.serialize_field("Radius", &self.radius)?;
        record.serialize_field("InnerRadius", &self.inner_radius)?;
        record.serialize_field("Directrix", &self.directrix)?;
        record.serialize_field("directrix_metrics", &self.directrix_metrics())?;
        record.serialize_field("status", &self.status)?;
        record.end()
    }
}
