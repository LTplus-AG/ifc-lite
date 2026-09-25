/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

//! Unit tests for `extract_surface_style_specular` (#5582), kept in a sibling
//! `_tests.rs` module so `surface.rs` stays under the module-size ratchet.
//! Included via `#[path = "surface_tests.rs"] mod tests;`.

use super::*;
use ifc_lite_core::EntityDecoder;

const HEADER: &str = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('m.ifc','2026-09-24',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n";
const FOOTER: &str = "ENDSEC;\nEND-ISO-10303-21;\n";

/// `AC20-FZK-Haus.ifc` #22747/#22748/#22749 verbatim: 'Glas', `SpecularColour
/// = IFCNORMALISEDRATIOMEASURE(1.)`, no `SpecularHighlight`, `ReflectanceMethod
/// = .NOTDEFINED.`. A fully-specular scalar factor maps to roughness 0.0 AS
/// AUTHORED — no floor here, the renderer's shader owns the single
/// `MIN_SPECULAR_ROUGHNESS` clamp (`shaders/specular.wgsl.ts`) — and carries
/// no metal evidence (glass is a dielectric).
#[test]
fn glas_specular_factor_1_0_maps_to_zero_roughness_no_metal() {
    let ifc = format!(
        "{HEADER}#1=IFCCOLOURRGB($,0.58052948806,0.753292133974,0.675211718929);\n\
         #2=IFCSURFACESTYLERENDERING(#1,0.88,IFCNORMALISEDRATIOMEASURE(0.1),$,$,$,IFCNORMALISEDRATIOMEASURE(1.),$,.NOTDEFINED.);\n\
         #3=IFCSURFACESTYLE('Glas',.BOTH.,(#2));\n{FOOTER}"
    );
    let mut decoder = EntityDecoder::new(&ifc);
    let material = extract_surface_style_specular(3, &mut decoder).expect("Glas carries specular evidence");
    assert_eq!(material.metallic, None, "glass is a dielectric — no metal evidence");
    assert!(
        material.roughness.unwrap().abs() < 1e-6,
        "factor 1.0 -> roughness 0.0 as authored, got {:?}",
        material.roughness
    );
}

/// `AC20-FZK-Haus.ifc` #17447/#17448/#17449 verbatim: 'Kiefer, glänzend'
/// (glossy pine), `SpecularColour = IFCNORMALISEDRATIOMEASURE(0.75)`, no
/// `SpecularHighlight`, `ReflectanceMethod = .NOTDEFINED.`. A moderately
/// glossy dielectric: roughness lands between the glass fixture above and the
/// renderer's matte default (0.9), and still carries no metal evidence —
/// varnished wood is not a conductor even at a high specular factor.
#[test]
fn kiefer_glaenzend_specular_factor_0_75_maps_to_moderate_roughness_no_metal() {
    let ifc = format!(
        "{HEADER}#1=IFCCOLOURRGB($,0.963820859083,0.753536278325,0.452460517281);\n\
         #2=IFCSURFACESTYLERENDERING(#1,0.,IFCNORMALISEDRATIOMEASURE(0.6),$,$,$,IFCNORMALISEDRATIOMEASURE(0.75),$,.NOTDEFINED.);\n\
         #3=IFCSURFACESTYLE('Kiefer, glaenzend',.BOTH.,(#2));\n{FOOTER}"
    );
    let mut decoder = EntityDecoder::new(&ifc);
    let material =
        extract_surface_style_specular(3, &mut decoder).expect("glossy pine carries specular evidence");
    assert_eq!(material.metallic, None, "varnished wood is a dielectric — no metal evidence");
    let roughness = material.roughness.expect("factor authored -> roughness resolved");
    assert!((roughness - 0.25).abs() < 1e-6, "1 - 0.75 -> 0.25, got {roughness}");
    assert!(roughness > 0.0, "less glossy than the fully-specular glass fixture");
}

/// `ReflectanceMethod = .METAL.` is direct authored evidence of a conductor,
/// independent of whatever `SpecularColour` factor accompanies it.
#[test]
fn reflectance_method_metal_sets_metallic_one() {
    let ifc = format!(
        "{HEADER}#1=IFCCOLOURRGB($,0.8,0.8,0.85);\n\
         #2=IFCSURFACESTYLERENDERING(#1,0.,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.9),$,.METAL.);\n\
         #3=IFCSURFACESTYLE('Brushed steel',.BOTH.,(#2));\n{FOOTER}"
    );
    let mut decoder = EntityDecoder::new(&ifc);
    let material = extract_surface_style_specular(3, &mut decoder).expect("METAL carries specular evidence");
    assert_eq!(material.metallic, Some(1.0));
}

/// A tinted (non-grey) authored `SpecularColour` `IfcColourRgb` is metal
/// evidence even when `ReflectanceMethod` is left `.NOTDEFINED.` — only a
/// conductor's Fresnel reflectance is wavelength-dependent.
#[test]
fn tinted_specular_colour_implies_metal_even_when_reflectance_method_undefined() {
    let ifc = format!(
        "{HEADER}#1=IFCCOLOURRGB($,0.9,0.9,0.9);\n\
         #2=IFCCOLOURRGB($,1.0,0.766,0.336);\n\
         #3=IFCSURFACESTYLERENDERING(#1,0.,$,$,$,$,#2,$,.NOTDEFINED.);\n\
         #4=IFCSURFACESTYLE('Gold leaf',.BOTH.,(#3));\n{FOOTER}"
    );
    let mut decoder = EntityDecoder::new(&ifc);
    let material = extract_surface_style_specular(4, &mut decoder).expect("tinted specular carries evidence");
    assert_eq!(material.metallic, Some(1.0));
}

/// A grey (untinted) `IfcColourRgb` `SpecularColour` carries no metal
/// evidence — only its luminance feeds the roughness fallback.
#[test]
fn grey_specular_colour_implies_no_metal_but_feeds_roughness() {
    let ifc = format!(
        "{HEADER}#1=IFCCOLOURRGB($,0.8,0.8,0.8);\n\
         #2=IFCCOLOURRGB($,0.9,0.9,0.9);\n\
         #3=IFCSURFACESTYLERENDERING(#1,0.,$,$,$,$,#2,$,.NOTDEFINED.);\n\
         #4=IFCSURFACESTYLE('Satin varnish',.BOTH.,(#3));\n{FOOTER}"
    );
    let mut decoder = EntityDecoder::new(&ifc);
    let material = extract_surface_style_specular(4, &mut decoder).expect("grey specular still carries roughness");
    assert_eq!(material.metallic, None);
    assert!(material.roughness.is_some());
}

/// `SpecularHighlight` as an `IfcSpecularExponent` (Phong exponent) converts
/// via the Karis Phong-to-GGX approximation and wins over the `SpecularColour`
/// factor's roughness fallback.
#[test]
fn specular_exponent_highlight_wins_over_factor_roughness() {
    let ifc = format!(
        "{HEADER}#1=IFCCOLOURRGB($,0.8,0.8,0.8);\n\
         #2=IFCSURFACESTYLERENDERING(#1,0.,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.1),IFCSPECULAREXPONENT(200.),.NOTDEFINED.);\n\
         #3=IFCSURFACESTYLE('Polished lacquer',.BOTH.,(#2));\n{FOOTER}"
    );
    let mut decoder = EntityDecoder::new(&ifc);
    let material =
        extract_surface_style_specular(3, &mut decoder).expect("exponent highlight carries evidence");
    let roughness = material.roughness.expect("highlight authored -> roughness resolved");
    // sqrt(2 / 202) ~= 0.0995, far from the factor fallback's 1 - 0.1 = 0.9.
    assert!((roughness - (2.0f32 / 202.0).sqrt()).abs() < 1e-4, "got {roughness}");
    assert!(roughness < 0.2, "a tight exponent highlight is much glossier than the factor fallback");
}

/// `SpecularHighlight` as an `IfcSpecularRoughness` factor (already 0..1) is
/// used AS AUTHORED — no floor in Rust; the renderer's shader owns the single
/// numerical-stability clamp.
#[test]
fn specular_roughness_highlight_used_directly() {
    let ifc = format!(
        "{HEADER}#1=IFCCOLOURRGB($,0.8,0.8,0.8);\n\
         #2=IFCSURFACESTYLERENDERING(#1,0.,$,$,$,$,$,IFCSPECULARROUGHNESS(0.3),.NOTDEFINED.);\n\
         #3=IFCSURFACESTYLE('Matte-ish',.BOTH.,(#2));\n{FOOTER}"
    );
    let mut decoder = EntityDecoder::new(&ifc);
    let material =
        extract_surface_style_specular(3, &mut decoder).expect("roughness highlight carries evidence");
    assert!((material.roughness.unwrap() - 0.3).abs() < 1e-6);
    assert_eq!(material.metallic, None);
}

/// `IfcSpecularRoughness(0.)` — the exact value flagged in review as "would a
/// floor silently change this?" — is reported as EXACTLY 0.0, not bumped to
/// any Rust-side minimum.
#[test]
fn specular_roughness_zero_is_reported_as_zero() {
    let ifc = format!(
        "{HEADER}#1=IFCCOLOURRGB($,0.8,0.8,0.8);\n\
         #2=IFCSURFACESTYLERENDERING(#1,0.,$,$,$,$,$,IFCSPECULARROUGHNESS(0.),.NOTDEFINED.);\n\
         #3=IFCSURFACESTYLE('Mirror-ish',.BOTH.,(#2));\n{FOOTER}"
    );
    let mut decoder = EntityDecoder::new(&ifc);
    let material =
        extract_surface_style_specular(3, &mut decoder).expect("roughness highlight carries evidence");
    assert_eq!(material.roughness, Some(0.0));
}

/// A `SpecularHighlight` whose authored value overflows `f64` parsing to
/// `+inf` (a real STEP numeric-overflow case, e.g. an enormous exponent
/// literal) carries no usable evidence and must not reach
/// `phong_exponent_to_roughness`/the direct-roughness clamp as `inf` — the
/// whole attribute is treated as unauthored, falling back to the
/// `SpecularColour` factor.
#[test]
fn non_finite_specular_exponent_is_treated_as_absent() {
    let ifc = format!(
        "{HEADER}#1=IFCCOLOURRGB($,0.8,0.8,0.8);\n\
         #2=IFCSURFACESTYLERENDERING(#1,0.,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.2),IFCSPECULAREXPONENT(1.0e40),.NOTDEFINED.);\n\
         #3=IFCSURFACESTYLE('Overflowed exponent',.BOTH.,(#2));\n{FOOTER}"
    );
    let mut decoder = EntityDecoder::new(&ifc);
    let material = extract_surface_style_specular(3, &mut decoder)
        .expect("the SpecularColour factor still carries evidence");
    // Falls back to the factor: 1 - 0.2 = 0.8, NOT some function of `inf`.
    assert!(
        (material.roughness.unwrap() - 0.8).abs() < 1e-6,
        "non-finite exponent must fall back to the factor, got {:?}",
        material.roughness
    );
}

/// Same non-finite guard, `IfcSpecularRoughness` variant: an overflowed
/// authored roughness must not survive `f32::clamp` (which returns `NaN`/
/// out-of-range non-finite inputs unchanged rather than saturating them).
#[test]
fn non_finite_specular_roughness_is_treated_as_absent() {
    let ifc = format!(
        "{HEADER}#1=IFCCOLOURRGB($,0.8,0.8,0.8);\n\
         #2=IFCSURFACESTYLERENDERING(#1,0.,$,$,$,$,IFCNORMALISEDRATIOMEASURE(0.4),IFCSPECULARROUGHNESS(1.0e40),.NOTDEFINED.);\n\
         #3=IFCSURFACESTYLE('Overflowed roughness',.BOTH.,(#2));\n{FOOTER}"
    );
    let mut decoder = EntityDecoder::new(&ifc);
    let material = extract_surface_style_specular(3, &mut decoder)
        .expect("the SpecularColour factor still carries evidence");
    assert!(
        (material.roughness.unwrap() - 0.6).abs() < 1e-6,
        "non-finite roughness must fall back to the factor (1 - 0.4 = 0.6), got {:?}",
        material.roughness
    );
}

/// Same non-finite guard, `SpecularColour` as an `IfcColourRgb` tint: an
/// overflowed component (`1.0e40` parses to `+inf` as `f32`) must not reach
/// the tint test or the luminance fallback. It carries no evidence, so with
/// nothing else authored the extractor reports none, rather than a
/// `roughness = 0` mirror (or a tinted metal) built from `inf`.
#[test]
fn non_finite_specular_colour_rgb_is_treated_as_absent() {
    let ifc = format!(
        "{HEADER}#1=IFCCOLOURRGB($,0.8,0.8,0.8);\n\
         #4=IFCCOLOURRGB($,1.0e40,0.5,0.5);\n\
         #2=IFCSURFACESTYLERENDERING(#1,0.,$,$,$,$,#4,$,.NOTDEFINED.);\n\
         #3=IFCSURFACESTYLE('Overflowed tint',.BOTH.,(#2));\n{FOOTER}"
    );
    let mut decoder = EntityDecoder::new(&ifc);
    assert_eq!(extract_surface_style_specular(3, &mut decoder), None);
}

/// No `SpecularColour`, no `SpecularHighlight`, `ReflectanceMethod`
/// `.NOTDEFINED.` — nothing authored, so the extractor reports no evidence at
/// all and the caller keeps its own defaults.
#[test]
fn no_specular_attributes_returns_none() {
    let ifc = format!(
        "{HEADER}#1=IFCCOLOURRGB($,0.8,0.8,0.8);\n\
         #2=IFCSURFACESTYLERENDERING(#1,0.,$,$,$,$,$,$,.NOTDEFINED.);\n\
         #3=IFCSURFACESTYLE('Plain',.BOTH.,(#2));\n{FOOTER}"
    );
    let mut decoder = EntityDecoder::new(&ifc);
    assert_eq!(extract_surface_style_specular(3, &mut decoder), None);
}

/// `IfcSurfaceStyleShading` (no rendering attributes at all) carries no
/// specular fields — must not be misread as a rendering with everything null.
#[test]
fn surface_style_shading_has_no_specular_evidence() {
    let ifc = format!(
        "{HEADER}#1=IFCCOLOURRGB($,0.8,0.8,0.8);\n\
         #2=IFCSURFACESTYLESHADING(#1,0.);\n\
         #3=IFCSURFACESTYLE('Shading only',.BOTH.,(#2));\n{FOOTER}"
    );
    let mut decoder = EntityDecoder::new(&ifc);
    assert_eq!(extract_surface_style_specular(3, &mut decoder), None);
}
