// SPDX-License-Identifier: MPL-2.0
//! #7983: Allplan emits 0..1 for the entire bounded polyline of a swept disk.
//!
//! This is an exporter compatibility rule, not IFC polyline parametrisation
//! (which remains one unit per edge). Limit it to swept disks with this exact
//! range and an Allplan owning application on the project's OwnerHistory.
use ifc_lite_core::{EntityDecoder, IfcType};

pub(crate) fn effective_range(
    directrix: IfcType,
    start: Option<f64>,
    end: Option<f64>,
    decoder: &mut EntityDecoder,
) -> (Option<f64>, Option<f64>) {
    if directrix == IfcType::IfcPolyline
        && start == Some(0.0)
        && end == Some(1.0)
        && owning_application_is_allplan(decoder).unwrap_or(false)
    {
        (None, None)
    } else {
        (start, end)
    }
}

/// Missing/unreadable optional provenance cannot establish the compatibility
/// rule: retain standard trimming in that case. This is a fixed three-hop
/// lookup through decoder-cached entities, never a per-solid source scan.
fn owning_application_is_allplan(decoder: &mut EntityDecoder) -> Option<bool> {
    let project_id = decoder.project_id()?;
    let project = decoder.decode_by_id(project_id).ok()?;
    let history = decoder.decode_by_id(project.get_ref(1)?).ok()?;
    if history.ifc_type != IfcType::IfcOwnerHistory {
        return None;
    }
    let application = decoder.decode_by_id(history.get_ref(1)?).ok()?;
    if application.ifc_type != IfcType::IfcApplication {
        return None;
    }
    Some([2, 3].into_iter().any(|slot| {
        application
            .get_string(slot)
            .is_some_and(|name| name.eq_ignore_ascii_case("Allplan"))
    }))
}
