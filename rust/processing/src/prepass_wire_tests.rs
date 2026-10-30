// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Round-trip contracts for the prepass flat-wire codecs (EDGE-WASM-10,
//! #8341), plus the decoders' leniency cases. The void and style decode cases
//! moved here from `wasm-bindings` with the decoders themselves.

use super::*;
use crate::prepass::{flat_styles_rgba8, ResolvedPrepass};
use crate::style::{GeometryStyleInfo, Rgba};
use ifc_lite_core::EntityDecoder;

// ── Round trips ──

/// Every host survives encode then decode with its openings in order,
/// including a host whose opening list is empty (count 0 on the wire).
#[test]
fn voids_round_trip_through_the_flat_wire() {
    let mut voids: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    voids.insert(300, vec![302, 301]);
    voids.insert(7, vec![8]);
    voids.insert(90, Vec::new());
    voids.insert(u32::MAX, vec![1, 2, 3]);

    let (keys, counts, values) = flat_voids(&voids);
    assert_eq!(voids_from_flat(&keys, &counts, &values), voids);
}

/// The style wire carries every precedence layer as RGBA8. Decoding it must
/// give back each merged colour exactly as RGBA8 quantization leaves it, the
/// geometry style must keep its id over the indexed-colour dominant, and no id
/// may appear or vanish on the way.
#[test]
fn styles_round_trip_through_the_flat_wire() {
    let mut resolved = ResolvedPrepass::default();
    resolved
        .geometry_style_index
        .insert(10, GeometryStyleInfo::from_color([0.2, 0.4, 0.6, 1.0]));
    resolved
        .geometry_style_index
        .insert(30, GeometryStyleInfo::from_color([1.0, 0.0, 0.5, 0.25]));
    // Indexed-colour dominants: #10 loses to its geometry style, #20 fills a gap.
    resolved.indexed_colour_index.insert(10, [0.0, 0.0, 0.0, 1.0]);
    resolved.indexed_colour_index.insert(20, [0.123, 0.456, 0.789, 0.5]);
    let mut decoder = EntityDecoder::new(b"");

    let (ids, rgba) = flat_styles_rgba8(&resolved, &mut decoder);
    let decoded = style_colors_from_flat(&ids, &rgba);

    let quantized = |c: [f32; 4]| Rgba::from_rgba8(Rgba::from_array(c).to_rgba8()).to_array();
    let expected: FxHashMap<u32, [f32; 4]> = [
        (10, quantized([0.2, 0.4, 0.6, 1.0])),
        (20, quantized([0.123, 0.456, 0.789, 0.5])),
        (30, quantized([1.0, 0.0, 0.5, 0.25])),
    ]
    .into_iter()
    .collect();
    assert_eq!(decoded, expected);
}

/// A colour already on the RGBA8 grid survives the round trip bit-for-bit, so
/// the browser batch and the native pipeline see the same f32 for it.
#[test]
fn an_rgba8_exact_style_round_trips_bit_for_bit() {
    let mut resolved = ResolvedPrepass::default();
    let exact = [51.0 / 255.0, 1.0, 0.0, 204.0 / 255.0];
    resolved.geometry_style_index.insert(5, GeometryStyleInfo::from_color(exact));
    let (ids, rgba) = flat_styles_rgba8(&resolved, &mut EntityDecoder::new(b""));
    assert_eq!(style_colors_from_flat(&ids, &rgba)[&5], exact);
}

// ── Void decode leniency ──

#[test]
fn mismatched_void_counts_length_drops_the_index_without_panicking() {
    // counts shorter than keys: an unchecked `void_counts[i]` panics (wasm abort).
    assert!(voids_from_flat(&[10, 20, 30], &[2], &[1, 2]).is_empty());
}

#[test]
fn an_overlong_void_count_stops_and_keeps_what_fits() {
    // count overruns values: an unchecked slice panics. Keep what fits.
    let idx = voids_from_flat(&[10, 20], &[1, 99], &[7, 8]);
    assert_eq!(idx.get(&10), Some(&vec![7]));
    assert_eq!(idx.get(&20), None, "the second entry's slice overruns, so decoding stopped");
}

// ── Style decode leniency ──

/// Stride and lane order in one fixture: three styles, every one of the twelve
/// bytes distinct, so reading stride 3, or transposing r/b, or shifting by one
/// lane all land on a different number.
#[test]
fn each_style_reads_its_own_four_bytes_in_rgba_order() {
    let ids = [10u32, 20, 30];
    let bytes: Vec<u8> = vec![
        0, 51, 102, 153, // id 10
        204, 255, 17, 34, // id 20
        68, 85, 119, 136, // id 30
    ];
    let map = style_colors_from_flat(&ids, &bytes);

    assert_eq!(map.len(), 3);
    let close = |a: f32, b: f32| (a - b).abs() < 1e-6;
    let c10 = map[&10];
    assert!(close(c10[0], 0.0) && close(c10[1], 51.0 / 255.0));
    assert!(close(c10[2], 102.0 / 255.0) && close(c10[3], 153.0 / 255.0));
    let c20 = map[&20];
    assert!(
        close(c20[0], 204.0 / 255.0) && close(c20[3], 34.0 / 255.0),
        "style 20's colour starts at byte 4, not byte 3"
    );
    let c30 = map[&30];
    assert!(
        close(c30[0], 68.0 / 255.0) && close(c30[3], 136.0 / 255.0),
        "style 30's colour starts at byte 8"
    );
}

/// 255 must land on exactly 1.0 — the divisor is 255, not 256, and a fully
/// saturated channel that arrives as 0.996 is a visible colour shift that a
/// tolerance-based assertion would wave through.
#[test]
fn a_full_byte_is_exactly_one() {
    let map = style_colors_from_flat(&[1], &[255, 0, 255, 255]);
    assert_eq!(map[&1], [1.0, 0.0, 1.0, 1.0], "255/255 is exactly 1.0; 255/256 would be 0.99609");
}

/// The length guard is inclusive of the last byte: four bytes is a complete
/// style, three is not. Testing only a wildly short buffer would pass with the
/// comparison off by one in either direction.
#[test]
fn a_style_is_kept_only_when_all_four_of_its_bytes_are_present() {
    assert_eq!(style_colors_from_flat(&[1], &[1, 2, 3, 4]).len(), 1, "exactly four bytes is one complete style");
    assert!(style_colors_from_flat(&[1], &[1, 2, 3]).is_empty(), "three bytes cannot make an RGBA quad");
}

/// A short tail costs the styles it truncates their colour and nothing else —
/// the complete ones ahead of it still decode. Two styles with only one
/// complete is the case that separates "drop the tail" from "drop everything"
/// and from "read past the end".
#[test]
fn a_truncated_style_wire_keeps_the_complete_styles_ahead_of_the_tail() {
    let map = style_colors_from_flat(&[10, 20], &[255, 255, 255, 255, 1, 2]);
    assert_eq!(map.len(), 1, "style 20's quad is incomplete");
    assert!(map.contains_key(&10), "style 10's quad is complete");
    assert!(!map.contains_key(&20));
}

#[test]
fn an_empty_style_wire_decodes_to_an_empty_map() {
    assert!(style_colors_from_flat(&[], &[]).is_empty());
    assert!(
        style_colors_from_flat(&[1, 2], &[]).is_empty(),
        "ids with no colour bytes at all yield nothing, not black"
    );
}
