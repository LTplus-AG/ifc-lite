// SPDX-License-Identifier: MPL-2.0
//! #7955 test generator: same legal clip repeated, all cutter calls admitted.
//! This derived boundary stress input is outside the coverage universe.
pub fn chain(count:usize)->String {
    let mut records=String::new();let mut last=11;
    for i in 0..count {
        let next=1000+i;
        records.push_str(&format!("#{next}=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#{last},#17);\n"));last=next;
    }
    include_str!("f-e-clips.ifc").replace("'CSG',(#18)",&format!("'CSG',(#{last})"))
        .replace("ENDSEC;\nEND-ISO",&format!("{records}ENDSEC;\nEND-ISO"))
}
