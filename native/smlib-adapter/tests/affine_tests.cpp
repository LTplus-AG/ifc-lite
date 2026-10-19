// SPDX-License-Identifier: MPL-2.0
// Independent affine oracles fixed before execution; no test below has yet
// qualified this source. Reuses actual C ABI BReps, never mock SDK geometry.
#include "ifclite_smlib.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <map>
#include <vector>
namespace {
void require(bool x,const char* message) {
    if(!x) { char error[512]; ifclite_smlib_error_copy(error,sizeof(error));
        std::fprintf(stderr,"affine FAIL: %s (%s)\n",message,error); std::exit(1); }
}
void ok(int32_t status) { require(status==0,"C ABI affine operation"); }
using V=std::array<double,3>;
using M=std::array<double,16>;
V cross(V a,V b) { return {a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]}; }
double dot(V a,V b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
V sub(V a,V b) { return {a[0]-b[0],a[1]-b[1],a[2]-b[2]}; }
// Inverse of the authored matrix, independently of SDK decomposition.
V inverse(const M& m,V p) {
    V a{m[0],m[1],m[2]},b{m[4],m[5],m[6]},c{m[8],m[9],m[10]};
    auto q=sub(p,{m[12],m[13],m[14]}); const double d=dot(a,cross(b,c));
    return {dot(q,cross(b,c))/d,dot(q,cross(c,a))/d,dot(q,cross(a,b))/d};
}
V normal(const M& m,V n) {
    V a{m[0],m[1],m[2]},b{m[4],m[5],m[6]},c{m[8],m[9],m[10]};
    auto x=cross(b,c),y=cross(c,a),z=cross(a,b); const double d=dot(a,x);
    V out{}; for(unsigned i=0;i<3;++i) out[i]=(x[i]*n[0]+y[i]*n[1]+z[i]*n[2])/d;
    return out;
}
template<class T> std::vector<T> read(uint64_t s,ifclite_smlib_handle h,unsigned stream,unsigned n) {
    std::vector<T> out(n);
    for(unsigned i=0;i<n;i+=480) { const unsigned size=std::min(480u,n-i);
        ok(ifclite_smlib_mesh_copy(s,h,stream,i,size,out.data()+i,size*sizeof(T))); }
    return out;
}
void witness(const M& m,bool cylinder) {
    uint64_t session=0; ok(ifclite_smlib_session_create(&session));
    ifclite_smlib_handle source{},copy{}; ifclite_smlib_affine_certificate cert{};
    if(cylinder) ok(ifclite_smlib_cylinder(session,0,0,0,2,3,&source));
    else ok(ifclite_smlib_box(session,0,0,0,2,2,3,&source));
    const double original=cylinder?12*std::acos(-1.):12;
    ok(ifclite_smlib_copy_affine(session,source,m.data(),&copy,&cert));
    require(cert.version==1 && cert.representation==1,"rational conversion certificate");
    require(copy.slot!=source.slot || copy.generation!=source.generation,"independent copy identity");
    require(cylinder?cert.source_classes[8]>0:cert.source_classes[7]==6,"actual source class conversion witnesses");
    double unchanged=0; ok(ifclite_smlib_volume(session,source,1e-8,&unchanged));
    require(std::abs(unchanged-original)<=original*1e-5,"source unchanged by affine copy");
    ok(ifclite_smlib_release(session,source)); // Copy must survive original release.
    V a{m[0],m[1],m[2]},b{m[4],m[5],m[6]},c{m[8],m[9],m[10]};
    const double expected=original*std::abs(dot(a,cross(b,c)));
    double volume=0; ok(ifclite_smlib_volume(session,copy,1e-8,&volume));
    require(volume>0 && std::abs(volume-expected)<=expected*1e-5,"positive analytic volume under signed determinant");
    ifclite_smlib_handle mesh{}; ok(ifclite_smlib_tessellate(session,copy,0.001,5,&mesh));
    ifclite_smlib_mesh_info info{}; ok(ifclite_smlib_mesh_get_info(session,mesh,&info));
    require(info.vertex_count && info.triangle_count && !info.failed_faces && !info.boundary_edges && !info.spine_edges,
        "closed affine mesh");
    auto points=read<double>(session,mesh,1,3*info.vertex_count);
    auto indices=read<uint32_t>(session,mesh,2,3*info.triangle_count);
    auto normals=read<double>(session,mesh,4,9*info.triangle_count);
    std::map<std::pair<unsigned,unsigned>,std::pair<unsigned,int>> edges;
    double signed_volume=0;
    const V reference{m[12],m[13],m[14]};
    for(unsigned i=0;i<info.triangle_count;++i) {
        V p[3],local[3];
        for(unsigned j=0;j<3;++j) {
            const unsigned index=indices[3*i+j]; require(index<info.vertex_count,"bounded affine index");
            for(unsigned k=0;k<3;++k) p[j][k]=points[3*index+k];
            local[j]=inverse(m,p[j]);
            const unsigned next=indices[3*i+(j+1)%3]; auto& edge=edges[std::minmax(index,next)];
            ++edge.first; edge.second+=index<next?1:-1;
        }
        auto n=cross(sub(p[1],p[0]),sub(p[2],p[0]));
        const double length=std::sqrt(dot(n,n)); require(length>0,"nondegenerate affine triangle");
        signed_volume+=dot(sub(p[0],reference),cross(sub(p[1],reference),sub(p[2],reference)))/6;
        V outward{}; bool boundary=false;
        // Identify the source analytic boundary using all triangle vertices.
        for(unsigned axis=0;axis<3;++axis) for(double side:{0.,axis==2?3.:2.}) {
            if(cylinder && axis!=2) continue;
            if(std::all_of(local,local+3,[&](V q){return std::abs(q[axis]-side)<1e-7;})) {
                outward[axis]=side==0?-1.:1.; boundary=true;
            }
        }
        if(cylinder && !boundary) {
            for(auto q:local) require(std::abs(q[0]*q[0]+q[1]*q[1]-4)<1e-6,"rational elliptical cylinder section");
            outward={local[0][0]+local[1][0]+local[2][0],local[0][1]+local[1][1]+local[2][1],0}; boundary=true;
        }
        require(boundary,"transformed vertices lie on authored analytic boundary");
        auto expected_normal=normal(m,outward);
        require(dot(n,expected_normal)>0,"winding outward against independent inverse-transpose analytic normal");
        for(unsigned corner=0;corner<3;++corner) for(unsigned k=0;k<3;++k)
            require(std::abs(normals[9*i+3*corner+k]-n[k]/length)<1e-10,"exported normal agrees oriented triangle");
    }
    require(std::abs(signed_volume-expected)<=expected*(cylinder?1e-3:1e-5),"independent positive signed triangle volume");
    for(auto e:edges) require(e.second.first==2 && e.second.second==0,"two opposed edge incidences after reflection");
    ok(ifclite_smlib_release(session,copy)); ok(ifclite_smlib_release(session,mesh));
    ok(ifclite_smlib_session_destroy(session));
}
}
void run_affine_tests() {
    // Fixed before execution: positive uniform, negative uniform, nonuniform,
    // shear with distinct Z, reflected shear. Both box and rational cylinder.
    for(M m: { M{2,0,0,0,0,2,0,0,0,0,2,0,7,-4,2,1},
        M{-2,0,0,0,0,-2,0,0,0,0,-2,0,7,-4,2,1},
        M{2,0,0,0,0,3,0,0,0,0,4,0,7,-4,2,1},
        M{2,0,0,0,0.4,3,0,0,0.2,0.3,4,0,7,-4,2,1},
        M{-2,0,0,0,0.4,3,0,0,0.2,0.3,4,0,7,-4,2,1} }) {
        witness(m,false); witness(m,true);
    }
    uint64_t session=0; ok(ifclite_smlib_session_create(&session));
    ifclite_smlib_handle source{},out{}; ok(ifclite_smlib_box(session,0,0,0,2,2,3,&source));
    ifclite_smlib_affine_certificate cert{};
    M m{1,0,0,0,0,1,0,0,0,0,0,0,0,0,0,1};
    require(ifclite_smlib_copy_affine(session,source,m.data(),&out,&cert)==1 && !out.session && !cert.version,"singular typed refusal without publication");
    m[10]=1; m[0]=std::numeric_limits<double>::infinity();
    require(ifclite_smlib_copy_affine(session,source,m.data(),&out,&cert)==1 && !out.session,"nonfinite typed refusal");
    m[0]=1; m[10]=1e-7;
    require(ifclite_smlib_copy_affine(session,source,m.data(),&out,&cert)==7 && !out.session,"numerical envelope refusal");
    double volume=0; ok(ifclite_smlib_volume(session,source,1e-8,&volume));
    require(std::abs(volume-12)<1e-6,"failed copies preserve source");
    ok(ifclite_smlib_session_destroy(session));
}
