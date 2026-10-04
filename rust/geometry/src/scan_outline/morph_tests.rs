// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Morphology unit tests: the distance transform against brute force, the
//! bridging rule of the closing, the opening by reconstruction, saddles.

use super::*;

fn brute_distance_sq(mask: &[u8], w: usize, h: usize) -> Vec<f32> {
    let mut out = vec![f32::INFINITY; w * h];
    for y in 0..h {
        for x in 0..w {
            for sy in 0..h {
                for sx in 0..w {
                    if mask[sy * w + sx] != 0 {
                        let d = ((x as f32 - sx as f32).powi(2)) + ((y as f32 - sy as f32).powi(2));
                        out[y * w + x] = out[y * w + x].min(d);
                    }
                }
            }
        }
    }
    out
}

/// The separable transform must equal the brute-force squared distance:
/// the disk radius of every close/erode rests on it.
#[test]
fn distance_transform_matches_brute_force() {
    let (w, h) = (23, 17);
    let mut state = 0x9e37_79b9_7f4a_7c15u64;
    let mut mask = vec![0u8; w * h];
    for m in mask.iter_mut() {
        state = crate::geom_hash::mix64(state);
        *m = u8::from(state.is_multiple_of(11));
    }
    let got = distance_sq(&mask, w, h, |m| m != 0);
    let want = brute_distance_sq(&mask, w, h);
    for (g, e) in got.iter().zip(&want) {
        assert_eq!(*g, *e);
    }
}

/// Dilating by 3 joins bars up to 6 cells apart and leaves a 7-cell gap
/// open; the one-cell-lighter erosion does not re-open a joined gap.
#[test]
fn closing_bridges_a_gap_up_to_twice_the_radius_between_thick_bars() {
    let (w, h) = (48, 25);
    for (gap, bridged) in [(4usize, true), (6, true), (7, false), (9, false)] {
        let mut mask = vec![0u8; w * h];
        for x in 6..42 {
            if !(20..20 + gap).contains(&x) {
                for y in 8..17 {
                    mask[y * w + x] = 1;
                }
            }
        }
        close(&mut mask, w, h, 3);
        let (_, sizes) = label4(&mask, w, h, 1);
        assert_eq!(sizes.len() == 1, bridged, "gap {gap}");
    }
}

#[test]
fn opening_by_reconstruction_drops_speckle_but_keeps_thin_attached_lines() {
    let (w, h) = (30, 30);
    let mut mask = vec![0u8; w * h];
    for y in 5..15 {
        for x in 5..15 {
            mask[y * w + x] = 1;
        }
    }
    // A one-cell-wide line attached to the block, and a lone speck.
    for x in 15..28 {
        mask[10 * w + x] = 1;
    }
    mask[25 * w + 5] = 1;
    open_by_reconstruction(&mut mask, w, h, 1);
    assert_eq!(mask[10 * w + 27], 1, "thin attached line survives whole");
    assert_eq!(mask[25 * w + 5], 0, "isolated speck removed");
    assert_eq!(mask[5 * w + 5], 1, "block corner not rounded");
}

/// The plain closing (dilate 10, erode 10) leaves this one-cell gap in a
/// one-cell-wide line open; ours must join it.
#[test]
fn closing_joins_a_one_cell_gap_in_a_one_cell_line() {
    let (w, h) = (40, 60);
    let mut mask = vec![0u8; w * h];
    for y in 12..48 {
        if y != 30 {
            mask[y * w + 20] = 1;
        }
    }
    close(&mut mask, w, h, 10);
    assert_eq!(mask[30 * w + 20], 1);
}

#[test]
fn saddles_are_filled() {
    let (w, h) = (4, 4);
    let mut mask = vec![0u8; w * h];
    mask[w + 1] = 1;
    mask[2 * w + 2] = 1;
    fill_saddles(&mut mask, w, h);
    assert_eq!(mask[w + 2], 1);
    assert_eq!(mask[2 * w + 1], 1);
}
