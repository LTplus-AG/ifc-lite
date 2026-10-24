// SPDX-License-Identifier: MPL-2.0
//! #7955 fixed independent analytical volumes, shared by native and real Worker.
pub const TWO: &str = include_str!("../../../../../tests/evidence/retained-layers-j3/circular-wall-2.ifc");
pub const THREE: &str = include_str!("../../../../../tests/evidence/retained-layers-j3/circular-wall-3.ifc");
pub fn cases() -> Vec<(String,Vec<f64>)> {
    let rows: serde_json::Value = serde_json::from_str(include_str!("../../../../../tests/evidence/retained-layers-j3/curved-oracles.json")).unwrap();
    let volumes = |i:usize| rows[i]["bandNetVolume"].as_array().unwrap().iter().map(|v|v.as_f64().unwrap()).collect::<Vec<_>>();
    let two = volumes(0);
    let negative = TWO.replace("#20,1.,", "#20,2.,").replace("#21,2.,", "#21,1.,")
        .replace(".POSITIVE.,0.,$", ".NEGATIVE.,3.,$");
    let placed = TWO.replace("#8=IFCLOCALPLACEMENT($,#5)","#8=IFCLOCALPLACEMENT($,#902)")
        .replace("ENDSEC;\nEND-ISO", "#900=IFCCARTESIANPOINT((5000000.,-4000000.,12.));\n#901=IFCDIRECTION((0.,1.,0.));\n#902=IFCAXIS2PLACEMENT3D(#900,#7,#901);\nENDSEC;\nEND-ISO");
    vec![(TWO.into(),two.clone()),(THREE.into(),volumes(1)),
        (negative,two.iter().rev().copied().collect()),(millimetres(TWO),two.clone()),(placed,two),
        (empty_first_band(),vec![0.,24.*std::f64::consts::PI])]
}
pub fn mapped() -> String {
    TWO.replace("'Body','SweptSolid',(#15)","'Body','MappedRepresentation',(#903)")
        .replace("ENDSEC;\nEND-ISO", "#900=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#15));\n#901=IFCREPRESENTATIONMAP(#5,#900);\n#902=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,1.,$);\n#903=IFCMAPPEDITEM(#901,#902);\nENDSEC;\nEND-ISO")
}
fn millimetres(source:&str) -> String {
    let mut result = String::new();
    for line in source.lines() {
        let mut line = line.replace("$,.METRE.",".MILLI.,.METRE.");
        if line.contains("=IFCCARTESIANPOINT((") {
            let (prefix,values) = line.split_once("((").unwrap();
            let values = values.trim_end_matches("));").split(',').map(|s|format!("{}",s.parse::<f64>().unwrap()*1000.)).collect::<Vec<_>>().join(",");
            line = format!("{prefix}(({values}));");
        } else if line.contains("=IFCCIRCLE(") || line.contains("=IFCEXTRUDEDAREASOLID(") {
            let (prefix,value) = line.rsplit_once(',').unwrap();
            line = format!("{prefix},{});",value.trim_end_matches(");").parse::<f64>().unwrap()*1000.);
        } else if line.contains("=IFCMATERIALLAYER(") {
            let mut values = line.split(',').map(str::to_owned).collect::<Vec<_>>();
            values[1] = format!("{}",values[1].parse::<f64>().unwrap()*1000.);
            line = values.join(",");
        }
        result.push_str(&line);result.push('\n');
    }
    result
}

pub fn assert_section(positions:&[f64], frame:&[f64;16], product:&[f64;16], start:f64, end:f64) {
    let transform = nalgebra::Matrix4::from_column_slice(product).try_inverse().unwrap()
        * nalgebra::Matrix4::from_column_slice(frame);
    let (inner,outer) = ((10.-start).min(10.-end),(10.-start).max(10.-end));
    let mut corners = [false;4];
    for point in positions.chunks_exact(3) {
        let p = transform * nalgebra::Vector4::new(point[0],point[1],point[2],1.);
        let radius = p[0].hypot(p[1]-10.);
        assert!(radius >= inner-1e-6 && radius <= outer+1e-6 && p[2]>=-1e-6 && p[2]<=3.+1e-6,
            "J3_SECTION: {radius} {}",p[2]);
        for (i,(r,z)) in [(inner,0.),(outer,0.),(inner,3.),(outer,3.)].iter().enumerate() {
            corners[i] |= (radius-r).abs()<1e-6 && (p[2]-z).abs()<1e-6;
        }
    }
    assert!(corners.into_iter().all(|present|present),"J3_SECTION_EXTENTS");
}

fn empty_first_band() -> String {
    let mut result = String::new();
    for line in TWO.lines() {
        let id = line.strip_prefix('#').and_then(|s|s.split_once('='))
            .and_then(|(id,_)|id.parse::<u32>().ok());
        if id.is_some_and(|id|(200..=217).contains(&id)) { continue; }
        let line = line.replace("#250=IFCCARTESIANPOINT((0.,0.,1.))", "#250=IFCCARTESIANPOINT((0.,0.,0.))")
            .replace("#252=IFCEXTRUDEDAREASOLID(#217,#251,#7,1.)", "#252=IFCEXTRUDEDAREASOLID(#217,#251,#7,3.)");
        result.push_str(&line);result.push('\n');
        if id.is_some_and(|id|(100..=117).contains(&id)) {
            // Same exact finite host sector, narrowed to the first radial band.
            let opening = line.replace("#1","#2").replace("IFCCIRCLE(#201,7)","IFCCIRCLE(#201,9)")
                .replace("((7,10))","((9,10))")
                .replace("((4.2862637970157361e-16,3))","((5.5109105961630896e-16,1))");
            result.push_str(&opening);result.push('\n');
        }
    }
    result
}
