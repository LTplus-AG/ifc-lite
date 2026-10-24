// SPDX-License-Identifier: MPL-2.0
// #7955 J1b regression checkpoint. Numerical qualification UNRUN.
#include "ifclite_smlib.h"
#include "affine.hpp"
#include "plane_domain.hpp"
#include "plane_source_domain.hpp"
#include "plane_dyadic.hpp"
#include <SmApiPrimitives.h>
#include <SmBSplineSurface.h>
#include <SmBSplineCurve.h>
#include <SmEdge.h>
#include <SmEdgeuse.h>
#include <SmVertex.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
namespace {
void demand(bool value,const char* message) {
    if(!value) { char error[512]; ifclite_smlib_error_copy(error,sizeof(error));
        std::fprintf(stderr,"plane chain FAIL: %s (%s)\n",message,error); std::exit(1); }
}
void ok(int status) { demand(status==0,"chain operation must succeed"); }
void endpoint_predicate_oracle() {
    using plane_source_proof::linear_value;
    // #7955: the authority is the exact rational polynomial, not the rounded
    // SDK evaluation. 1/3 rounds to binary64 but is not that exact rational.
    demand(linear_value(9,7,11,0,1,.5),"exact interior edge endpoint");
    demand(linear_value(9,11,7,0,1,.5),"reversed exact interior edge endpoint");
    demand(!linear_value(1./3.,0,1,0,3,1),"rounded rational endpoint is not exact");
    demand(!linear_value(std::nextafter(9.,INFINITY),7,11,0,1,.5),
        "one ULP endpoint displacement is not exact");
    demand(linear_value(5000002,5000000,5000004,-1,1,0),"survey exact edge endpoint");
    demand(linear_value(-0.,0,0,-1,1,0),"signed zero exact edge endpoint");
}
void observed_endpoint_oracle() {
    // #7955: actual c9c5979 identity-middle counterexample, source 3c06f525.
    // Non-rational xyz controls (raw w=NL_NOW), NOT homogeneous xyz/w.
    // Both exact residuals are 2^-49. The required parameters are
    // 1/(3*2^50) and 1+1/(3*2^50): neither is binary64, and the latter
    // escapes the complete clamped support. Enlarging an enclosure cannot
    // make this an exactly closed rectangular edge.
    using plane_source_proof::linear_value;
    constexpr double c0=-0x1.4000000000002p+2,c1=0x1.ffffffffffffp-1;
    constexpr double residual=0x1p-49;
    demand(-5-c0==residual && 1-c1==residual,"observed exact endpoint residuals");
    demand(linear_value(c0,c0,c1,0,1,0) && linear_value(c1,c0,c1,0,1,1),
        "observed non-rational controls are Cartesian endpoints");
    demand(!linear_value(-5,c0,c1,0,1,0) && !linear_value(1,c0,c1,0,1,1),
        "observed topology is not the exact curve endpoint");
    const double t0=1./3377699720527872.;
    for(double t:{std::nextafter(t0,0.),t0,std::nextafter(t0,1.)})
        demand(!linear_value(-5,c0,c1,0,1,t),"rounded parameter cannot repair observed start");
    const double t1=1.+t0;
    for(double t:{std::nextafter(t1,0.),t1,std::nextafter(t1,INFINITY)})
        demand(!linear_value(1,c0,c1,0,1,t),"rounded parameter cannot repair observed end");
    demand(c0 < -5 && c1 < 1,"observed end lies outside the full linear image");
}
void displaced_endpoint_oracle(SmFace* face) {
    // Alter owned test topology, never the pinned SDK or a production handle.
    // A one-ULP displacement must still refuse and expose a replayable exact
    // counterexample; an interval that merely contains the vertex is not proof.
    SmTArray<SmEdgeuse*> uses; face->GetUpwardEdgeuses(uses);
    demand(uses.GetSize()==4,"endpoint oracle rectangle uses");
    auto* edge=uses[0]->GetEdge();
    for(auto* vertex:{edge->GetStartVertex(),edge->GetEndVertex()}) {
        const auto saved=vertex->GetPoint(); auto displaced=saved;
        displaced.x=std::nextafter(saved.x,INFINITY); vertex->SetPoint(displaced);
        bool refused=false,diagnosed=false;
        try { plane_source_proof::certify_axis_rectangle(face); }
        catch(const AdapterFailure& e) {
            refused=e.status==IFCLITE_SMLIB_UNSUPPORTED;
            diagnosed=std::strstr(e.message,"endpoint-proof d=0") &&
                std::strstr(e.message," c0=") && std::strstr(e.message," t1=");
        }
        vertex->SetPoint(saved);
        demand(refused && diagnosed,"displaced endpoint refuses with exact counterexample");
        plane_source_proof::certify_axis_rectangle(face);
    }
}
void near(double actual,double expected,double tolerance,const char* message) {
    demand(std::isfinite(actual) && std::abs(actual-expected)<=tolerance,message);
}
double volume(uint64_t s,ifclite_smlib_handle h) {
    double v=0; ok(ifclite_smlib_volume(s,h,1e-8,&v)); return v;
}
template<class T> std::vector<T> read(uint64_t s,ifclite_smlib_handle mesh,unsigned stream,unsigned n) {
    std::vector<T> values(n);
    for(unsigned i=0;i<n;i+=480) { const unsigned count=std::min(480u,n-i);
        ok(ifclite_smlib_mesh_copy(s,mesh,stream,i,count,values.data()+i,count*sizeof(T))); }
    return values;
}
// Independent rectangular-solid oracle: lengths/product, extrema and midpoint.
// Mesh moments use translated tetrahedra, avoiding survey-origin cancellation.
void oracle(uint64_t s,ifclite_smlib_handle h,const std::array<double,6>& box) {
    const double expected=(box[3]-box[0])*(box[4]-box[1])*(box[5]-box[2]);
    near(volume(s,h),expected,std::max(1e-12,expected*2e-5),"analytic volume");
    uint32_t empty=1; ok(ifclite_smlib_is_empty(s,h,&empty)); demand(!empty,"nonempty chain result");
    ifclite_smlib_handle mesh{}; ok(ifclite_smlib_tessellate(s,h,.001,5,&mesh));
    ifclite_smlib_mesh_info info{}; ok(ifclite_smlib_mesh_get_info(s,mesh,&info));
    demand(info.triangle_count && !info.failed_faces && !info.boundary_edges && !info.spine_edges,"closed chain mesh");
    const auto p=read<double>(s,mesh,1,3*info.vertex_count);
    const auto ix=read<uint32_t>(s,mesh,2,3*info.triangle_count);
    std::array<double,3> lo{INFINITY,INFINITY,INFINITY},hi{-INFINITY,-INFINITY,-INFINITY},moment{};
    for(unsigned i=0;i<info.vertex_count;++i) for(unsigned d=0;d<3;++d) {
        lo[d]=std::min(lo[d],p[3*i+d]); hi[d]=std::max(hi[d],p[3*i+d]);
    }
    double total=0;
    for(unsigned i=0;i<info.triangle_count;++i) {
        double q[3][3];
        for(unsigned j=0;j<3;++j) { demand(ix[3*i+j]<info.vertex_count,"bounded triangle index");
            for(unsigned d=0;d<3;++d) q[j][d]=p[3*ix[3*i+j]+d]-box[d]; }
        double det=0;
        for(unsigned d=0;d<3;++d) det+=q[0][d]*(q[1][(d+1)%3]*q[2][(d+2)%3]-q[1][(d+2)%3]*q[2][(d+1)%3]);
        const double v=det/6; total+=v;
        for(unsigned d=0;d<3;++d) moment[d]+=v*(q[0][d]+q[1][d]+q[2][d])/4;
    }
    near(total,expected,expected*2e-3,"positive mesh volume");
    for(unsigned d=0;d<3;++d) {
        near(lo[d],box[d],1e-6,"analytic lower bound");
        near(hi[d],box[3+d],1e-6,"analytic upper bound");
        near(moment[d]/total,(box[3+d]-box[d])/2,1e-6,"analytic centroid");
    }
    ok(ifclite_smlib_release(s,mesh));
}
void proof_oracle() {
    // Exact arithmetic regression for the historical -4.44e-16 identity-UV
    // failure. This tests the interval map; it does not create source authority.
    plane_source_proof::Rectangle map;
    map.u_axis=0; map.v_axis=1; map.normal_axis=2;
    map.u={0,0,1,1}; map.v={0,0,1,1};
    map.controls={0,0,0,1, 0,1,0,1, 1,0,0,1, 1,1,0,1};
    map.bounds={{{0,1},{0,1},{0,0}}};
    const double outside=-std::ldexp(1.,-51);
    const plane_numeric::Bounds tiny{{{outside,outside},{0,1},{0,0}}};
    const auto image=plane_source_proof::affine_image(map,tiny);
    demand(image[0].lo<=outside && image[0].hi>=outside,
        "affine extension bounds both outside endpoints");
    SmBrep* raw=nullptr;
    demand(SmApiCreateBox(SmVector3d(0,0,0),4,6,8,raw)==SM_SUCCESS && raw,"proof source box");
    std::unique_ptr<SmBrep> original(raw);
    const double identity[]={1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};
    ifclite_smlib_affine_certificate certificate{};
    auto source=copy_affine_rational(raw,identity,certificate);
    SmTArray<SmFace*> faces; source->GetFaces(faces);
    demand(faces.GetSize()==6,"proof six actual faces");
    for(auto* face:faces) {
        const auto proof=plane_source_proof::certify_axis_rectangle(face);
        displaced_endpoint_oracle(face);
        // Two independent affine extrapolation endpoints; no SDK evaluation.
        // Exact axis coefficients and dyadic quarter intervals make the oracle
        // independent of production interval subtraction/division.
        plane_numeric::Bounds uv{{{proof.u[0],proof.u[3]}, {proof.v[0],proof.v[3]}, {0,0}}};
        uv[0].lo=proof.u[0]-(proof.u[3]-proof.u[0])/4;
        uv[0].hi=proof.u[3]+(proof.u[3]-proof.u[0])/4;
        const auto bound=plane_source_proof::affine_image(proof,uv);
        const unsigned d=proof.u_axis;
        const double low=std::min(proof.controls[d],proof.controls[8+d]);
        const double high=std::max(proof.controls[d],proof.controls[8+d]);
        demand(bound[d].lo<=low-(high-low)/4 && bound[d].hi>=high+(high-low)/4,
            "affine extension bounds both outside endpoints");
        auto* surface=static_cast<SmBSplineSurface*>(face->GetSurface());
        ULONG nu=0,nv=0; double* controls=nullptr;
        demand(surface->GetControlPointsPointer(nu,nv,controls)==SM_SUCCESS && nu==2 && nv==2,"actual proof net");
        const unsigned index=12+proof.normal_axis;
        const double saved=controls[index]; controls[index]=saved+0.25;
        bool refused=false;
        try { plane_source_proof::certify_axis_rectangle(face); }
        catch(const AdapterFailure& e) { refused=e.status==7; }
        controls[index]=saved;
        demand(refused,"warped rectangle cannot supply missing trim proof");
        const auto before=plane_source_proof::certify_axis_rectangle(face);
        certify_plane_domain(source.get());
        const auto after=plane_source_proof::certify_axis_rectangle(face);
        demand(before.controls==after.controls && before.u==after.u && before.v==after.v,
            "domain inspection preserves source coefficients");
        // Domain-only adversarial metadata invariant, NOT a valid clip fixture:
        // present UV data must enlarge the bound even when it disagrees with
        // the exact 3D rectangle. Never evaluate or clip this fixture.
        SmTArray<SmEdgeuse*> uses; face->GetUpwardEdgeuses(uses);
        demand(uses.GetSize()==4,"actual domain boundary uses");
        auto* trim=new (*source->GetContext()) SmBSplineCurve(
            *static_cast<SmBSplineCurve*>(uses[0]->GetEdge()->GetCurve()));
        ULONG n=0; double* cp=nullptr;
        demand(trim->GetControlPointsPointer(n,cp)==SM_SUCCESS && n==2,"owned domain test trim");
        const double width=proof.u[3]-proof.u[0];
        cp[0]=proof.u[0]-2*width; cp[1]=proof.v[0]; cp[2]=0;
        cp[4]=proof.u[3]+2*width; cp[5]=proof.v[3]; cp[6]=0;
        uses[0]->SetUVTrimCurve(trim,0,TRUE);
        const auto enlarged=certify_plane_domain(source.get());
        demand(enlarged.bounds[d].lo<=low-2*(high-low) &&
            enlarged.bounds[d].hi>=high+2*(high-low),"actual domain includes present UV image");
        face->RemoveUVTrimCurves();
    }
}
void chain(bool survey,bool affine_input,bool affine_middle) {
    uint64_t s=0; ok(ifclite_smlib_session_create(&s));
    ifclite_smlib_handle source{},input{};
    const double ox=survey?5000000:7,oy=survey?-2000000:-5,oz=survey?100:11;
    ok(ifclite_smlib_box(s,0,0,0,4,6,8,&source));
    if(affine_input) {
        const double m[]={2,0,0,0,0,3,0,0,0,0,.5,0,ox,oy,oz,1};
        ifclite_smlib_affine_certificate c{}; ok(ifclite_smlib_copy_affine(s,source,m,&input,&c));
    } else ok(ifclite_smlib_box(s,ox,oy,oz,4,6,8,&input));
    std::array<double,6> box{ox,oy,oz,ox+(affine_input?8:4),oy+(affine_input?18:6),oz+(affine_input?4:8)};
    oracle(s,input,box);
    std::vector<ifclite_smlib_handle> handles{input};
    std::vector<std::array<double,6>> boxes{box};
    for(unsigned cut=0;cut<3;++cut) {
        double plane[6]={0,0,0,0,0,0}; plane[cut]=(box[cut]+box[3+cut])/2; plane[3+cut]=1;
        ifclite_smlib_handle next{}; ifclite_smlib_plane_certificate c{};
        ok(ifclite_smlib_clip_plane(s,handles.back(),plane,1,2,&next,&c));
        demand(c.input.slot==handles.back().slot && c.output.slot==next.slot && !c.empty,"bound live chain handles");
        std::printf("plane chain certificate survey=%d affine=%d middle=%d cut=%u method=%u version=%u\n",
            survey,affine_input,affine_middle,cut,c.method,c.version);
        // Consume the fresh identity copy BEFORE its first volume/mesh query:
        // SDK ComputePreciseProperties -> CreateOrientedTrimBoundary creates
        // missing UV trims, making method2 legitimate after an oracle query.
        if(!survey && !affine_input && affine_middle && cut==1)
            demand((c.method&8)!=0 && c.version==3,"missing-trim chain requires method8/v3");
        box[cut]=plane[cut]; handles.push_back(next); boxes.push_back(box); oracle(s,next,box);
        for(unsigned i=0;i<handles.size();++i) oracle(s,handles[i],boxes[i]);
        if(cut==0 && affine_middle) {
            const double identity[]={1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};
            ifclite_smlib_handle copied{}; ifclite_smlib_affine_certificate a{};
            ok(ifclite_smlib_copy_affine(s,next,identity,&copied,&a));
            // The next iteration checks this copy with every predecessor,
            // after the clip has certified its untouched representation.
            handles.push_back(copied); boxes.push_back(box);
        }
    }
    for(unsigned i=0;i+1<handles.size();++i) ok(ifclite_smlib_release(s,handles[i]));
    // #7955: operation-local domain authority must never survive slot reuse
    // or cross-session replay, even while the final chain result remains live.
    ifclite_smlib_handle replacement{},rejected{}; ifclite_smlib_plane_certificate replay{};
    ok(ifclite_smlib_box(s,0,0,0,1,1,1,&replacement));
    const double plane[]={0,0,0,1,0,0};
    demand(ifclite_smlib_clip_plane(s,handles.front(),plane,1,2,&rejected,&replay)==3 && replay.version==0,
        "released generation cannot replay owned domain");
    uint64_t other=0; ok(ifclite_smlib_session_create(&other));
    demand(ifclite_smlib_clip_plane(other,handles.back(),plane,1,2,&rejected,&replay)==3 && replay.version==0,
        "foreign session cannot replay owned domain");
    ok(ifclite_smlib_session_destroy(other)); ok(ifclite_smlib_release(s,replacement));
    oracle(s,handles.back(),box); near(volume(s,source),192,192*2e-5,"source survives chain releases");
    ok(ifclite_smlib_release(s,source)); oracle(s,handles.back(),box);
    ok(ifclite_smlib_release(s,handles.back())); ok(ifclite_smlib_session_destroy(s));
}
}
int main(int argc,char**) {
    endpoint_predicate_oracle();
    observed_endpoint_oracle();
    proof_oracle();
    if(argc>1) { std::puts("plane chain PASS"); return 0; }
    for(bool survey:{false,true}) for(bool affine:{false,true})
        for(bool middle:{false,true}) chain(survey,affine,middle);
    std::puts("plane chain PASS");
}
