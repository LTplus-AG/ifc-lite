/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use super::*;

#[test]
fn issue_5043_rejects_original_crossings_and_repeated_segments() {
    let square = [[0.0, 0.0], [2.0, 0.0], [2.0, 2.0], [0.0, 2.0]];
    assert_eq!(
        triangulate_terrain_pslg(&square, &[(0, 2), (1, 3)]),
        Err(TerrainCdtError::IntersectingConstraints)
    );
    assert_eq!(
        triangulate_terrain_pslg(&square, &[(0, 1), (1, 0)]),
        Err(TerrainCdtError::IntersectingConstraints)
    );
}

#[test]
fn issue_5043_splits_a_single_endpoint_junction_after_validation() {
    let points = [
        [0.0, 0.0],
        [4.0, 0.0],
        [4.0, 4.0],
        [0.0, 4.0],
        [2.0, 0.0],
        [2.0, 3.0],
    ];
    let mesh = triangulate_terrain_pslg(&points, &[(0, 1), (1, 2), (2, 3), (3, 0), (4, 5)])
        .expect("an endpoint on a constraint is split, not treated as a crossing");
    assert!(mesh.indices.chunks_exact(3).any(|face| {
        face.windows(2).any(|edge| edge == [4, 5])
            || (face[2] == 4 && face[0] == 5)
            || (face[2] == 5 && face[0] == 4)
    }));
}

#[test]
fn issue_5043_accepts_an_oblique_v_junction_without_a_false_collinear_contact() {
    let points = [[0.0, 0.0], [4.0, 4.0], [0.0, 4.0], [2.0, 3.0]];
    let mesh = triangulate_terrain_pslg(&points, &[(0, 1), (0, 3)])
        .expect("an oblique V junction is a valid PSLG");
    assert!(!mesh.indices.is_empty());
}

#[test]
fn issue_5043_progress_cancels_during_exact_cdt_construction() {
    let points = [
        [0.0, 0.0],
        [4.0, 0.0],
        [4.0, 4.0],
        [0.0, 4.0],
        [2.0, 0.0],
        [2.0, 4.0],
        [0.0, 2.0],
        [4.0, 2.0],
        [2.0, 2.0],
    ];
    let segments = [(0, 1), (1, 2), (2, 3), (3, 0), (4, 5)];
    let mut completed_polls = 0usize;
    let complete = triangulate_terrain_pslg_with_progress(&points, &segments, &mut || {
        completed_polls += 1;
        Ok(())
    });
    assert!(complete.is_ok(), "control PSLG is valid");
    assert!(
        completed_polls > 40,
        "the control traverses construction work"
    );

    let mut polls = 0usize;
    let stopped = triangulate_terrain_pslg_with_progress(&points, &segments, &mut || {
        polls += 1;
        if polls > completed_polls / 2 {
            Err(TerrainCdtError::Cancelled)
        } else {
            Ok(())
        }
    });
    assert_eq!(stopped, Err(TerrainCdtError::Cancelled));
    assert!(
        polls < completed_polls,
        "the callback stops before full CDT completion"
    );
}
