// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #3821: the auxiliary `GeometryRouter`s are never drained for boolean
//! failures, and this is the executable reason why.
//!
//! Seven production sites build a router and never call `take_csg_failures`:
//! `processing::processor` (preprocess), `processing::stream_meta`,
//! `processing::symbolic`, `export::model`, and the wasm `grid_lines`,
//! `alignment_lines` and gpu-mesh `prepass`. Each uses the router only for unit
//! scale, RTC-offset detection, placement resolution or routing-key hashing —
//! never for meshing — so none of them can record a `BoolFailure` and draining
//! them would always yield an empty list.
//!
//! That claim was seven prose comments. Prose does not fail when it stops being
//! true, so this file replaces it: for each site, run the SAME router methods
//! that site runs, over a model whose geometry is a boolean the processor is
//! guaranteed to record a failure for, and assert the router drains nothing.
//! Route a boolean through any of these methods and the matching case goes red.
//!
//! What this does NOT catch, stated so no one mistakes its reach: it pins the
//! METHODS each site calls today, not the call site itself. Adding a NEW,
//! meshing call at one of those sites is invisible here — the one-line pointer
//! left at each site is what should send that author back to this file.

use ifc_lite_core::{EntityDecoder, IfcType};
use ifc_lite_geometry::{GeometryRouter, MaterialLayerIndex, TessellationQuality};
use std::sync::Arc;

/// A wall whose Body item is an `IfcBooleanResult` over an operand type with no
/// meshing branch, wrapped in an `IfcCsgSolid` for the second element. Meshing
/// either one records `UnsupportedOperand`, so any router method that started
/// meshing representation items would show up as a non-empty drain.
const BOOLEAN_MODEL: &str = r"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('3821 auxiliary-router probe'),'2;1');
FILE_NAME('aux.ifc','2026-09-04T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6e',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCWALL('1AuxProbeBooleanWall',$,'Wall',$,$,#11,#12,$,$);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','CSG',(#30));
#30=IFCBOOLEANRESULT(.DIFFERENCE.,#31,#33);
#31=IFCSECTIONEDSPINE(#32,(#34),(#5));
#32=IFCCOMPOSITECURVE((),$);
#33=IFCEXTRUDEDAREASOLID(#34,#5,#35,1.0);
#34=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,1.0,0.2);
#35=IFCDIRECTION((0.,0.,1.));
#40=IFCSLAB('1AuxProbeCsgSolidSl',$,'Slab',$,$,#41,#42,$,$);
#41=IFCLOCALPLACEMENT($,#5);
#42=IFCPRODUCTDEFINITIONSHAPE($,$,(#43));
#43=IFCSHAPEREPRESENTATION(#2,'Body','CSG',(#44));
#44=IFCCSGSOLID(#45);
#45=IFCBOOLEANRESULT(.DIFFERENCE.,#31,#33);
ENDSEC;
END-ISO-10303-21;
";

const ELEMENT_IDS: [u32; 2] = [10, 40];

fn decoder() -> EntityDecoder<'static> {
    let bytes = BOOLEAN_MODEL.as_bytes();
    EntityDecoder::with_index(bytes, ifc_lite_core::build_entity_index(bytes))
}

fn jobs() -> Vec<(u32, usize, usize, IfcType)> {
    let mut scanner = ifc_lite_core::EntityScanner::new(BOOLEAN_MODEL.as_bytes());
    let mut out = Vec::new();
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        let ty = ifc_lite_core::legacy_aware_ifc_type(type_name);
        if ty.is_subtype_of(IfcType::IfcProduct) {
            out.push((id, start, end, ty));
        }
    }
    out
}

/// Everything the router has to hand out, as stable reason labels.
fn drained(router: &GeometryRouter) -> Vec<String> {
    // `take_csg_failures` also sweeps the processors' own logs, so a failure
    // from `CsgSolidProcessor`'s transient boolean processor is caught too.
    router
        .take_csg_failures()
        .values()
        .flatten()
        .map(|f| f.reason.label().to_string())
        .collect()
}

/// The probe's own calibration: the SAME model, meshed, must record something.
/// Without this, every assertion below would pass just as happily against a
/// model that has no failures to find — the emptiness would prove nothing.
#[test]
fn the_probe_model_really_does_record_a_failure_when_meshed() {
    let mut dec = decoder();
    let router = GeometryRouter::with_units(BOOLEAN_MODEL.as_bytes(), &mut dec);
    for id in ELEMENT_IDS {
        let element = dec.decode_by_id(id).expect("decode element");
        let _ = router.process_element(&element, &mut dec);
    }
    let labels = drained(&router);
    assert!(
        labels.iter().any(|l| l == "UnsupportedOperand"),
        "the probe model must produce a recordable failure when actually meshed, \
         or the empty drains below prove nothing; got {labels:?}"
    );
}

/// `rust/processing/src/processor/mod.rs` — the preprocess router: tessellation
/// quality, material-layer index, site/building placements, RTC detection.
#[test]
fn the_preprocess_router_meshes_nothing() {
    let mut dec = decoder();
    let mut router = GeometryRouter::with_scale(1.0);
    router.set_tessellation_quality(TessellationQuality::Medium);
    router.set_material_layer_index(Arc::new(MaterialLayerIndex::from_spans(&[], &mut dec)));
    for id in ELEMENT_IDS {
        let element = dec.decode_by_id(id).expect("decode element");
        let _ = router.resolve_scaled_placement(&element, &mut dec);
    }
    let js = jobs();
    let rtc = router.detect_rtc_offset_with_fallback(&js, &mut dec, BOOLEAN_MODEL.as_bytes());
    router.set_rtc_offset(rtc);
    let _ = router.unit_scale();
    let _ = router.rtc_offset();
    assert_eq!(drained(&router), Vec::<String>::new());
}

/// `rust/processing/src/stream_meta.rs` — RTC ladder plus the building-rotation
/// placement read.
#[test]
fn the_stream_meta_router_meshes_nothing() {
    let mut dec = decoder();
    let router = GeometryRouter::with_scale(1.0);
    let js = jobs();
    let _ = router.detect_rtc_offset_from_jobs(&js, &mut dec);
    let _ = router.detect_rtc_offset_with_fallback(&js, &mut dec, BOOLEAN_MODEL.as_bytes());
    for id in ELEMENT_IDS {
        let element = dec.decode_by_id(id).expect("decode element");
        let _ = router.resolve_scaled_placement(&element, &mut dec);
    }
    assert_eq!(drained(&router), Vec::<String>::new());
}

/// `rust/processing/src/symbolic/mod.rs` — unit scale and RTC only.
#[test]
fn the_symbolic_router_meshes_nothing() {
    let mut dec = decoder();
    let router = GeometryRouter::with_units(BOOLEAN_MODEL.as_bytes(), &mut dec);
    let _ = router.unit_scale();
    let _ = router.detect_rtc_offset_from_first_element(BOOLEAN_MODEL.as_bytes(), &mut dec);
    assert_eq!(drained(&router), Vec::<String>::new());
}

/// `rust/wasm-bindings/src/api/alignment_lines.rs` — RTC only.
#[test]
fn the_alignment_lines_router_meshes_nothing() {
    let mut dec = decoder();
    let router = GeometryRouter::with_scale(1.0);
    let _ = router.detect_rtc_offset_from_first_element(BOOLEAN_MODEL.as_bytes(), &mut dec);
    assert_eq!(drained(&router), Vec::<String>::new());
}

/// `rust/wasm-bindings/src/api/grid_lines.rs` — unit scale, RTC, grid placements.
#[test]
fn the_grid_lines_router_meshes_nothing() {
    let mut dec = decoder();
    let router = GeometryRouter::with_units(BOOLEAN_MODEL.as_bytes(), &mut dec);
    let _ = router.unit_scale();
    let _ = router.detect_rtc_offset_from_first_element(BOOLEAN_MODEL.as_bytes(), &mut dec);
    for id in ELEMENT_IDS {
        let element = dec.decode_by_id(id).expect("decode element");
        let _ = router.resolve_scaled_placement(&element, &mut dec);
    }
    assert_eq!(drained(&router), Vec::<String>::new());
}

/// `rust/wasm-bindings/src/api/gpu_meshes/prepass.rs` — the affinity-key router,
/// which hashes a representation's structure and meshes none of it.
#[test]
fn the_prepass_affinity_router_meshes_nothing() {
    let mut dec = decoder();
    let router = GeometryRouter::new();
    for id in ELEMENT_IDS {
        let element = dec.decode_by_id(id).expect("decode element");
        let key = router.geometry_routing_key(&element, &mut dec);
        assert!(key.is_some(), "the probe elements must hash, or this proves nothing");
    }
    assert_eq!(drained(&router), Vec::<String>::new());
}

/// `rust/export/src/model.rs` — placement resolution only.
#[test]
fn the_export_model_router_meshes_nothing() {
    let mut dec = decoder();
    let router = GeometryRouter::with_scale(1.0);
    for id in ELEMENT_IDS {
        let element = dec.decode_by_id(id).expect("decode element");
        let _ = router.resolve_scaled_placement(&element, &mut dec);
    }
    assert_eq!(drained(&router), Vec::<String>::new());
}
