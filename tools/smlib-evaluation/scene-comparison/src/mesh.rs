// SPDX-License-Identifier: MPL-2.0
//! Explicit sidecars for public fields omitted by the production serde wire.
use ifc_lite_processing::{MeshData,InstanceRecord};
use ifc_lite_geometry::InstanceMeta;
use serde::Serialize;

#[derive(Serialize)]
pub struct CompleteMesh<'a> {
    pub presented:&'a MeshData,
    pub geometry_class:u8,
    pub origin:[f64;3],
    pub instance:Option<Instance<'a>>,
    pub local_bounds:Option<[f32;6]>,
    pub local_to_world:Option<[f64;16]>,
}
impl<'a> From<&'a MeshData> for CompleteMesh<'a> {
    fn from(mesh:&'a MeshData)->Self {
        Self {presented:mesh,geometry_class:mesh.geometry_class,origin:mesh.origin,
            instance:mesh.instance.as_ref().map(Instance::from),local_bounds:mesh.local_bounds,
            local_to_world:mesh.local_to_world}
    }
}
#[derive(Serialize)]
pub struct Instance<'a> {
    transform:&'a [f64;16],local_transform:&'a Option<[f64;16]>,
    canonical_transform:&'a Option<[f64;16]>,rep_identity:u128,instanceable:bool,
}
impl<'a> From<&'a InstanceMeta> for Instance<'a> {
    fn from(i:&'a InstanceMeta)->Self {Self {transform:&i.transform,local_transform:&i.local_transform,
        canonical_transform:&i.canonical_transform,rep_identity:i.rep_identity,instanceable:i.instanceable}}
}
#[derive(Serialize)]
pub struct Occurrence<'a> {
    express_id:u32,ifc_type:&'a str,global_id:&'a Option<String>,name:&'a Option<String>,
    presentation_layer:&'a Option<String>,color:[f32;4],template_express_id:u32,
    rep_identity:u128,transform:&'a [f32;16],geometry_item_id:Option<u32>,
}
impl<'a> From<&'a InstanceRecord> for Occurrence<'a> {
    fn from(i:&'a InstanceRecord)->Self {Self {express_id:i.express_id,ifc_type:&i.ifc_type,
        global_id:&i.global_id,name:&i.name,presentation_layer:&i.presentation_layer,color:i.color,
        template_express_id:i.template_express_id,rep_identity:i.rep_identity,transform:&i.transform,
        geometry_item_id:i.geometry_item_id}}
}
