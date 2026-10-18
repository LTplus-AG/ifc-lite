// SPDX-License-Identifier: MPL-2.0
use crate::{mesh::CompleteMesh,records::Records};
use ifc_lite_processing::{ProcessingSink,FrameEvent,MeshData,QuickMetadataBootstrap};
use serde::Serialize;

#[derive(Serialize)]
pub struct Frame {
    kind:&'static str,placement:Option<[f64;16]>,anchor:Option<[f64;3]>,
}
impl From<ifc_lite_processing::MeshFrame> for Frame {
    fn from(frame:ifc_lite_processing::MeshFrame)->Self {
        use ifc_lite_processing::MeshFrame::*;
        match frame {
            SiteLocal {placement}=>Self {kind:"site_local",placement:Some(placement),anchor:None},
            ModelRtc {anchor:(x,y,z)}=>Self {kind:"model_rtc",placement:None,anchor:Some([x,y,z])},
            RawIfc=>Self {kind:"raw_ifc",placement:None,anchor:None},
        }
    }
}
pub struct Sink<'a> {pub records:&'a mut Records,pub sequence:usize,pub color_updates:usize}
impl ProcessingSink for Sink<'_> {
    fn on_bootstrap(&mut self,b:&QuickMetadataBootstrap) {
        self.records.emit("event.bootstrap",self.sequence,b);self.sequence+=1;
    }
    fn on_frame(&mut self,f:&FrameEvent) {
        self.records.emit("event.frame",self.sequence,&(Frame::from(f.frame),f.baked_basis));self.sequence+=1;
    }
    fn on_batch(&mut self,meshes:&[MeshData],processed:usize,total:usize) {
        self.records.emit("event.batch",self.sequence,&(processed,total,meshes.len()));
        for (index,mesh) in meshes.iter().enumerate() {
            self.records.emit("event.mesh",format!("{}:{index}",self.sequence),&CompleteMesh::from(mesh));
        }
        self.sequence+=1;
    }
    fn on_color_update(&mut self,updates:&[(u32,[f32;4])]) {
        self.color_updates+=updates.len();
        self.records.emit("event.colors",self.sequence,updates);self.sequence+=1;
    }
}
