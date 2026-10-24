// SPDX-License-Identifier: MPL-2.0
//! Initial final-removal domain: no authored material/appearance dependencies.
//! This conservative whole-source exclusion cannot confuse a lossy display
//! index with evidence of absence. Styled/layered files remain explicitly gated.
use super::*;
pub(super) fn validate<R: NumericalReceipt>(execution: &RuntimeProductExecution<'_,R>)
    -> Result<(),RetainedExecutionError> {
    let plan = execution.plan.as_ref().ok_or_else(||protocol("unfinished product"))?;
    execution.removal.as_ref().ok_or(RetainedExecutionError::Unsupported("final product is not authenticated removal"))?
        .validate(execution.context.id(),plan)?;
    if execution.layer_pending || execution.layer_source.is_some() || execution.layer_manifest.is_some() {
        return Err(RetainedExecutionError::Unsupported("removed product material source obligations remain mandatory"));
    }
    let source = execution.context.source().ok_or(RetainedExecutionError::Source)?;
    // Preflight scanner storage (including malformed-record diagnostics) before
    // scanning. No lazy entity decoding is performed after numerical Empty.
    execution.resources.charge(resource::Cost { work: source.bytes().len() as u64,
        live_bytes: source.bytes().len() as u64 * 8, ..Default::default() })?.retain();
    let mut scanner = ifc_lite_core::EntityScanner::new(source.bytes());
    while let Some((_,name,start,end)) = scanner.next_entity() {
        execution.resources.check()?;
        if ifc_lite_core::parser::StepRecord::parse_complete(&source.bytes()[start..end]).is_none() {
            return Err(RetainedExecutionError::Source);
        }
        // No source style/material/type inheritance can be hidden by a missing
        // or filtered display index. Even unrelated authored records refuse in
        // this initial domain; their qualification is a separate integration.
        let forbidden = ["STYLE", "MATERIAL", "TEXTURE", "COLOUR", "COLOR", "PRESENTATION"];
        if forbidden.iter().any(|word| name.as_bytes().windows(word.len()).any(|s| s.eq_ignore_ascii_case(word.as_bytes())))
            || ifc_lite_core::keyword_eq(name,"IFCRELDEFINESBYTYPE") {
            return Err(RetainedExecutionError::Unsupported("removed product authored appearance/material evidence required"));
        }
    }
    if !scanner.malformed_record_starts().is_empty() || !scanner.skipped_oversized_id_starts().is_empty() {
        return Err(RetainedExecutionError::Source);
    }
    let data = execution.context.borrowed();
    if !data.geometry_style_index.is_empty() || !data.indexed_colour_full.is_empty()
        || !data.element_material_colors.is_empty() || !data.texture_index.is_empty() {
        return Err(RetainedExecutionError::Unsupported("removed product appearance index requires source evidence"));
    }
    for requirement in &plan.remaining {
        match requirement {
            // AuthenticatedRemoval validates authored placements and source
            // containment; authenticate_openings rechecks ordered receipts.
            RetainedRequirement::ProductPlacement | RetainedRequirement::OpeningClosure => {},
            // No authored material/style dependencies above; no surviving
            // surfaces for colour, UVs, normals, caps, face ids or instancing.
            RetainedRequirement::MaterialLayers | RetainedRequirement::IfcAppearance
            | RetainedRequirement::PersistentFaces => {},
        }
    }
    Ok(())
}
