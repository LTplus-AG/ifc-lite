// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #5389: an IfcAnnotation's `Annotation2D` representation is meshed for its
//! fill areas (#4406), but the curve sets and text literals beside them are
//! symbolic. Walking them counted each as a dropped representation item, so
//! the viewer and the native `tracing::warn!` reported a clean model as
//! "missing or incomplete" (293 items on AC20-FZK-Haus). Asserted on the
//! pipeline's own `geometry_diagnostics`, the value both surfaces print.

use ifc_lite_processing::process_geometry;

const MIXED: &str = "ISO-10303-21;HEADER;FILE_DESCRIPTION(('ViewDefinition [DesignTransferView]'),'2;1');FILE_NAME('mixed.ifc','2026-09-24T00:00:00',(''),(''),'IfcOpenShell','IfcOpenShell','');FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);#3=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#2,$);
#4=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);#5=IFCUNITASSIGNMENT((#4));#6=IFCPROJECT('0000000000000000000000',$,'Annotation symbolic items',$,$,$,$,(#3),#5);
#10=IFCCARTESIANPOINT((0.,0.));#11=IFCCARTESIANPOINT((4000.,0.));#12=IFCCARTESIANPOINT((4000.,4000.));#13=IFCCARTESIANPOINT((0.,4000.));
#20=IFCPOLYLINE((#10,#11,#12,#13,#10));#22=IFCANNOTATIONFILLAREA(#20,$);
#23=IFCGEOMETRICCURVESET((#20));#24=IFCAXIS2PLACEMENT2D(#10,$);#25=IFCPLANAREXTENT(1000.,300.);#26=IFCTEXTLITERALWITHEXTENT('4,00',#24,.LEFT.,#25,'bottom-left');
#30=IFCSHAPEREPRESENTATION(#3,'Annotation','Annotation2D',(#22,#23,#26,#20));#31=IFCPRODUCTDEFINITIONSHAPE($,$,(#30));#32=IFCLOCALPLACEMENT($,#2);
#40=IFCANNOTATION('0000000000000000000001',$,'Dimension with fill',$,$,#32,#31);
ENDSEC;END-ISO-10303-21;";

fn dropped_types(result: &ifc_lite_processing::ProcessingResult) -> Vec<String> {
    result
        .stats
        .geometry_diagnostics
        .as_ref()
        .map(|d| {
            d.unsupported_items_by_type
                .iter()
                .map(|r| format!("{}={}", r.reason, r.count))
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn issue_5389_symbolic_annotation_items_are_not_dropped_items() {
    let result = process_geometry(MIXED.as_bytes());
    assert_eq!(result.meshes.len(), 1, "the fill still meshes: {:?}", result.stats);
    assert_eq!(result.meshes[0].geometry_item_id, Some(22));
    assert!(
        dropped_types(&result).is_empty(),
        "symbolic items reported as dropped: {:?}",
        dropped_types(&result)
    );
}

const FIXTURE: &str = "../../tests/models/ara3d/AC20-FZK-Haus.ifc";

#[test]
fn issue_5389_fzk_haus_reports_no_dropped_annotation_items() {
    let bytes = match std::fs::read(FIXTURE) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            eprintln!(
                "skipping #5389 fixture test: {FIXTURE} missing — run `pnpm fixtures` \
                 (sha256 in tests/models/manifest.json)"
            );
            return;
        }
        Err(e) => panic!("failed to read fixture {FIXTURE}: {e}"),
    };
    let result = process_geometry(&bytes);
    let dropped = dropped_types(&result);
    assert!(
        !dropped
            .iter()
            .any(|d| d.starts_with("IfcGeometricCurveSet=") || d.starts_with("IfcTextLiteralWithExtent=")),
        "AC20-FZK-Haus annotation curves/text reported as dropped: {dropped:?}"
    );
}
