// SPDX-License-Identifier: MPL-2.0
//! Admit the consumer's recipe clone and lowering envelope before construction.
//! Audited backing only, not an allocator/RSS or opaque SDK memory guarantee.
use super::*;
use ifc_lite_geometry::analytic::{AnalyticBoundarySource, AnalyticStatus, OwnedDirectrix, SourceValue};

struct Estimate { bytes: u64, work: u64 }
impl Estimate {
    fn add(&mut self, count: usize, width: usize) -> Result<(), ProgramStop> {
        let bytes = count.checked_mul(width).ok_or_else(resource::overflow)? as u64;
        self.bytes = self.bytes.checked_add(bytes).ok_or_else(resource::overflow)?;
        self.work = self.work.checked_add(count as u64).ok_or_else(resource::overflow)?;
        resource::check_current()
    }
    fn vector<T>(&mut self, values: &[T]) -> Result<(), ProgramStop> {
        self.add(values.len(), std::mem::size_of::<T>())
    }
    fn status(&mut self, status: &AnalyticStatus) -> Result<(), ProgramStop> {
        if let AnalyticStatus::Unsupported(text) = status { self.add(text.len(), 1)?; }
        Ok(())
    }
    fn source(&mut self, source: Option<&AnalyticBoundarySource>) -> Result<(), ProgramStop> {
        let Some(source) = source else { return Ok(()); };
        self.status(&source.capture_status)?;
        // Conservative per-entry node envelopes for the owned BTreeMaps;
        // includes unused slots/pointers, unlike just counting key/value bytes.
        self.add(source.records.len(), 12 * (std::mem::size_of::<ifc_lite_geometry::analytic::SourceRecord>() + 32))?;
        for record in source.records.values() {
            self.add(record.ifc_type_name.len(), 1)?;
            self.add(record.attributes.len(), 12 * (std::mem::size_of::<SourceValue>() + 64))?;
            for (name, value) in &record.attributes {
                self.add(name.len(), 1)?;
                self.value(value, 0)?;
            }
        }
        Ok(())
    }
    fn value(&mut self, value: &SourceValue, depth: usize) -> Result<(), ProgramStop> {
        // This walks owned acyclic values, not IFC references. Bound both stack
        // and total work before the subsequent deep clone can run.
        if depth >= 32 || self.work >= 1_000_000 {
            return Err(resource::refused(resource::Dimension::Work, self.work, 1_000_000,
                resource::RefusalReason::Limit));
        }
        self.add(1, 0)?;
        match value {
            SourceValue::String(text) | SourceValue::Binary(text) | SourceValue::Enum(text) => self.add(text.len(), 1)?,
            SourceValue::List(values) => {
                self.vector(values)?;
                for value in values { self.value(value, depth + 1)?; }
            }
            SourceValue::Typed { name, value } => {
                self.add(name.len(), 1)?;
                self.add(1, std::mem::size_of::<SourceValue>())?;
                self.value(value, depth + 1)?;
            }
            _ => {}
        }
        Ok(())
    }
}

pub(super) fn reserve(resources: &OwnedResourceContext, recipe: &RetainedRecipe)
    -> Result<Arc<Storage>, RetainedExecutionError> {
    resources.with_scope(|| {
        let mut estimate = Estimate {
            // Document entry, Arc, vector header and fixed wire/lowering setup.
            bytes: 4096, work: 0,
        };
        let result: Result<(), ProgramStop> = (|| {
            match recipe {
                RetainedRecipe::Extrusion(recipe) => {
                    let source = &recipe.source;
                    estimate.status(&source.status)?;
                    estimate.source(source.source.as_ref())?;
                    if let Some(profile) = &source.profile {
                        estimate.add(profile.ifc_type_name.len(), 1)?;
                        if let Some(kind) = &profile.profile_type { estimate.add(kind.len(), 1)?; }
                        estimate.status(&profile.status)?;
                        estimate.vector(&profile.loops)?;
                        for boundary in &profile.loops {
                            estimate.vector(&boundary.segments)?;
                            estimate.source(boundary.source.as_ref())?;
                            // Conservative wire/region scratch allowance per
                            // segment (wire v1 is 104 bytes per segment).
                            estimate.add(boundary.segments.len(), 4096)?;
                        }
                    }
                }
                RetainedRecipe::SweptDisk(recipe) => {
                    let source = &recipe.source;
                    estimate.status(&source.status)?;
                    estimate.source(source.source.as_ref())?;
                    estimate.vector(&source.segments)?;
                    match &source.owned_directrix {
                        Some(OwnedDirectrix::Segments(segments)) => {
                            estimate.vector(segments)?;
                            estimate.add(segments.len(), 4096)?;
                        }
                        Some(OwnedDirectrix::Rational(path)) => {
                            estimate.vector(&path.control_points)?;
                            estimate.vector(&path.weights)?;
                            estimate.vector(&path.knots)?;
                            estimate.vector(&path.multiplicities)?;
                            estimate.vector(&path.expanded_knots)?;
                            estimate.add(path.control_points.len() + path.knots.len(), 4096)?;
                        }
                        None => {}
                    }
                }
                _ => return Err(resource::refused(resource::Dimension::Coverage, 0, 0,
                    resource::RefusalReason::UnsupportedCoverage)),
            }
            Ok(())
        })();
        result.map_err(RetainedExecutionError::Stopped)?;
        let mut storage = Storage::default();
        storage.charge(resources, resource::Cost { live_bytes: estimate.bytes,
            copy_bytes: estimate.bytes, work: estimate.work, ..Default::default() })?;
        Ok(Arc::new(storage))
    })
}
