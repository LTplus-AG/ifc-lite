// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! C4-0 (#7782): raw attribution evidence and value-bound exception payloads.
//! Preserve the in-memory fields serde skips and exact floating-point bits.
//! Only elements with an observed mesh/colour/identity/job drift are retained.

use super::compare::{Axis, Drift};
use ifc_lite_processing::MeshData;
use serde_json::{json, Value};
use std::collections::BTreeSet;

pub(super) fn selected(native: &[&MeshData], browser: &[&MeshData], drifts: &[Drift]) -> Value {
    let ids: BTreeSet<u32> = drifts
        .iter()
        .filter(|d| {
            matches!(
                d.axis,
                Axis::MeshHash
                    | Axis::Color
                    | Axis::ElementSet
                    | Axis::JobSet
                    | Axis::Placement
                    | Axis::Layers
                    | Axis::TypeGeometry
            )
        })
        .filter_map(|d| d.element)
        .collect();
    let side = |meshes: &[&MeshData]| {
        meshes
            .iter()
            .filter(|m| ids.contains(&m.express_id))
            .map(|m| record(m))
            .collect::<Vec<_>>()
    };
    json!({ "ids": ids, "native": side(native), "browser": side(browser) })
}

pub(super) fn record(m: &MeshData) -> Value {
    json!({
        "mesh": m,
        "geometryClass": m.geometry_class,
        "origin": m.origin,
        "localBounds": m.local_bounds,
        "localToWorld": m.local_to_world,
        "instance": m.instance.as_ref().map(|i| json!({
            "repIdentity": i.rep_identity.to_string(), "instanceable": i.instanceable,
            "transform": i.transform, "localTransform": i.local_transform,
            "canonicalTransform": i.canonical_transform,
        })),
        "bits": {
            "positions": m.positions.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            "normals": m.normals.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
            "origin": m.origin.map(f64::to_bits),
            "color": m.color.map(f32::to_bits),
            "uvs": m.uvs.as_ref().map(|v| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>()),
            "localBounds": m.local_bounds.map(|v| v.map(f32::to_bits)),
            "localToWorld": m.local_to_world.map(|v| v.map(f64::to_bits)),
            "instance": m.instance.as_ref().map(|i| json!({
                "transform": i.transform.map(f64::to_bits),
                "localTransform": i.local_transform.map(|v| v.map(f64::to_bits)),
                "canonicalTransform": i.canonical_transform.map(|v| v.map(f64::to_bits)),
            })),
        },
    })
}

/// Bind an exception to every mesh byte, including metadata serde skips.
/// This deliberately pins both sides: changing an already-different payload
/// must fail, even if its axis/element identity remains the same.
pub(super) fn binding(native: &[&MeshData], browser: &[&MeshData], drift: &Drift) -> Value {
    let side = |meshes: &[&MeshData]| {
        let mut values: Vec<String> = meshes
            .iter()
            .filter(|m| drift.element.is_none_or(|id| m.express_id == id))
            .map(|m| {
                let text = serde_json::to_string(&record(m)).unwrap();
                let hash = super::entry_trace::fnv(&text);
                format!("{hash:016x}")
            })
            .collect();
        values.sort();
        values
    };
    serde_json::json!({ "fixture": drift.fixture, "axis": format!("{:?}", drift.axis),
        "element": drift.element, "detail": drift.detail,
        "nativePayloads": side(native), "browserPayloads": side(browser) })
}
