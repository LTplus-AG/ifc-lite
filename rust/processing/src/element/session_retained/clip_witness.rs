// SPDX-License-Identifier: MPL-2.0
//! Off-centre geometric invariants, not qualification claims. Tests are UNRUN.
use super::EntityDecoder;

pub(super) type Shape = (f64,[f64;2],f64);
fn shape(positions:&[f64],indices:&[u32])->Shape {
    let at=|i:u32| {let i=i as usize*3;[positions[i],positions[i+1],positions[i+2]]};
    let mut volume=0.;let mut first_moment_z=0.;
    for face in indices.chunks_exact(3) {
        let [a,b,c]=[at(face[0]),at(face[1]),at(face[2])];
        let v=(a[0]*(b[1]*c[2]-b[2]*c[1])+a[1]*(b[2]*c[0]-b[0]*c[2])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6.;
        volume+=v;first_moment_z+=v*(a[2]+b[2]+c[2])/4.;
    }
    let bounds=positions.chunks_exact(3).fold([f64::INFINITY,f64::NEG_INFINITY],|[lo,hi],p|[lo.min(p[2]),hi.max(p[2])]);
    (volume,bounds,first_moment_z/volume)
}
pub(super) fn assert_offcentre(positions:&[f64],indices:&[u32],upper:bool)->Shape {
    let actual=shape(positions,indices);
    let expected=if upper {(16.,[1.,3.],2.)}else{(8.,[0.,1.],0.5)};
    assert_same(actual,expected);actual
}
pub(super) fn assert_same(actual:Shape,expected:Shape) {
    assert!((actual.0-expected.0).abs()<1e-6,"signed volume {:?} vs {:?}",actual,expected);
    assert!((actual.1[0]-expected.1[0]).abs()<1e-6 && (actual.1[1]-expected.1[1]).abs()<1e-6,"signed z bounds {:?} vs {:?}",actual,expected);
    assert!((actual.2-expected.2).abs()<1e-6,"volume centroid {:?} vs {:?}",actual,expected);
}
pub(super) fn exact_difference(decoder:&mut EntityDecoder<'_>)->Shape {
    // A distinct decoder/router executes the unchanged exact source path; it
    // never supplies geometry or authority to the retained production executor.
    let entity=decoder.decode_by_id(100).unwrap();
    let mesh=super::GeometryRouter::new().process_representation_item(&entity,decoder).unwrap();
    let positions:Vec<f64>=mesh.positions.iter().map(|v|*v as f64).collect();
    shape(&positions,&mesh.indices)
}
