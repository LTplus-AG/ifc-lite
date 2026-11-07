// SPDX-License-Identifier: MPL-2.0
//! Report boundary for recoverable source failures. Callers classify terminal
//! stops and update truncation before reaching this boundary; no cache work or
//! traversal is performed here.
use crate::{Error, GeometryRouter};
use ifc_lite_core::{DecodedEntity, IfcType};

// Keep source-target filters stable when the shared report boundary moves.
macro_rules! nested_diagnostic {
    ($target:literal, $item_id:expr, $error:expr) => {{
        let _ = $item_id;
        crate::diag::diag_debug!(
            { target: $target, item_id = $item_id, error = %$error,
              "skipping nested IfcMappedItem" }
            else {
                #[cfg(debug_assertions)]
                eprintln!("[ifc-lite] Skipping nested IfcMappedItem #{}: {}", $item_id, $error);
            }
        );
    }};
}

pub(super) enum DropReason<'a> {
    Item {
        item: &'a DecodedEntity,
        walk: &'static str,
    },
    NestedFailure {
        item_id: u32,
    },
    LogicalStop {
        item_id: u32,
    },
}

/// Preserve the historical reporting scope: ordinary failures log under the
/// source policy, while logical exhaustion restores the outer policy first.
/// A nested drop is attributed to the mapped item, never its unread inner type.
pub(super) fn report_drop(
    reason: DropReason<'_>,
    _error: &Error,
    policy: bool,
    router: &GeometryRouter,
) {
    let mut scope = Some(router.enter_unsupported_policy(policy));
    let ifc_type = match &reason {
        DropReason::Item { item, .. } => item.ifc_type.clone(),
        DropReason::NestedFailure { .. } | DropReason::LogicalStop { .. } => IfcType::IfcMappedItem,
    };
    router.record_unsupported_item(ifc_type);
    if matches!(reason, DropReason::LogicalStop { .. }) {
        drop(scope.take());
    }
    match reason {
        DropReason::Item { item, walk } => {
            let _ = (item, walk);
            crate::diag::diag_debug!(
                { target: "ifc_lite_geometry::program::mapping::reduce",
                  item_id = item.id, ifc_type = ?item.ifc_type, walk, error = %_error,
                  "skipping unsupported source item" }
                else {
                    #[cfg(debug_assertions)]
                    eprintln!(
                        "[ifc-lite] Skipping unsupported {walk} item #{} ({:?}): {}",
                        item.id, item.ifc_type, _error
                    );
                }
            );
        }
        DropReason::NestedFailure { item_id } => {
            nested_diagnostic!(
                "ifc_lite_geometry::program::mapping::reduce",
                item_id,
                _error
            );
        }
        DropReason::LogicalStop { item_id } => {
            nested_diagnostic!("ifc_lite_geometry::program::mapping::stop", item_id, _error);
        }
    }
}

#[cfg(test)]
#[path = "mapping_drop_tests.rs"]
mod tests;
