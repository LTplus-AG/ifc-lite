// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Per-item failure parity with the wasm path (alignment audit).
//!
//! `processGeometryBatch` always used the submesh path, where an unsupported
//! representation item is skipped and the rest of the element still renders.
//! The server's default path used single-mesh `process_element`, whose item
//! loop bails with `?` — one exotic item made the WHOLE element invisible in
//! server/parquet output while the browser showed it partially. This pins the
//! server-side skip behaviour.

use ifc_lite_processing::{process_geometry, process_geometry_filtered, OpeningFilterMode};

/// A wall whose Body carries one supported extruded solid AND one
/// unsupported representation item (`IFCSECTIONEDSPINE` — no processor).
const MIXED_ITEMS_IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('alignment-audit mixed-items fixture'),'2;1');
FILE_NAME('mixed.ifc','2026-06-12T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0$ScRe4drECQ4DMSqUjd6e',$,'P',$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));
#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);
#6=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);

#10=IFCWALL('1MixedItemsWall000001',$,'Wall',$,$,#11,#12,$,$);
#11=IFCLOCALPLACEMENT($,#5);
#12=IFCPRODUCTDEFINITIONSHAPE($,$,(#13));
#13=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#14,#20));
#14=IFCEXTRUDEDAREASOLID(#15,#5,#16,3.0);
#15=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,4.0,0.3);
#16=IFCDIRECTION((0.,0.,1.));
#20=IFCSECTIONEDSPINE(#21,(#15),(#5));
#21=IFCCOMPOSITECURVE((),$);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn unsupported_item_no_longer_kills_the_element() {
    let result = process_geometry(MIXED_ITEMS_IFC);
    assert!(
        !result.meshes.is_empty(),
        "wall with one supported solid + one unsupported item must still \
         produce geometry on the server path (wasm parity)"
    );
    assert!(result.stats.total_triangles > 0);
}

#[test]
fn opening_filters_unaffected_by_submesh_default() {
    // The submesh default must not regress the opening-filter modes.
    for mode in [
        OpeningFilterMode::Default,
        OpeningFilterMode::IgnoreAll,
        OpeningFilterMode::IgnoreOpaque,
    ] {
        let result = process_geometry_filtered(MIXED_ITEMS_IFC, mode);
        assert!(!result.meshes.is_empty(), "no meshes under {mode:?}");
    }
}
