// SPDX-License-Identifier: MPL-2.0
// Program invariants: a finite clip preserves its input and local frame,
// binds one real output, and preserves analytical volume and closed topology.
// UNRUN until the parent executes against the pinned SDK.
#include "ifclite_smlib.h"
#include "plane_domain.hpp"
#include "protocol.h"
#include <SmApiPrimitives.h>
#include <SmBSplineSurface.h>
#include <SmCone.h>
#include <SmEdgeuse.h>
#include <SmFace.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <map>
#include <vector>
void run_context_metadata_tests();
void run_plane_preflight_tests();
namespace {
void require(bool value,const char* message) {
    if(!value) { char error[512]; ifclite_smlib_error_copy(error,sizeof(error));
        std::fprintf(stderr,"plane FAIL: %s (%s)\n",message,error); std::exit(1); }
}
void ok(int32_t status) { require(status==0,"successful plane C ABI operation"); }
bool same(ifclite_smlib_handle a,ifclite_smlib_handle b) {
    return a.session==b.session && a.slot==b.slot && a.generation==b.generation;
}
double actual_volume(uint64_t s,ifclite_smlib_handle h) {
    double v=0; ok(ifclite_smlib_volume(s,h,1e-8,&v)); return v;
}
void near(double a,double b) {
    require(std::isfinite(a) && std::abs(a-b)<=std::max(1e-12,std::abs(b)*2e-5),"independent analytic clip volume");
}
template<class T> std::vector<T> read(uint64_t s,ifclite_smlib_handle mesh,unsigned stream,unsigned length) {
    std::vector<T> values(length);
    for(unsigned i=0;i<length;i+=480) {
        const unsigned n=std::min(480u,length-i);
        ok(ifclite_smlib_mesh_copy(s,mesh,stream,i,n,values.data()+i,n*sizeof(T)));
    }
    return values;
}
// An independent tessellated boundary witness, never domain/cutter authority.
void shell(uint64_t s,ifclite_smlib_handle h,const double* plane,int kept,double expected,bool section) {
    ifclite_smlib_handle mesh{}; ok(ifclite_smlib_tessellate(s,h,0.001,5,&mesh));
    ifclite_smlib_mesh_info info{}; ok(ifclite_smlib_mesh_get_info(s,mesh,&info));
    require(info.triangle_count && !info.failed_faces && !info.boundary_edges && !info.spine_edges,
        "actual closed clipped topology tessellates without failed faces");
    const auto p=read<double>(s,mesh,1,3*info.vertex_count);
    const auto indices=read<uint32_t>(s,mesh,2,3*info.triangle_count);
    const auto normals=read<double>(s,mesh,4,9*info.triangle_count);
    std::map<std::pair<unsigned,unsigned>,std::pair<unsigned,int>> edges;
    double signed_volume=0,section_integral=0;
    const std::array<double,3> reference{p[0],p[1],p[2]};
    for(unsigned i=0;i<info.triangle_count;++i) {
        double q[3][3];
        for(unsigned j=0;j<3;++j) {
            const auto index=indices[3*i+j]; require(index<info.vertex_count,"bounded triangle index");
            double distance=0;
            for(unsigned d=0;d<3;++d) {
                q[j][d]=p[3*index+d]; distance+=plane[3+d]*(q[j][d]-plane[d]);
            }
            require(kept*distance>=-1e-6,"actual output boundary on requested side");
            const auto next=indices[3*i+(j+1)%3]; auto& edge=edges[std::minmax(index,next)];
            ++edge.first; edge.second+=index<next?1:-1;
        }
        double a[3],b[3],cross[3];
        for(unsigned d=0;d<3;++d) { a[d]=q[1][d]-q[0][d]; b[d]=q[2][d]-q[0][d]; }
        for(unsigned d=0;d<3;++d) cross[d]=a[(d+1)%3]*b[(d+2)%3]-a[(d+2)%3]*b[(d+1)%3];
        double orientation=0; for(unsigned d=0;d<3;++d) orientation+=cross[d]*normals[9*i+d];
        require(orientation>0,"triangle orientation agrees with outward SDK normals");
        double t[3][3]; for(unsigned j=0;j<3;++j) for(unsigned d=0;d<3;++d) t[j][d]=q[j][d]-reference[d];
        signed_volume+=(t[0][0]*(t[1][1]*t[2][2]-t[1][2]*t[2][1])+
            t[0][1]*(t[1][2]*t[2][0]-t[1][0]*t[2][2])+t[0][2]*(t[1][0]*t[2][1]-t[1][1]*t[2][0]))/6;
        // Oriented section at z=1: area = integral x dy. Each intersected
        // triangle contributes its boundary segment; cap closure is included.
        if(section) {
            std::vector<std::array<double,2>> hits;
            for(unsigned j=0;j<3;++j) {
                const unsigned k=(j+1)%3;
                if((q[j][2]<1 && q[k][2]>1) || (q[j][2]>1 && q[k][2]<1)) {
                    const double u=(1-q[j][2])/(q[k][2]-q[j][2]);
                    hits.push_back({q[j][0]+u*(q[k][0]-q[j][0]),q[j][1]+u*(q[k][1]-q[j][1])});
                }
            }
            if(hits.size()==2) {
                // Tangent direction zAxis cross outwardNormal.
                if((hits[1][0]-hits[0][0])*(-cross[1])+(hits[1][1]-hits[0][1])*cross[0]<0)
                    std::swap(hits[0],hits[1]);
                section_integral+=(hits[0][0]+hits[1][0])*(hits[1][1]-hits[0][1])/2;
            }
        }
    }
    for(const auto& entry:edges) require(entry.second.first==2 && entry.second.second==0,"watertight oppositely directed edge incidence");
    require(std::abs(signed_volume-expected)<=std::abs(expected)*2e-3,"closed mesh volume within chord approximation"); if(section) near(section_integral,3);
    ok(ifclite_smlib_release(s,mesh));
}
void clip_case(uint64_t s,ifclite_smlib_handle input,const std::array<double,6>& p,
    int side,unsigned mode,double expected,double original,bool section=false) {
    ifclite_smlib_handle out{}; ifclite_smlib_plane_certificate c{};
    ok(ifclite_smlib_clip_plane(s,input,p.data(),side,mode,&out,&c));
    require(c.version==1 && (expected==0 || c.method!=0) && c.frame==1 && same(c.input,input) && same(c.output,out) &&
        !same(input,out) && c.side==side && c.mode==mode,"actual ordered input/output and side/mode certificate");
    require(std::memcmp(p.data(),c.plane,sizeof(c.plane))==0,"original six plane coefficients preserved byte-for-byte");
    uint32_t empty=2; ok(ifclite_smlib_is_empty(s,out,&empty));
    require(empty==c.empty && empty==(expected==0?1u:0u),"canonical actual Empty classification");
    near(actual_volume(s,input),original); near(actual_volume(s,out),expected);
    if(expected>0) {
        uint32_t manifold=0; ok(ifclite_smlib_manifold(s,out,&manifold)); require(manifold==1,"nonempty manifold output");
        if(original>=1 && original<=1000) shell(s,out,p.data(),mode==3?-side:side,expected,section);
    }
    ok(ifclite_smlib_release(s,out)); near(actual_volume(s,input),original);
}
void protocol_witness(uint64_t s,ifclite_smlib_handle input) {
    std::vector<uint8_t> packet;
    auto u32=[&](uint32_t n) { for(unsigned i=0;i<4;++i) packet.push_back(uint8_t(n>>(8*i))); };
    auto u64=[&](uint64_t n) { u32(uint32_t(n)); u32(uint32_t(n>>32)); };
    u32(1); u32(731); u32(20); u64(s); u64(input.session); u32(input.slot); u32(input.generation);
    for(double value:{0.5,0.,0.,1.,0.,0.}) { uint64_t bits; std::memcpy(&bits,&value,8); u64(bits); }
    u32(1); u32(2); require(packet.size()==92,"bounded unary request packet");
    const auto response=ifclite_smlib_dispatch(packet);
    auto read32=[&](unsigned offset) { uint32_t n=0;
        require(offset+4<=response.size(),"bounded response read");
        for(unsigned i=0;i<4;++i) n|=uint32_t(response[offset+i])<<(8*i);
        return n; };
    require(response.size()==324 && read32(0)==1 && read32(4)==731 && read32(8)==0,
        "actual opcode20 fixed certificate packet without cylinder records");
    ifclite_smlib_handle out{uint64_t(read32(12))|(uint64_t(read32(16))<<32),read32(20),read32(24)};
    near(actual_volume(s,out),6); ok(ifclite_smlib_release(s,out));
    packet.push_back(0); bool malformed=false;
    try { ifclite_smlib_dispatch(packet); } catch(const std::exception&) { malformed=true; }
    require(malformed,"trailing fields rejected before numerical work"); near(actual_volume(s,input),8);
}
void cylinder_domains() {
    SmBrep* raw=nullptr; require(SmApiCreateCylinder(SmVector3d(-4,7,-5),2,3,raw)==SM_SUCCESS,"actual bounded cylinder domain fixture");
    std::unique_ptr<SmBrep> source(raw); SmTArray<SmFace*> faces; raw->GetFaces(faces);
    unsigned reached=0,endpoints=0,swaps=0;
    for(auto* face:faces) {
        const auto type=face->GetSurface()->GetType();
        if(type!=SmCylinder_TYPE && type!=SmCone_TYPE) continue;
        auto* cylinder=static_cast<SmCone*>(face->GetSurface());
        SmAxis2Placement frame; double radius=0,angle=0;
        require(cylinder->GetCanonical(frame,radius,angle)==SM_SUCCESS && angle==0 && radius==2,
            "actual BRep cylinder has exactly zero canonical cone angle");
        ++reached;
        for(unsigned swapped=0;swapped<2;++swapped) {
            const auto domain=certify_plane_domain(raw);
            require(domain.cylinder_count==1 && (domain.methods&4),"separate analytic cylinder method and actual coefficient record");
            const auto& record=domain.cylinders[0];
            require(record.radius==2 && record.origin[2]==-5 && record.step_v[0]==0 && record.step_v[1]==3,
                "actual cylinder origin/radius/bounded axial endpoints");
            const auto uv=cylinder->GetNaturalUVDomain();
            for(double u:{uv.GetUMin(),uv.GetUMax()}) for(double v:{uv.GetVMin(),uv.GetVMax()}) {
                SmPoint3d actual; require(cylinder->EvaluatePoint(SmPoint2d(u,v),actual)==SM_SUCCESS,"actual converted cylinder endpoint evaluation");
                for(unsigned d=0;d<3;++d) require(actual[d]>=domain.bounds[d].lo && actual[d]<=domain.bounds[d].hi,
                    "analytic enclosure covers actual UV-converted endpoints");
                ++endpoints;
            }
            if(!swapped) {
                const auto before=record.swap_uv;
                require(face->SwapUV()==SM_SUCCESS,"actual cylinder UV swap");
                const auto after=certify_plane_domain(raw);
                require(after.cylinders[0].swap_uv!=before,"certificate records actual changed UV conversion flag");
                ++swaps;
            }
        }
        cylinder->SetOutOfBoundsEnabled(TRUE); bool refused=false;
        try { certify_plane_domain(raw); } catch(const SweepFailure& e) { refused=e.status==7; }
        require(refused,"analytic cylinder extrapolation explicitly refuses"); cylinder->SetOutOfBoundsEnabled(FALSE);
    }
    require(reached==1 && endpoints==8 && swaps==1,
        "actual cylindrical side, both UV endpoint passes and swap comparison all executed");
    // A real unequal-radius cone shares the dynamic SDK class but not the
    // constant-radius formula. It must never receive method4 admission.
    SmBrep* tapered_raw=nullptr;
    require(SmApiCreateCone(SmVector3d(-4,7,-5),2,1,3,tapered_raw)==SM_SUCCESS && tapered_raw,
        "actual nonzero-angle cone fixture");
    std::unique_ptr<SmBrep> tapered(tapered_raw); tapered->GetFaces(faces);
    unsigned nonzero=0;
    for(auto* face:faces) if(face->GetSurface()->GetType()==SmCone_TYPE) {
        SmAxis2Placement frame; double radius=0,angle=0;
        require(static_cast<SmCone*>(face->GetSurface())->GetCanonical(frame,radius,angle)==SM_SUCCESS,
            "read actual tapered cone coefficients");
        if(std::isfinite(angle) && angle!=0) ++nonzero;
    }
    require(nonzero==1,"negative fixture reaches a real nonzero-angle cone");
    bool refused=false;
    try { certify_plane_domain(tapered.get()); } catch(const SweepFailure& e) { refused=e.status==7; }
    require(refused,"nonzero-angle cone remains outside method4 finite cylinder proof");
}
void control_net_interior() {
    // Domain invariant: a curved face interior can exceed every vertex/edge
    // bound. Elevate a real box's top patch, keep its boundary fixed, bulge only
    // its central control point. This is a full SDK BRep, not a mesh fixture.
    SmBrep* raw=nullptr; require(SmApiCreateBox(SmVector3d(0,0,0),2,2,2,raw)==SM_SUCCESS,"SDK rational interior fixture");
    std::unique_ptr<SmBrep> source(raw);
    SmTArray<SmFace*> faces; raw->GetFaces(faces); SmFace* edited=nullptr;
    for(auto* f:faces) {
        auto* b=static_cast<SmBSplineSurface*>(f->GetSurface());
        SmPoint3d midpoint; const auto uv=f->GetUVDomain();
        require(b->EvaluatePoint(SmPoint2d(uv.GetUMid(),uv.GetVMid()),midpoint)==SM_SUCCESS,"actual top patch midpoint");
        if(midpoint.z!=2) continue;
        SmTArray<SmEdgeuse*> uses; f->GetUpwardEdgeuses(uses);
        std::vector<std::pair<SmEdgeuse*,std::unique_ptr<SmBSplineCurve>>> trims;
        for(auto* use:uses) {
            SmEdgeuse* owner=nullptr; auto* trim=use->GetUVTrimCurve(&owner);
            require(trim && owner,"existing exact top patch trim");
            trims.emplace_back(owner,std::unique_ptr<SmBSplineCurve>(new (*raw->GetContext()) SmBSplineCurve(*trim)));
        }
        auto* replacement=new (*raw->GetContext()) SmBSplineSurface(*b);
        require(replacement->DegreeElevate(SM_SP_U,2)==SM_SUCCESS && replacement->DegreeElevate(SM_SP_V,2)==SM_SUCCESS,"exact degree elevation");
        SmPoint3d point; double weight=0;
        require(replacement->GetControlPoint(SM_CP_EUCLIDIAN_RATIONAL,1,1,point,weight)==SM_SUCCESS,"real interior control");
        point.z=6;
        require(replacement->SetControlPoint(SM_CP_EUCLIDIAN_RATIONAL,1,1,point,1)==SM_SUCCESS,"author rational bulge");
        f->SetSurface(replacement,TRUE);
        // SetSurface invalidates UV caches. Restore the actual original exact
        // boundary curves, whose geometry is unchanged by an interior bulge.
        for(auto& trim:trims) trim.first->SetUVTrimCurve(trim.second.release(),0,TRUE);
        edited=f; break;
    }
    require(edited,"top patch reached");
    const auto c=certify_plane_domain(raw);
    require(c.bounds[2].hi>=6 && c.faces==6,"complete surface control net encloses interior beyond vertex maximum2");
    const auto previous=edited->GetUVDomain(); edited->SetUVDomain(SmExtent2d(-1,-1,3,3));
    bool cropped=false;
    try { certify_plane_domain(raw); } catch(const SweepFailure& e) { cropped=e.status==7; }
    require(cropped,"cropped or unknown generic face domain cannot borrow full-patch certification");
    edited->SetUVDomain(previous); edited->RemoveUVTrimCurves();
    bool missing=false;
    try { certify_plane_domain(raw); } catch(const SweepFailure& e) { missing=e.status==7; }
    require(missing,"missing generic UV containment cannot be replaced by disabled-extrapolation flag");
}
}
void run_plane_tests() {
    run_context_metadata_tests();
    run_plane_preflight_tests();
    require((ifclite_smlib_capabilities()&64u)!=0 && (ifclite_smlib_capabilities()&128u)==0,"unary clip only, no paired split advertisement");
    uint64_t s=0; ok(ifclite_smlib_session_create(&s));
    ifclite_smlib_handle box{}; ok(ifclite_smlib_box(s,0,0,0,2,2,2,&box));
    {
        ifclite_smlib_handle out{}; ifclite_smlib_plane_certificate c{};
        const double valid[]={0.5,0,0,1,0,0},zero[]={0,0,0,0,0,0};
        require(ifclite_smlib_clip_plane(s,box,valid,0,2,&out,&c)==1 && !out.session && !c.version,
            "invalid side refuses without publication");
        require(ifclite_smlib_clip_plane(s,box,valid,1,1,&out,&c)==7 && !out.session && !c.version,
            "unbounded Union cannot become bounded host clipping");
        require(ifclite_smlib_clip_plane(s,box,zero,1,2,&out,&c)==1 && !out.session,
            "zero normal refuses before geometry work");
        require(ifclite_smlib_clip_plane(s,box,nullptr,1,2,&out,&c)==1 && !out.session,
            "null plane refuses before geometry work");
        require(ifclite_smlib_clip_plane(s,box,valid,1,2,&out,nullptr)==1 && !out.session,
            "no output without owned certificate storage");
        uint64_t other=0; ok(ifclite_smlib_session_create(&other));
        require(ifclite_smlib_clip_plane(other,box,valid,1,2,&out,&c)==3 && !out.session,
            "foreign input cannot issue a certified clip");
        ok(ifclite_smlib_session_destroy(other)); near(actual_volume(s,box),8);
    }
    protocol_witness(s,box);
    for(int side:{1,-1}) for(unsigned mode:{2u,3u}) {
        clip_case(s,box,{0.5,0,0,2,0,0},side,mode,(side==1)==(mode==2)?6:2,8,side==1 && mode==2);
        clip_case(s,box,{1,1,1,1,1,1},side,mode,4,8);
        clip_case(s,box,{3,0,0,1,0,0},side,mode,(side==1)==(mode==2)?0:8,8);
        clip_case(s,box,{0,0,0,1,0,0},side,mode,(side==1)==(mode==2)?8:0,8);
        clip_case(s,box,{2,0,0,1,0,0},side,mode,(side==1)==(mode==2)?0:8,8);
    }
    ifclite_smlib_handle empty{}; ok(ifclite_smlib_boolean(s,box,box,3,&empty));
    clip_case(s,empty,{0,0,0,0,1,0},1,2,0,0);
    ok(ifclite_smlib_release(s,empty));
    ifclite_smlib_handle cylinder{},rational{};
    ok(ifclite_smlib_cylinder(s,0,0,0,2,3,&cylinder));
    ifclite_smlib_handle refused{}; ifclite_smlib_plane_certificate refused_cert{};
    const double plane[]={0,0,1.5,0,0,1};
    clip_case(s,cylinder,{0,0,1.5,0,0,1},1,2,6*std::acos(-1.),12*std::acos(-1.));
    clip_case(s,cylinder,{0,0,1.5,1,0,1},1,2,6*std::acos(-1.),12*std::acos(-1.));
    const double identity[]={1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1}; ifclite_smlib_affine_certificate affine{};
    ok(ifclite_smlib_copy_affine(s,cylinder,identity,&rational,&affine));
    // Known preservation gap: TurnToNURBS/SetCurve deletes UV trims. The
    // generic point evaluator does not clamp even with extrapolation disabled.
    require(ifclite_smlib_clip_plane(s,rational,plane,1,2,&refused,&refused_cert)==7 &&
        !refused.session && !refused_cert.version,"rational copy without true UV containment remains refused, not qualified");
    ifclite_smlib_handle survivor{}; ifclite_smlib_plane_certificate c{};
    ok(ifclite_smlib_clip_plane(s,box,plane,1,2,&survivor,&c));
    ok(ifclite_smlib_release(s,box)); near(actual_volume(s,survivor),2);
    require(ifclite_smlib_clip_plane(s,box,plane,1,2,&refused,&refused_cert)==3 && !refused.session,
        "released input generation cannot issue clip");
    ok(ifclite_smlib_release(s,survivor));
    for(double scale:{0.01,1000.}) {
        ifclite_smlib_handle scaled{}; ok(ifclite_smlib_box(s,0,0,0,2*scale,2*scale,2*scale,&scaled));
        clip_case(s,scaled,{0.5*scale,0,0,1,0,0},1,2,6*scale*scale*scale,8*scale*scale*scale);
        ok(ifclite_smlib_release(s,scaled));
    }
    // Reflected, nonuniform source in a survey coordinate frame.
    const double transform[]={-2,0,0,0,0,3,0,0,0,0,4,0,5000000,-2000000,100,1};
    ifclite_smlib_handle local{},survey{}; ok(ifclite_smlib_box(s,0,0,0,2,2,2,&local));
    ok(ifclite_smlib_copy_affine(s,local,transform,&survey,&affine));
    const double survey_plane[]={4999999,-2000000,100,-0.5,0,0};
    require(ifclite_smlib_clip_plane(s,survey,survey_plane,1,2,&refused,&refused_cert)==7 && !refused.session,
        "reflected affine trim loss remains an explicit uncovered preservation class");
    near(actual_volume(s,survey),192);
    ifclite_smlib_handle placed{}; ok(ifclite_smlib_box(s,4999996,-2000000,100,4,6,8,&placed));
    clip_case(s,placed,{4999999,-2000000,100,-0.5,0,0},1,2,144,192);
    // Input release must not affect a previous independently owned output.
    ok(ifclite_smlib_session_destroy(s));
    control_net_interior();
    cylinder_domains();
    std::puts("SMLib unary clip: analytical side/volume, actual domain, topology and lifetime witnesses passed");
}
