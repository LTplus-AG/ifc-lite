// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Authored shell correction through the public native load path (#7714).

use ifc_lite_processing::process_geometry;

const SOURCE: &str = include_str!("../../geometry/tests/fixtures/issue_7714_soffice_carrier.ifc");

#[test]
fn issue_7714_public_native_load_corrects_the_source_corner_in_metres() {
    let corrected = process_geometry(&SOURCE);
    let declined = process_geometry(&SOURCE.replace("3,0.01,#80", "3,$,#80"));
    assert_eq!(corrected.meshes.len(), 1);
    assert_eq!(declined.meshes.len(), 1);
    let (a, b) = (&corrected.meshes[0], &declined.meshes[0]);
    assert_eq!(a.express_id, 900004);
    assert_eq!(a.indices.len(), b.indices.len());
    assert_ne!(
        a.positions, b.positions,
        "public loading must execute normalization"
    );
    let corners = |m: &ifc_lite_processing::MeshData| {
        m.positions
            .chunks_exact(3)
            .map(|p| std::array::from_fn::<_, 3, _>(|i| f64::from(p[i]) + m.origin[i]))
            .filter(|p| {
                (p[1] - 11.8450000131).abs() < 1e-6 && (p[2] + 0.325).abs() < 1e-7 && p[0] < 0.097
            })
            .collect::<Vec<_>>()
    };
    let actual = corners(a);
    let original = corners(b);
    assert!(!actual.is_empty() && !original.is_empty());
    assert!(actual.iter().all(|p| (p[0] - 0.095).abs() < 1e-8));
    assert!(original
        .iter()
        .all(|p| (p[0] - 0.0950001680875).abs() < 1e-8));
}

#[test]
fn issue_7714_copied_witness_products_share_context_without_losing_source_corrections() {
    use ifc_lite_core::EntityScanner;
    // Eight independently renumbered exact source shells, distinct products
    // and GlobalIds, and ONE project/context tree. Every native job must see
    // the same complete certificate (including a shared declined control).
    let mut source = SOURCE.split("#900001=").next().unwrap().to_string();
    for copy in 0..8 {
        let offset = (copy + 1) * 1_000_000;
        let mut scanner = EntityScanner::new(SOURCE.as_bytes());
        let mut records = String::new();
        let mut ids = Vec::new();
        while let Some((id, _, start, end)) = scanner.next_entity() {
            if id >= 489578 {
                records.push_str(&SOURCE[start..end]);
                records.push(';');
                ids.push(id);
            }
        }
        ids.sort_unstable();
        for id in ids.into_iter().rev() {
            for suffix in [",", ")", "="] {
                records = records.replace(
                    &format!("#{id}{suffix}"),
                    &format!("#{}{suffix}", id + offset),
                );
            }
        }
        records = records.replace("0M4en7qsjB6fX9VD8U3pLa", &format!("{copy:022}"));
        source.push_str(&records);
    }
    source.push_str("ENDSEC;END-ISO-10303-21;");
    let declined = source.replace("3,0.01,#80", "3,$,#80");
    for (input, x) in [(&source, 0.095), (&declined, 0.0950001680875)] {
        let result = process_geometry(input);
        assert_eq!(result.meshes.len(), 8);
        for mesh in result.meshes {
            let corners: Vec<_> = mesh
                .positions
                .chunks_exact(3)
                .map(|p| std::array::from_fn::<_, 3, _>(|i| f64::from(p[i]) + mesh.origin[i]))
                .filter(|p| {
                    (p[1] - 11.8450000131).abs() < 1e-6
                        && (p[2] + 0.325).abs() < 1e-7
                        && p[0] < 0.097
                })
                .collect();
            assert!(!corners.is_empty());
            assert!(corners.iter().all(|p| (p[0] - x).abs() < 1e-8));
        }
    }
}
