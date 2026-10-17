// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;

#[test]
fn issue_7292_actual_26832_selected_void_output_has_paired_exact_edges() {
    let Some(content) = ifc_lite_testkit::fixture_text("various/rvt01.ifc") else {
        eprintln!("Skipping actual RVT01 #26832: run pnpm fixtures");
        return;
    };
    let _serial = CENSUS_SWEEP_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _reset = AltTriangulatorReset;
    let frame = ModelFrame::new(&content);
    let voids = void_index(&content);
    #[cfg(feature = "triangulation-alt")]
    let triangulators = &[false, true][..];
    #[cfg(not(feature = "triangulation-alt"))]
    let triangulators = &[false][..];
    for &alt in triangulators {
        set_alt(alt);
        let mesh = process(&frame, 26832, &voids).expect("actual void-cut host must mesh");
        assert!(!mesh.indices.is_empty(), "empty host, alt={alt}");
        assert!(mesh.positions.iter().chain(&mesh.normals).all(|v| v.is_finite())
            && mesh.origin.iter().all(|v| v.is_finite()), "nonfinite host, alt={alt}");
        assert!(mesh.indices.iter().all(|&i| (i as usize) < mesh.positions.len() / 3));
        let exact = edge_stats_exact(&mesh);
        assert_eq!((exact.open, exact.strict, exact.degenerate), (0,0,0),
            "selected represented source must have paired physical edges, alt={alt}");
        assert_eq!(edge_stats(&mesh).open, 0, "selected signed boundary, alt={alt}");
        // DEFAULT's1mm grid aliases distinct closed edges. Its strict snap
        // count is deliberately not the geometry-preservation invariant.
    }
}

#[test]
fn issue_7292_source_boundary_repairs_subgrid_seams_in_actual_host_384() {
    let Some(content) = ifc_lite_testkit::fixture_text("issues/841_house_stack_overflow.ifc") else {
        eprintln!("Skipping actual host #384: run pnpm fixtures");
        return;
    };
    let _serial = CENSUS_SWEEP_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _reset = AltTriangulatorReset;
    let frame = ModelFrame::new(&content);
    let voids = void_index(&content);
    #[cfg(feature = "triangulation-alt")]
    let triangulators = &[false, true][..];
    #[cfg(not(feature = "triangulation-alt"))]
    let triangulators = &[false][..];
    for &alt in triangulators {
        set_alt(alt);
        let mesh = process(&frame, 384, &voids).expect("actual host must mesh");
        assert!(!mesh.indices.is_empty(), "empty host, alt={alt}");
        let exact = edge_stats_exact(&mesh);
        // The old 60-triangle output had eight physical unpaired edges that
        // disappeared on the coarse 1mm grid. Check the actual boundary.
        assert_eq!((exact.open, exact.strict, exact.degenerate), (0,0,0),
            "subgrid source seam, alt={alt}");
    }
}
