// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Declared geometric context precision for context-free analytic extraction.

use super::EntityDecoder;
use crate::{Error, Result};
use crate::parser::{keyword_eq, EntityScanner};

impl EntityDecoder<'_> {
    /// Smallest and largest declared `IfcGeometricRepresentationContext.Precision`
    /// in raw IFC file-length units. A source profile can be reused from multiple
    /// representations: the largest declaration gives conservative boundary
    /// clearance, while the smallest bounds when adjacent points may be treated
    /// as the same join. Returns `None` when nothing declares Precision; IFC
    /// defines no default.
    ///
    /// This is a lazy, cached full-file scan and does not decode non-context
    /// entities. A malformed explicit Precision is an error, not zero.
    pub fn geometric_context_precision_range(&mut self) -> Result<Option<(f64, f64)>> {
        if self.geometric_precision_cache.is_none() {
            self.geometric_precision_cache = Some(self.scan_geometric_context_precision());
        }
        self.geometric_precision_cache.as_ref().unwrap().clone()
            .map_err(|message| Error::parse(0, message))
    }

    fn scan_geometric_context_precision(&self) -> std::result::Result<Option<(f64, f64)>, String> {
        let mut scanner = EntityScanner::new(self.content);
        let mut range: Option<(f64, f64)> = None;
        while let Some((id, type_name, start, end)) = scanner.next_entity() {
            if !keyword_eq(type_name, "IFCGEOMETRICREPRESENTATIONCONTEXT")
                && !keyword_eq(type_name, "IFCGEOMETRICREPRESENTATIONSUBCONTEXT") {
                continue;
            }
            let entity = self.decode_at_uncached(start, end)
                .map_err(|error| format!("geometric context #{id}: {error}"))?;
            let attribute = entity.get(3)
                .ok_or_else(|| format!("geometric context #{id} has no Precision attribute"))?;
            if attribute.is_null() { continue; }
            let precision = attribute.as_float()
                .filter(|value| value.is_finite() && *value > 0.0)
                .ok_or_else(|| format!("geometric context #{id} has invalid Precision"))?;
            range = Some(range.map_or((precision, precision), |(min, max)| {
                (min.min(precision), max.max(precision))
            }));
        }
        Ok(range)
    }
}

#[cfg(test)]
#[path = "precision_tests.rs"]
mod tests;
