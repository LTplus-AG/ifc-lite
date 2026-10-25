// SPDX-License-Identifier: MPL-2.0
//! Source-bound, diagnostic-only entry for the existing development census.
use super::*;
use crate::retained_inspection_contract as wire;
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry::program::{SourceInspectionError, SourceInspectionReport};
use ifc_lite_geometry::resource::{self, Cost, ExecutionAccount, ExecutionPolicy, ProgramStop, ResourceLimits};
use std::sync::Arc;

#[path = "retained_inspection_binding.rs"]
mod binding;
#[path = "retained_inspection_error.rs"]
mod error;
pub use error::RetainedInspectionError;

/// Opaque validated inspection; holds charged bytes and snapshot, never a lease.
pub struct RetainedSourceInspection {
    report: SourceInspectionReport,
    snapshot: Arc<OwnedMeshProductionContext>,
}
impl RetainedSourceInspection {
    /// Revalidate original source/stop before borrowing diagnostic bytes.
    pub fn bytes(&self) -> Result<&[u8], RetainedInspectionError> {
        self.snapshot.lifecycle().validate().map_err(RetainedInspectionError::source)?;
        self.report.validate_original_stop().map_err(RetainedInspectionError::stopped)?;
        Ok(self.report.bytes())
    }
}

/// Inspect one census-selected product. Options use the strict private A1s wire
/// contract. This feature-gated Rust seam is not viewer/CLI retained delivery.
/// The implementation identity must be supplied by the source-pinned caller.
pub fn inspect_retained_source(
    source: Arc<SourceBundle>, product_id: u32, supplied_root: Option<&DecodedEntity>,
    decoder: &mut EntityDecoder, options_json: &str, implementation_commit: &str,
) -> Result<RetainedSourceInspection, RetainedInspectionError> {
    if options_json.len() > 4096 || wire::text_format(implementation_commit, "commit").is_err() {
        return Err(RetainedInspectionError::invalid_options());
    }
    resource::check_current().map_err(RetainedInspectionError::stopped)?;
    let options = wire::decode_options(options_json).map_err(|_| RetainedInspectionError::invalid_options())?;
    let max_work = options.max_work.parse().map_err(|_| RetainedInspectionError::invalid_options())?;
    let max_bytes = options.max_bytes.parse().map_err(|_| RetainedInspectionError::invalid_options())?;
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits {
        work: Some(max_work), live_bytes: Some(max_bytes), ..Default::default()
    }));
    let model = ProductionModel::from_source(source.clone());
    let snapshot = model.snapshot(OwnedMeshProductionData::default());
    account.scope(|| {
        let _scratch = resource::charge(Cost { live_bytes: 256 * 1024, ..Default::default() })
            .map_err(RetainedInspectionError::stopped)?;
        snapshot.validate_decoder(decoder).map_err(RetainedInspectionError::source)?;
        // Use canonical unit resolution; no separate representation walk.
        let router = router_for_source(source.bytes(), decoder)?;
        resource::check_current().map_err(RetainedInspectionError::stopped)?;
        inspect_bound(&source, snapshot, product_id, supplied_root, &options, implementation_commit, decoder, &router)
    })
}

#[allow(clippy::too_many_arguments)]
fn inspect_bound(
    source: &Arc<SourceBundle>, snapshot: Arc<OwnedMeshProductionContext>, product_id: u32,
    supplied_root: Option<&DecodedEntity>, options: &wire::Options, implementation_commit: &str,
    decoder: &mut EntityDecoder, router: &GeometryRouter,
) -> Result<RetainedSourceInspection, RetainedInspectionError> {
    inspect_bound_after(source, snapshot, product_id, supplied_root, options, implementation_commit, decoder, router, || {})
}

#[allow(clippy::too_many_arguments)]
fn inspect_bound_after(
    source: &Arc<SourceBundle>, snapshot: Arc<OwnedMeshProductionContext>, product_id: u32,
    supplied_root: Option<&DecodedEntity>, options: &wire::Options, implementation_commit: &str,
    decoder: &mut EntityDecoder, router: &GeometryRouter, after_work: impl FnOnce(),
) -> Result<RetainedSourceInspection, RetainedInspectionError> {
    snapshot.validate_decoder(decoder).map_err(RetainedInspectionError::source)?;
    let mut owner = session_owner::ProductOwner::admit(decoder, router).map_err(RetainedInspectionError::owner)?;
    let (result, _) = owner.work(decoder, router, |decoder, router| {
        snapshot.validate_decoder(decoder).map_err(RetainedInspectionError::source)?;
        let decoded = decoder.decode_by_id(product_id);
        resource::check_current().map_err(RetainedInspectionError::stopped)?;
        let root = decoded.map_err(|_| RetainedInspectionError::invalid_source())?;
        if let Some(supplied) = supplied_root {
            if supplied.id != root.id || supplied.ifc_type != root.ifc_type
                || !Arc::ptr_eq(&supplied.attributes, &root.attributes) {
                return Err(RetainedInspectionError::mismatched_source());
            }
        }
        let binding = binding::from_source(source, &root, options, snapshot.lifecycle().epoch_revision().1)?;
        let json = serde_json::to_string(&binding).map_err(|_| RetainedInspectionError::invalid_report())?;
        let report = ifc_lite_geometry::program::inspect_retained_program_source(
            &root, decoder, router, &json, snapshot.lifecycle().epoch_revision().0, implementation_commit,
        ).map_err(RetainedInspectionError::geometry)?;
        // Never accept arbitrary JSON as the controller column. Validate the
        // second generated projection against our independently held binding.
        validate_report(&report, &binding, implementation_commit)?;
        Ok(report)
    }).map_err(RetainedInspectionError::owner)?;
    after_work();
    // ProductOwner has restored source/owner scopes and committed actual cache
    // identities. These checks must stay outside work, before exposing bytes.
    snapshot.validate_decoder(decoder).map_err(RetainedInspectionError::source)?;
    owner.validate(decoder, router).map_err(RetainedInspectionError::owner)?;
    let report = result?;
    report.validate_original_stop().map_err(RetainedInspectionError::stopped)?;
    drop(owner);
    Ok(RetainedSourceInspection { report, snapshot })
}

fn router_for_source(bytes: &[u8], decoder: &mut EntityDecoder) -> Result<GeometryRouter, RetainedInspectionError> {
    use session_protocol::WorkError;
    let mut lease = decoder.try_execution_lease().map_err(|_| RetainedInspectionError::owner(WorkError::OwnerBusy))?;
    let work = lease.begin_synchronous_work(decoder.execution_identity())
        .map_err(|_| RetainedInspectionError::owner(WorkError::WrongOwner))?;
    let source = work.source_borrow_scope_with_resources(resource::current_source_context());
    let stop = source.resource_stop_handle();
    let result = resource::with_source_stop(stop.clone(), || {
        let router = GeometryRouter::with_units(bytes, decoder);
        resource::check_current().map_err(RetainedInspectionError::stopped)?;
        Ok(router)
    });
    let stopped = stop.check();
    drop(source);
    let committed = work.commit(decoder.execution_identity());
    stopped.map_err(RetainedInspectionError::stopped)?;
    committed.map_err(|_| RetainedInspectionError::owner(WorkError::WrongOwner))?;
    result
}

fn validate_report(report: &SourceInspectionReport, binding: &wire::Binding, implementation_commit: &str)
    -> Result<(), RetainedInspectionError> {
    report.validate_original_stop().map_err(RetainedInspectionError::stopped)?;
    let json = std::str::from_utf8(report.bytes()).map_err(|_| RetainedInspectionError::invalid_report())?;
    let decoded = wire::decode_inspection_report(json, binding).map_err(|_| RetainedInspectionError::invalid_report())?;
    if decoded.column != wire::Column::Controller || decoded.implementation_commit != implementation_commit {
        return Err(RetainedInspectionError::invalid_report());
    }
    Ok(())
}

#[cfg(test)]
#[path = "retained_inspection_tests.rs"]
mod tests;
