// SPDX-License-Identifier: MPL-2.0
// measure actual returned triangles independently of BRep query results.
#include "ifclite_smlib.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <set>
#include <vector>
namespace {
void require(bool value,const char* message) {
    if (!value) { char error[512]; ifclite_smlib_error_copy(error,sizeof(error));
        std::fprintf(stderr,"mesh FAIL: %s (%s)\n",message,error); std::exit(1); }
}
void ok(int32_t status) { require(status == 0,"C ABI mesh operation"); }
template<class T> std::vector<T> read(uint64_t session,ifclite_smlib_handle mesh,uint32_t stream,uint32_t count) {
    std::vector<T> result(count);
    for (uint32_t offset=0; offset<count;) {
        const uint32_t size=std::min(480u,count-offset);
        ok(ifclite_smlib_mesh_copy(session,mesh,stream,offset,size,result.data()+offset,size*sizeof(T)));
        offset += size;
    }
    return result;
}
void verify(uint64_t session,ifclite_smlib_handle solid,double expected,bool cylinder=false,bool box=false,bool curved=false) {
    double before=0; ok(ifclite_smlib_volume(session,solid,1e-8,&before));
    ifclite_smlib_handle mesh{}; ok(ifclite_smlib_tessellate(session,solid,0.001,5,&mesh));
    ifclite_smlib_mesh_info info{}; ok(ifclite_smlib_mesh_get_info(session,mesh,&info));
    require(info.vertex_count && info.triangle_count && info.source_face_count,"nonempty indexed mesh");
    require(!info.boundary_edges && !info.spine_edges && !info.failed_faces,"strict topology report");
    auto positions=read<double>(session,mesh,1,info.vertex_count*3);
    auto indices=read<uint32_t>(session,mesh,2,info.triangle_count*3);
    auto faces=read<uint32_t>(session,mesh,3,info.triangle_count);
    auto normals=read<double>(session,mesh,4,info.triangle_count*9);
    double after_volume=0; ok(ifclite_smlib_volume(session,solid,1e-8,&after_volume));
    require(std::abs(before-after_volume)<1e-10,"tessellation preserves retained solid volume");
    std::map<std::pair<uint32_t,uint32_t>,std::pair<int,int>> edge_counts;
    std::map<uint32_t,std::pair<unsigned,double>> face_planes;
    std::set<uint32_t> used_faces; double volume=0;
    for (uint32_t tri=0;tri<info.triangle_count;++tri) {
        require(faces[tri]<info.source_face_count,"source face ID in BRep face range");
        used_faces.insert(faces[tri]); std::array<std::array<double,3>,3> p;
        for (unsigned corner=0;corner<3;++corner) {
            uint32_t index=indices[tri*3+corner]; require(index<info.vertex_count,"index in vertex range");
            for (unsigned axis=0;axis<3;++axis) {
                p[corner][axis]=positions[index*3+axis];
                require(std::isfinite(p[corner][axis]),"finite f64 coordinate");
            }
            uint32_t next=indices[tri*3+(corner+1)%3];
            auto& edge=edge_counts[std::minmax(index,next)]; ++edge.first; edge.second += index<next ? 1:-1;
            if (cylinder) {
                const double radius=std::hypot(p[corner][0],p[corner][1]),z=p[corner][2];
                require(std::abs(z)<1e-8 || std::abs(z-3)<1e-8 || std::abs(radius-2)<1e-8,
                    "cylinder vertices on analytic cap or lateral surface");
            }
        }
        std::array<double,3> u,v,n;
        for (unsigned i=0;i<3;++i) { u[i]=p[1][i]-p[0][i]; v[i]=p[2][i]-p[0][i]; }
        n={u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]};
        const double length=std::hypot(n[0],n[1],n[2]); require(length>0,"nondegenerate triangle");
        volume += (p[0][0]*n[0]+p[0][1]*n[1]+p[0][2]*n[2])/6;
        for (unsigned corner=0;corner<3;++corner) for(unsigned axis=0;axis<3;++axis)
            require(std::abs(normals[tri*9+corner*3+axis]-n[axis]/length)<1e-10,"flat normal follows triangle winding");
        if (box) {
            bool on_boundary=false;
            for (unsigned axis=0;axis<3;++axis)
                for (double side : {0.,2.})
                    if (std::abs(p[0][axis]-side)<1e-10 && std::abs(p[1][axis]-side)<1e-10 &&
                        std::abs(p[2][axis]-side)<1e-10) {
                        on_boundary=true;
                        const auto plane=std::make_pair(axis,side);
                        auto inserted=face_planes.emplace(faces[tri],plane);
                        require(inserted.second || inserted.first->second==plane,
                            "one box source face ID maps to one analytic plane");
                    }
            require(on_boundary,"box triangle lies on analytic boundary plane");
        }
    }
    for (auto edge:edge_counts) require(edge.second.first==2 && edge.second.second==0,
        "every triangle edge has two opposite directed incidences");
    require(std::abs(volume-expected)<std::max(1e-7,expected*((cylinder||curved) ? 1e-3:1e-5)),
        "independent signed triangle volume agrees analytic expected volume");
    if (box) require(info.source_face_count==6 && used_faces.size()==6,"all six box source faces attributed");
    uint8_t buffer[8];
    require(ifclite_smlib_mesh_copy(session,mesh,1,UINT32_MAX,1,buffer,sizeof(buffer))==1,"out of bounds copy rejected");
    require(ifclite_smlib_mesh_copy(session,mesh,1,0,481,buffer,sizeof(buffer))==1,"oversized copy rejected");
    require(ifclite_smlib_mesh_copy(session,mesh,1,0,2,buffer,sizeof(buffer))==1,"undersized buffer rejected");
    double value; require(ifclite_smlib_volume(session,mesh,1e-8,&value)==3,"mesh rejected by solid query");
    ok(ifclite_smlib_release(session,solid));
    auto after=read<double>(session,mesh,1,info.vertex_count*3); require(after==positions,"mesh survives source solid release");
    ok(ifclite_smlib_release(session,mesh));
    require(ifclite_smlib_mesh_get_info(session,mesh,&info)==3,"released mesh handle rejected");
}
}
void run_mesh_tests() {
    uint64_t session; ok(ifclite_smlib_session_create(&session));
    ifclite_smlib_handle box,cylinder,a,b,result;
    ok(ifclite_smlib_box(session,0,0,0,2,2,2,&box)); verify(session,box,8,false,true);
    ok(ifclite_smlib_cylinder(session,0,0,0,2,3,&cylinder)); verify(session,cylinder,12*3.14159265358979323846,true);
    ok(ifclite_smlib_box(session,0,0,0,2,2,2,&a));
    ok(ifclite_smlib_box(session,1,0,0,2,2,2,&b));
    ifclite_smlib_handle invalid{};
    require(ifclite_smlib_tessellate(session,a,0,5,&invalid)==1 && invalid.session==0,
        "invalid tessellation controls reject without publishing mesh");
    for (uint32_t op=1;op<=3;++op) {
        ok(ifclite_smlib_boolean(session,a,b,op,&result)); verify(session,result,op==1 ? 12:4);
    }
    // Cap polygons contain a real inner hole, requiring upstream triangulation.
    ifclite_smlib_handle wall,hole;
    ok(ifclite_smlib_box(session,0,0,0,4,4,2,&wall));
    ok(ifclite_smlib_cylinder(session,2,2,-1,0.5,4,&hole));
    ok(ifclite_smlib_boolean(session,wall,hole,3,&result));
    // Curved-hole discretization is approximate, as is cylinder tessellation.
    verify(session,result,32-0.5*3.14159265358979323846,false,false,true);
    ok(ifclite_smlib_boolean(session,a,a,3,&result));
    ifclite_smlib_handle empty; ok(ifclite_smlib_tessellate(session,result,0.001,5,&empty));
    ifclite_smlib_mesh_info info{}; ok(ifclite_smlib_mesh_get_info(session,empty,&info));
    require(info.vertex_count==0 && info.triangle_count==0 && info.source_face_count==0,
        "empty solid tessellates to owned empty mesh");
    ok(ifclite_smlib_session_destroy(session));
}
