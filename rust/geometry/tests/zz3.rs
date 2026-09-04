use ifc_lite_geometry::kernel::mesh_bridge::union_many;
use ifc_lite_geometry::{ClippingProcessor, Mesh};
use nalgebra::{Point3, Rotation3, Unit, Vector3};
use std::collections::HashMap;
const SNAP_GRID: f64 = 1.0 / 65536.0;
fn boxed(min: [f64;3], size: [f64;3], rot: Option<(Vector3<f64>, f64, [f64;3])>) -> Mesh {
    let mx=[min[0]+size[0],min[1]+size[1],min[2]+size[2]];
    let c=|i:usize|->[f64;2]{[min[i],mx[i]]};
    let mut corners: Vec<Point3<f64>> = [(0,0,0),(1,0,0),(1,1,0),(0,1,0),(0,0,1),(1,0,1),(1,1,1),(0,1,1)]
        .iter().map(|&(i,j,k)| Point3::new(c(0)[i],c(1)[j],c(2)[k])).collect();
    if let Some((axis,angle,about))=rot { let r=Rotation3::from_axis_angle(&Unit::new_normalize(axis),angle);
        let o=Point3::new(about[0],about[1],about[2]); for p in corners.iter_mut(){*p=o+r*(*p-o);} }
    let faces:[[usize;4];6]=[[0,3,2,1],[4,5,6,7],[0,1,5,4],[2,3,7,6],[0,4,7,3],[1,2,6,5]];
    let mut m=Mesh::with_capacity(24,36);
    for f in &faces { let e1=corners[f[1]]-corners[f[0]]; let e2=corners[f[2]]-corners[f[0]];
        let n=e1.cross(&e2).try_normalize(1e-12).unwrap_or(Vector3::z()); let b=m.vertex_count() as u32;
        for &i in f {m.add_vertex(corners[i],n);} m.add_triangle(b,b+1,b+2); m.add_triangle(b,b+2,b+3); }
    m
}
fn open_edges(m:&Mesh)->Result<usize,String>{
    if m.is_empty(){return Err("empty".into());}
    let w=m.welded_by_position(1e-4); let mut e:HashMap<(u32,u32),(u32,u32)>=HashMap::new();
    for t in w.indices.chunks_exact(3){for k in 0..3{let(a,b)=(t[k],t[(k+1)%3]); if a==b {return Err("degen".into());}
        let x=e.entry((a.min(b),a.max(b))).or_insert((0,0)); if a<b{x.0+=1}else{x.1+=1}}}
    Ok(e.values().filter(|&&(f,r)|f!=1||r!=1).count())
}
fn tri(dz: f64) -> (Mesh, Mesh, Mesh) {
    let a=boxed([0.0,0.0,0.0],[1.0,1.0,1.0],None);
    let b=boxed([0.5,0.5,dz],[1.0,1.0,1.0],Some((Vector3::z(),30.0f64.to_radians(),[1.0,1.0,0.5+dz])));
    let c=boxed([-0.5,0.5,-dz],[1.0,1.0,1.0],Some((Vector3::z(),-20.0f64.to_radians(),[0.0,1.0,0.5-dz])));
    (a,b,c)
}
#[test]
fn probe3() {
    for &dz in &[0.0, SNAP_GRID, 0.25] {
        let (a,b,c)=tri(dz);
        let raw = union_many(&[&a,&b,&c]);
        println!("dz={dz}: raw union_many open={:?} tris={}", open_edges(&raw), raw.indices.len()/3);
        let cl = ClippingProcessor::new();
        let p1 = cl.union_mesh(&a,&b).unwrap();
        let p2 = cl.union_mesh(&p1,&c).unwrap();
        println!("dz={dz}: pairwise open={:?}", open_edges(&p2));
    }
    // two-operand controls at the same dz
    let (a,b,c)=tri(SNAP_GRID);
    println!("ab={:?} ac={:?} bc={:?}", open_edges(&union_many(&[&a,&b])), open_edges(&union_many(&[&a,&c])), open_edges(&union_many(&[&b,&c])));
}
