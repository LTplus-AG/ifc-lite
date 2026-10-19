// SPDX-License-Identifier: MPL-2.0
//! Native fault peers prove rejection/retirement/cleanup only, never SDK success.
#![cfg(all(unix,not(target_arch="wasm32")))]
use ifc_lite_core::{build_entity_index,EntityDecoder};
use ifc_lite_geometry::{analytic::extract_analytic_extrusion,document::{
    EvaluationContract,GeometryDocument,RetainedExtrusion}};
use ifc_lite_geometry_runtime::{MeshLimits,PlaneClipMode,PlaneSide,RetainedDependency,
    RetainedRealization,SmlibWorker,WorkerError};
use std::sync::atomic::{AtomicU64,Ordering};
static NEXT_FIXTURE:AtomicU64=AtomicU64::new(1);
const I:[f64;16]=[1.,0.,0.,0.,0.,1.,0.,0.,0.,0.,1.,0.,0.,0.,0.,1.];
struct Fixture { worker:SmlibWorker, directory:std::path::PathBuf }
impl Fixture {
    fn new(case:&str) -> Self {
        let unique=NEXT_FIXTURE.fetch_add(1,Ordering::Relaxed);
        let directory=std::env::temp_dir().join(format!("ifclite-plane-fault-{}-{case}-{unique}",std::process::id()));
        std::fs::create_dir(&directory).unwrap();
        std::fs::write(directory.join("case"),case).unwrap();
        let peer=directory.join("peer");
        std::os::unix::fs::symlink(std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/plane-fault-peer.py"),&peer).unwrap();
        Self { worker:SmlibWorker::spawn(peer).unwrap(),directory }
    }
    fn source(&mut self) -> RetainedRealization {
        let input=b"#1=IFCCARTESIANPOINT((0.,0.));#2=IFCAXIS2PLACEMENT2D(#1,$);#3=IFCRECTANGLEPROFILEDEF(.AREA.,$,#2,1.,1.);#4=IFCDIRECTION((0.,0.,1.));#5=IFCEXTRUDEDAREASOLID(#3,$,#4,1.);";
        let mut decoder=EntityDecoder::with_index(input,build_entity_index(input));let e=decoder.decode_by_id(5).unwrap();
        let mut document=GeometryDocument::new();
        let definition=document.add_retained_extrusion(RetainedExtrusion {source:extract_analytic_extrusion(&e,&mut decoder),
            length_unit_scale:1.,source_epoch:1,source_revision:1}).unwrap();
        let request=document.prepare_retained_extrusion(definition,EvaluationContract::RetainedBrep,self.worker.incarnation()).unwrap();
        self.worker.evaluate_retained_extrusion(request,0.001,5.,MeshLimits::default()).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.worker.terminate().unwrap();std::fs::remove_dir_all(&self.directory).unwrap();
    }
}
fn clip(w:&mut SmlibWorker,s:&RetainedRealization) -> Result<ifc_lite_geometry_runtime::RetainedPlaneClip,WorkerError> {
    w.clip_retained_plane(RetainedDependency::Source {realization:s,world_from_source:I},[0.,0.,0.5,0.,0.,1.],
        PlaneSide::Positive,PlaneClipMode::Intersection,0.001,5.,MeshLimits::default())
}
#[test]
fn native_plane_fault_packets_retire_only_captured_owner() {
    let mut replacement=Fixture::new("status7");let other=replacement.source();
    for case in ["short","trailing","input-generation","output-generation","alias","plane","frame","normal","cylinders","empty"] {
        let mut f=Fixture::new(case);let s=f.source();
        assert!(matches!(clip(&mut f.worker,&s),Err(WorkerError::Protocol(_))),"case {case}");
        assert_eq!(f.worker.incarnation(),0);assert!(s.validate_live().is_err());other.validate_live().unwrap();
    }
}
#[test]
fn native_plane_synchronized_refusal_and_taint_have_distinct_lifetimes() {
    for case in ["status7","status8","status9"] {
        let mut f=Fixture::new(case);let s=f.source();
        assert!(matches!(clip(&mut f.worker,&s),Err(WorkerError::Kernel {..})));
        assert_eq!(s.validate_live().is_ok(),case=="status7");
        assert_eq!(f.worker.incarnation()!=0,case=="status7");
    }
}
#[test]
fn native_plane_mesh_refusal_queues_managed_unpublished_output_and_preserves_input() {
    let mut f=Fixture::new("mesh-refusal");let s=f.source();
    assert!(matches!(clip(&mut f.worker,&s),Err(WorkerError::Kernel {status:7,..})));
    s.validate_live().unwrap();f.worker.flush_releases().unwrap();
    // Source slot1, source display mesh2, unpublished clip3. Exact generations
    // are carried by the real release command; neither source nor siblings drop.
    let released=std::fs::read_to_string(f.directory.join("released")).unwrap();
    assert_eq!(released,"2\n3\n");s.validate_live().unwrap();
}

#[test]
fn native_plane_unknown_postclip_status_retires_owner_and_preserves_primary_error() {
    // Independent review of a1bc0a61c7: an unpublished solid lease cannot prove
    // cleanup after an unknown tessellation/query/stream allocation outcome.
    let mut replacement=Fixture::new("replacement");
    let other=replacement.source();
    for opcode in [9,19,11] {
        let mut f=Fixture::new(&format!("postclip-{opcode}-status9"));let s=f.source();
        let owner=s.owner().clone();
        let error=clip(&mut f.worker,&s).unwrap_err();
        let WorkerError::Kernel {status,message}=error else {panic!("lost primary kernel error: {error}")};
        assert_eq!(status,9);
        assert_eq!(message,format!("fixture unknown status9 after clip opcode{opcode}"));
        assert_eq!(f.worker.incarnation(),0);assert!(owner.incarnation().is_none());
        assert!(s.validate_live().is_err());other.validate_live().unwrap();
        let commands=std::fs::read_to_string(f.directory.join("commands")).unwrap();
        let commands:Vec<u32>=commands.lines().map(|v|v.parse().unwrap()).collect();
        let clip_index=commands.iter().position(|&v|v==20).expect("actual clip request to fault peer");
        assert!(commands[clip_index+1..].contains(&opcode));
        // Once unknown status is received, neither queued solid cleanup nor an
        // attempted mesh release may dispatch into the retired domain.
        assert_eq!(commands.last(),Some(&opcode));
        assert!(f.worker.flush_releases().is_err());other.validate_live().unwrap();
    }
}
