// SPDX-License-Identifier: MPL-2.0
//! The geometry fixture of [`super`]: products with body geometry. Synthetic,
//! like the rest.

use super::{gid, entity_line, quoted, preamble, header, FOOTER, local_placement_at};

/// Products with body geometry, for the geometry patch. Every schema gets the
/// same ids except the IFC2X3-only style assignments (`#70`, `#94`).
///
/// - Contexts: `#100` Model, `#103` Body and `#104` Axis subcontexts.
/// - Wall `#10`: shape `#60` holding a Body (`#61`) and an Axis (`#62`)
///   representation. `#61` lists its own solid `#63` (styled by `#69`) and a
///   solid `#76` that wall `#11`'s body lists too. `#63` shares its profile
///   `#64` with `#76` and `#92`. Layer `#80` holds `#61`, `#62` and `#91`;
///   layer `#83` holds only `#62`. Opening `#95` voids the wall through `#98`.
/// - Wall `#11`: shape `#90`, Body `#91` listing `#92` (styled by `#93`) and
///   the shared `#76`. Both styled items use surface style `#72`.
/// - Walls `#12` and `#13`: typed by `#120`, each body one `IfcMappedItem`
///   (`#112`, `#132`) of the type's map `#113`, sharing the transform `#117`.
/// - Wall `#14`: no Representation at all.
pub(in crate::plan) fn products_with_geometry(schema: &str) -> Vec<u8> {
    let ifc2x3 = schema == "IFC2X3";
    let rooted = |id: u32| quoted(&gid(id));
    let mut d = String::new();
    for (id, identifier, target) in [(103, "'Body'", ".MODEL_VIEW."), (104, "'Axis'", ".GRAPH_VIEW.")] {
        d += &entity_line(
            schema,
            id,
            "IFCGEOMETRICREPRESENTATIONSUBCONTEXT",
            &[
                ("ContextIdentifier", identifier),
                ("ContextType", "'Model'"),
                ("CoordinateSpaceDimension", "*"),
                ("Precision", "*"),
                ("WorldCoordinateSystem", "*"),
                ("TrueNorth", "*"),
                ("ParentContext", "#100"),
                ("TargetView", target),
            ],
        );
    }
    let product = |d: &mut String, id: u32, placement: u32, representation: Option<u32>| {
        let rep = representation.map(|r| format!("#{r}"));
        let mut fields = vec![("GlobalId", rooted(id)), ("Name", format!("'Wall {id}'")), ("ObjectPlacement", format!("#{placement}"))];
        if let Some(rep) = rep {
            fields.push(("Representation", rep));
        }
        let fields: Vec<(&str, &str)> = fields.iter().map(|(k, v)| (*k, v.as_str())).collect();
        *d += &entity_line(schema, id, "IFCWALL", &fields);
    };
    let solid = |id: u32, position: u32, direction: u32, depth: &str| format!("#{id}=IFCEXTRUDEDAREASOLID(#64,#{position},#{direction},{depth});\n");
    let styled = |id: u32, item: u32, style: u32| format!("#{id}=IFCSTYLEDITEM(#{item},(#{style}),$);\n");

    product(&mut d, 10, 20, Some(60));
    d += &local_placement_at(20, 21, 22, 0.0);
    d += "#60=IFCPRODUCTDEFINITIONSHAPE($,$,(#61,#62));\n";
    d += "#61=IFCSHAPEREPRESENTATION(#103,'Body','SweptSolid',(#63,#76));\n";
    d += "#62=IFCSHAPEREPRESENTATION(#104,'Axis','Curve2D',(#73));\n";
    d += &solid(63, 67, 68, "3.");
    d += &entity_line(schema, 64, "IFCRECTANGLEPROFILEDEF", &[("ProfileType", ".AREA."), ("Position", "#65"), ("XDim", "5."), ("YDim", "0.2")]);
    d += "#65=IFCAXIS2PLACEMENT2D(#66,$);\n";
    d += "#66=IFCCARTESIANPOINT((2.5,0.1));\n";
    d += "#67=IFCAXIS2PLACEMENT3D(#102,$,$);\n";
    d += "#68=IFCDIRECTION((0.,0.,1.));\n";
    if ifc2x3 {
        d += &styled(69, 63, 70);
        d += "#70=IFCPRESENTATIONSTYLEASSIGNMENT((#72));\n";
    } else {
        d += &styled(69, 63, 72);
    }
    d += "#72=IFCSURFACESTYLE('Shared',.BOTH.,(#78));\n";
    d += &entity_line(schema, 78, "IFCSURFACESTYLESHADING", &[("SurfaceColour", "#79")]);
    d += "#79=IFCCOLOURRGB($,0.5,0.5,0.5);\n";
    d += "#73=IFCPOLYLINE((#74,#75));\n";
    d += "#74=IFCCARTESIANPOINT((0.,0.));\n";
    d += "#75=IFCCARTESIANPOINT((5.,0.));\n";
    d += &solid(76, 81, 82, "1.");
    d += "#81=IFCAXIS2PLACEMENT3D(#102,$,$);\n";
    d += "#82=IFCDIRECTION((0.,0.,1.));\n";
    d += "#80=IFCPRESENTATIONLAYERASSIGNMENT('L1',$,(#61,#62,#91),$);\n";
    d += "#83=IFCPRESENTATIONLAYERASSIGNMENT('L2',$,(#62),$);\n";
    d += &entity_line(schema, 95, "IFCOPENINGELEMENT", &[("GlobalId", &rooted(95)), ("Name", "'Opening'"), ("ObjectPlacement", "#96")]);
    d += "#96=IFCLOCALPLACEMENT(#20,#97);\n";
    d += "#97=IFCAXIS2PLACEMENT3D(#102,$,$);\n";
    d += &entity_line(schema, 98, "IFCRELVOIDSELEMENT", &[("GlobalId", &rooted(98)), ("RelatingBuildingElement", "#10"), ("RelatedOpeningElement", "#95")]);

    product(&mut d, 11, 23, Some(90));
    d += &local_placement_at(23, 24, 25, 1.0);
    d += "#90=IFCPRODUCTDEFINITIONSHAPE($,$,(#91));\n";
    d += "#91=IFCSHAPEREPRESENTATION(#103,'Body','SweptSolid',(#92,#76));\n";
    d += &solid(92, 84, 85, "3.");
    d += "#84=IFCAXIS2PLACEMENT3D(#102,$,$);\n";
    d += "#85=IFCDIRECTION((0.,0.,1.));\n";
    if ifc2x3 {
        d += &styled(93, 92, 94);
        d += "#94=IFCPRESENTATIONSTYLEASSIGNMENT((#72));\n";
    } else {
        d += &styled(93, 92, 72);
    }

    for (wall, placement, shape) in [(12, 26, 110), (13, 29, 130)] {
        product(&mut d, wall, placement, Some(shape));
        d += &local_placement_at(placement, placement + 1, placement + 2, f64::from(wall));
        d += &format!("#{shape}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{}));\n", shape + 1);
        d += &format!("#{}=IFCSHAPEREPRESENTATION(#103,'Body','MappedRepresentation',(#{}));\n", shape + 1, shape + 2);
        d += &format!("#{}=IFCMAPPEDITEM(#113,#117);\n", shape + 2);
    }
    d += "#113=IFCREPRESENTATIONMAP(#114,#115);\n";
    d += "#114=IFCAXIS2PLACEMENT3D(#102,$,$);\n";
    d += "#115=IFCSHAPEREPRESENTATION(#103,'Body','SweptSolid',(#116));\n";
    d += &solid(116, 118, 119, "2.");
    d += "#118=IFCAXIS2PLACEMENT3D(#102,$,$);\n";
    d += "#119=IFCDIRECTION((0.,0.,1.));\n";
    d += "#117=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#102,$,$);\n";
    d += &entity_line(
        schema,
        120,
        "IFCWALLTYPE",
        &[("GlobalId", &rooted(120)), ("Name", "'Type'"), ("RepresentationMaps", "(#113)"), ("PredefinedType", ".NOTDEFINED.")],
    );
    d += &entity_line(schema, 121, "IFCRELDEFINESBYTYPE", &[("GlobalId", &rooted(121)), ("RelatedObjects", "(#12,#13)"), ("RelatingType", "#120")]);

    product(&mut d, 14, 32, None);
    d += &local_placement_at(32, 33, 34, 4.0);

    format!("{}{}{}{}", header(schema), preamble(schema), d, FOOTER).into_bytes()
}
