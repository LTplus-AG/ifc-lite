// SPDX-License-Identifier: MPL-2.0
// SDK-gated source proof qualification. All numerical witnesses UNRUN here.
#include "affine.hpp"
#include "context_metadata.hpp"
#include "plane.hpp"
#include "plane_domain.hpp"
#include "plane_dyadic.hpp"
#include <SmApiGeneral.h>
#include <SmApiBrep.h>
#include <SmApiQueries.h>
#include <SmVertex.h>
#include <SmApiPrimitives.h>
#include <SmBSplineSurface.h>
#include <SmBSplineCurve.h>
#include <SmEdge.h>
#include <SmEdgeuse.h>
#include <SmLoop.h>
#include <SmLoopuse.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
namespace {
void demand(bool value,const char* message) {
    if(!value) { std::fprintf(stderr,"affine source proof FAIL: %s\n",message); std::exit(1); }
}
template<class F> void refuses(F&& f,const char* message) {
    bool refused=false;
    try { f(); } catch(const SweepFailure& e) { refused=e.status==IFCLITE_SMLIB_UNSUPPORTED; }
    demand(refused,message);
}
std::unique_ptr<SmBrep> box(double x=0,double y=0,double z=0) {
    SmBrep* raw=nullptr;
    demand(SmApiCreateBox(SmVector3d(x,y,z),2,2,2,raw)==SM_SUCCESS && raw,"actual SDK box fixture");
    return std::unique_ptr<SmBrep>(raw);
}
void replace_planes(SmBrep& source,bool keep_trims=false) {
    SmTArray<SmFace*> faces; source.GetFaces(faces);
    for(auto* f:faces) {
        auto* b=static_cast<SmBSplineSurface*>(f->GetSurface());
        demand(b->GetGwNurbPointer()!=nullptr,"actual source materialized before replacement");
        SmTArray<SmEdgeuse*> uses; f->GetUpwardEdgeuses(uses);
        std::vector<std::pair<SmEdgeuse*,std::unique_ptr<SmBSplineCurve>>> trims;
        if(keep_trims) for(auto* use:uses) {
            SmEdgeuse* owner=nullptr; auto* trim=use->GetUVTrimCurve(&owner);
            demand(trim && owner,"actual authored trim retained by fixture");
            trims.emplace_back(owner,std::unique_ptr<SmBSplineCurve>(new (*source.GetContext()) SmBSplineCurve(*trim)));
        }
        f->SetSurface(new (*source.GetContext()) SmBSplineSurface(*b),TRUE);
        f->RemoveUVTrimCurves();
        for(auto& trim:trims) trim.first->SetUVTrimCurve(trim.second.release(),0,TRUE);
    }
}
struct Snapshot {
    std::vector<double> coefficients;
    std::vector<const void*> pointers;
    raw_context::Metadata source,context;
    explicit Snapshot(SmBrep& s):source(raw_context::Access<SmBrep>::get(s)),
        context(raw_context::Access<SmContext>::get(*const_cast<SmContext*>(s.GetContext()))) {
        SmTArray<SmFace*> faces; s.GetFaces(faces);
        for(auto* f:faces) {
            auto* b=static_cast<SmBSplineSurface*>(f->GetSurface()); pointers.push_back(b); pointers.push_back(b->GetGwNurbPointer());
            ULONG nu=0,nv=0,ku=0,kv=0; double *p=nullptr,*u=nullptr,*v=nullptr;
            demand(b->GetControlPointsPointer(nu,nv,p)==SM_SUCCESS && b->GetKnotsPointers(ku,kv,u,v)==SM_SUCCESS,"snapshot materialized source surface");
            coefficients.insert(coefficients.end(),p,p+4*size_t(nu)*nv);
            coefficients.insert(coefficients.end(),u,u+ku); coefficients.insert(coefficients.end(),v,v+kv);
        }
        SmTArray<SmEdge*> edges; s.GetEdges(edges);
        for(auto* e:edges) {
            auto* c=static_cast<SmBSplineCurve*>(e->GetCurve()); pointers.push_back(c); pointers.push_back(c->GetGwNurbPointer());
            ULONG n=0; double* p=nullptr; demand(c->GetControlPointsPointer(n,p)==SM_SUCCESS,"snapshot existing edge");
            coefficients.insert(coefficients.end(),p,p+4*n);
            SmTArray<double> k; demand(c->GetKnotsAll(k)==SM_SUCCESS,"snapshot edge knots");
            coefficients.insert(coefficients.end(),k.GetDataArray(),k.GetDataArray()+k.GetSize());
            coefficients.push_back(e->GetInterval().GetMin()); coefficients.push_back(e->GetInterval().GetMax());
        }
        SmTArray<SmEdgeuse*> uses; s.GetEdgeuses(uses);
        for(auto* use:uses) { pointers.push_back(use); pointers.push_back(use->GetUVTrimCurvePointer()); }
    }
};
bool same_metadata(raw_context::Metadata a,raw_context::Metadata b) {
    return std::memcmp(&a.size,&b.size,sizeof(double))==0 && std::memcmp(&a.ratio,&b.ratio,sizeof(double))==0 &&
        std::memcmp(&a.zone.val,&b.zone.val,sizeof(double))==0;
}
void unchanged(const Snapshot& before,SmBrep& source) {
    Snapshot after(source);
    demand(before.pointers==after.pointers && before.coefficients.size()==after.coefficients.size() &&
        std::memcmp(before.coefficients.data(),after.coefficients.data(),before.coefficients.size()*sizeof(double))==0 &&
        same_metadata(before.source,after.source) && same_metadata(before.context,after.context),
        "proof leaves materialized source, absent trim identities and shared policy unchanged");
}
void representation(const char* fixture,SmBrep& source,const Snapshot& snapshot) {
    SmTArray<SmFace*> faces; source.GetFaces(faces);
    unsigned generic=0,planes=0,other=0; uint64_t hash=14695981039346656037ULL;
    for(double coefficient:snapshot.coefficients) {
        uint64_t bits=0; std::memcpy(&bits,&coefficient,8);
        for(unsigned b=0;b<8;++b) { hash^=(bits>>(8*b))&255u; hash*=1099511628211ULL; }
    }
    for(auto* face:faces) {
        const auto type=face->GetSurface()->GetType();
        generic+=type==SmBSplineSurface_TYPE; planes+=type==SmPlane_TYPE;
        other+=type!=SmBSplineSurface_TYPE && type!=SmPlane_TYPE;
    }
    std::fprintf(stderr,"affine source fixture=%s faces=%lu generic=%u planes=%u other=%u raw_coefficients=%zu fnv64=%016llx\n",
        fixture,static_cast<unsigned long>(faces.GetSize()),generic,planes,other,snapshot.coefficients.size(),
        static_cast<unsigned long long>(hash));
}
unsigned prove_generics(SmBrep& source,const char* fixture,unsigned expected) {
    Snapshot before(source); representation(fixture,source,before);
    SmTArray<SmFace*> faces; source.GetFaces(faces); unsigned count=0;
    for(ULONG i=0;i<faces.GetSize();++i) {
        if(faces[i]->GetSurface()->GetType()!=SmBSplineSurface_TYPE) continue;
        const auto proof=certify_plane_source_rectangle(&source,faces[i]);
        demand(proof.edge_count==4 && proof.holes==0 && proof.u_axis!=proof.v_axis,
            "complete independent affine rectangle certificate");
        demand(proof.uv_hull[0].lo==proof.u[0] && proof.uv_hull[0].hi==proof.u[3] &&
            proof.uv_hull[1].lo==proof.v[0] && proof.uv_hull[1].hi==proof.v[3],"symbolic inverse bounds use actual knot support");
        for(const auto& edge:proof.edges) for(unsigned d=0;d<3;++d)
            demand(edge.start[d]>=proof.bounds[d].lo && edge.start[d]<=proof.bounds[d].hi &&
                edge.end[d]>=proof.bounds[d].lo && edge.end[d]<=proof.bounds[d].hi,"actual complete boundary enclosed");
        ++count;
    }
    demand(expected>0 && count==expected,"explicit fixture exercises every required actual generic affine face");
    const auto domain=certify_plane_domain(&source); unsigned missing=0;
    for(ULONG i=0;i<faces.GetSize();++i) if(faces[i]->GetSurface()->GetType()==SmBSplineSurface_TYPE) {
        SmTArray<SmEdgeuse*> uses; faces[i]->GetUpwardEdgeuses(uses); bool absent=false;
        for(auto* use:uses) absent|=use->GetUVTrimCurve()==nullptr;
        if(absent) {
            demand(missing<domain.rectangle_count && domain.rectangles[missing].source_face==i,
                "production record binds actual revision-local source face index"); ++missing;
        }
    }
    demand(missing==expected && domain.rectangle_count==expected && (domain.methods&8u),
        "every required generic face executes genuine missing-cache derived production proof");
    ifclite_smlib_plane_certificate c{}; populate_plane_source_records(domain,c);
    demand(c.version==(missing?2u:1u) && c.rectangle_count==missing &&
        c.rectangle_record_bytes==(missing?1376u:0u) && c.rectangle_edge_bytes==(missing?248u:0u),
        "native certificate version2 iff actual derived proof records exist");
    unchanged(before,source); return count;
}
void prove_analytic_clip(SmBrep& source) {
    Snapshot before(source); representation("direct-box-clip",source,before);
    SmTArray<SmFace*> faces; source.GetFaces(faces);
    demand(faces.GetSize()==6,"actual box Clip retains six bounded boundary faces");
    for(auto* face:faces) demand(face->GetSurface()->GetType()==SmPlane_TYPE,
        "direct box Boolean fixture has actual analytic plane dispatch");
    const auto domain=certify_plane_domain(&source);
    demand(domain.methods==1 && domain.rectangle_count==0 && domain.cylinder_count==0,
        "analytic Boolean result certifies through existing real cached UV route");
    ifclite_smlib_plane_certificate certificate{}; populate_plane_source_records(domain,certificate);
    demand(certificate.version==1 && certificate.rectangle_count==0,"actual analytic source remains certificate v1");
    unchanged(before,source);
}
void clipped_affine_positive(SmBrep& source,const double* identity) {
    Snapshot original(source); ifclite_smlib_affine_certificate affine{};
    auto generic=copy_affine_rational(&source,identity,affine); unchanged(original,source);
    demand(affine.version==1 && affine.source_classes[7]==6,
        "real affine operation consumes six actual analytic Boolean faces");
    prove_generics(*generic,"identity-affine-of-direct-box-clip",6);
    Snapshot before(*generic);
    const double y[]={0,1,0,0,1,0}; ifclite_smlib_plane_certificate receipt{};
    auto second=clip_finite_plane(generic.get(),y,1,IFCLITE_SMLIB_INTERSECTION,receipt);
    demand(receipt.version==2 && (receipt.method&8u) && receipt.rectangle_count==6 && !receipt.empty,
        "actual Clip consumes genuine affine generic coefficients using six derived source proofs");
    unchanged(before,*generic);
    double input_volume=0,output_volume=0;
    demand(SmApiBrepComputeVolume(generic.get(),1e-8,input_volume)==SM_SUCCESS && std::abs(input_volume-6)<1e-4 &&
        SmApiBrepComputeVolume(second.get(),1e-8,output_volume)==SM_SUCCESS && std::abs(output_volume-3)<1e-4,
        "actual affine generic Clip retains independent box-chain input/output volumes");
}
void exact_predicates() {
    using namespace plane_source_proof;
    demand(linear_value(1,0,2,0,1,0.5),"exact cropped linear endpoint");
    demand(!linear_value(std::nextafter(1.,2.),0,2,0,1,0.5),"one ULP is not exact zero");
    const double tiny=std::numeric_limits<double>::denorm_min(),large=std::numeric_limits<double>::max();
    ProductSum sub; sub.add(tiny,tiny); demand(!sub.zero(),"exact underflow product remains nonzero");
    sub.add(tiny,tiny,true); demand(sub.zero(),"exact subnormal cancellation");
    ProductSum huge; huge.add(large,large); demand(!huge.zero(),"exact overflow product remains finite integer evidence");
    huge.add(large,large,true); demand(huge.zero(),"exact overflowing cancellation");
    ProductSum residual; residual.add(large,large); residual.add(large,large,true); residual.add(tiny,tiny);
    demand(!residual.zero(),"huge cancellation cannot swallow smallest residual");
    demand(canonical_value(5000002,5000000,2,1,1) && canonical_value(-2,0,2,-1,1),"canonical signed source line equation");
    demand(!canonical_value(std::nextafter(5000002.,5000003.),5000000,2,1,1),"survey residual is not a proof");
}
void tolerance_enclosures() {
    for(unsigned kind=0;kind<4;++kind) {
        raw_context::Restore restore(SmApiGetOrCreateContext()); auto source=box(); replace_planes(*source);
        SmTArray<SmFace*> faces; source->GetFaces(faces);
        SmTArray<SmEdge*> edges; source->GetEdges(edges);
        SmTArray<SmVertex*> vertices; source->GetVertices(vertices);
        const SmZoneTol3d amount(0.125);
        if(kind==0) source->SetTolerance(amount,FALSE,FALSE);
        if(kind==1) faces[0]->SetTolerance(amount,FALSE,FALSE);
        if(kind==2) edges[0]->SetTolerance(amount,FALSE,FALSE);
        if(kind==3) vertices[0]->SetTolerance(amount,FALSE,FALSE);
        Snapshot before(*source); const auto domain=certify_plane_domain(source.get());
        demand(domain.tolerance>=0.125,"source, face, edge and vertex tolerance contributions retained");
        for(const auto& axis:domain.bounds) demand(axis.lo<=-0.125 && axis.hi>=2.125,
            "entire derived domain expanded outward by actual source tolerance");
        unchanged(before,*source);
    }
}
void production_ledgers() {
    auto source=box(); replace_planes(*source);
    const auto domain=certify_plane_domain(source.get());
    std::fprintf(stderr,"affine source ledger=all-derived records=%u coefficients=%u\n",domain.rectangle_count,domain.coefficients);
    demand(domain.rectangle_count==6 && domain.coefficients==96,
        "one ledger charges all six 12-control derived faces plus all twelve two-control edges");
    auto authored=box(); replace_planes(*authored,true);
    const auto old=certify_plane_domain(authored.get());
    demand((old.methods&2u) && !(old.methods&8u) && !old.rectangle_count,"complete authored UV route remains method2");
    // Leave exactly one cache absent, retaining other complete authored curves
    // on all faces. Those curves must still be charged to the SAME ledger.
    SmTArray<SmFace*> faces; authored->GetFaces(faces);
    SmTArray<SmEdgeuse*> uses; faces[0]->GetUpwardEdgeuses(uses);
    demand(uses.GetSize()==4 && uses[0]->GetMate(),"actual one-missing-cache mixed fixture");
    uses[0]->SetUVTrimCurve(nullptr,0,TRUE); uses[0]->GetMate()->SetUVTrimCurve(nullptr,0,TRUE);
    demand(uses[0]->GetUVTrimCurve()==nullptr,"fixture has exactly the intended absent cache");
    const auto mixed=certify_plane_domain(authored.get());
    std::fprintf(stderr,"affine source ledger=mixed-trims records=%u coefficients=%u\n",mixed.rectangle_count,mixed.coefficients);
    demand(mixed.rectangle_count==1 && (mixed.methods&2u) && (mixed.methods&8u) && mixed.coefficients==102,
        "mixed old/new face routes retain every present trim charge across faces");
    // Real source with 18 independently bounded planar faces exceeds 16 records.
    auto many=box();
    for(double x:{4.,8.}) {
        auto other=box(x); SmBrep* result=nullptr;
        const auto status=SmApiBoolean(many.get(),other.release(),SM_BO_UNION,result);
        demand(status==SM_SUCCESS && result==many.get(),"actual SDK disjoint union fixture ownership");
    }
    SmTArray<SmFace*> many_faces; many->GetFaces(many_faces);
    demand(many_faces.GetSize()==18,"actual eighteen-face source for record ceiling"); replace_planes(*many);
    Snapshot before(*many); bool limited=false;
    try { certify_plane_domain(many.get()); } catch(const SweepFailure& e) { limited=e.status==IFCLITE_SMLIB_RESOURCE_LIMIT; }
    demand(limited,"seventeenth derived face refuses at shared operation record ceiling"); unchanged(before,*many);
}
void negative_fixtures() {
    auto source=box(); replace_planes(*source);
    SmTArray<SmFace*> faces; source->GetFaces(faces);
    auto* b=static_cast<SmBSplineSurface*>(faces[0]->GetSurface());
    ULONG nu=0,nv=0; double* p=nullptr; demand(b->GetControlPointsPointer(nu,nv,p)==SM_SUCCESS && nu==2 && nv==2,"negative fixture actual 2x2 net");
    const auto proof=certify_plane_source_rectangle(source.get(),faces[0]);
    auto reject=[&](const char* message) {
        refuses([&] { certify_plane_source_rectangle(source.get(),faces[0]); },message);
        refuses([&] { certify_plane_domain(source.get()); },message);
    };
    // Deliberately malformed private fixtures. Restore raw coefficients before
    // any SDK operation/destructor; these edits never repair a borrowed source.
    const unsigned n=proof.normal_axis; const double saved=p[12+n];
    for(double warped:{std::nextafter(saved,std::numeric_limits<double>::infinity()),saved+1}) {
        p[12+n]=warped;
        reject("near-affine and warped coefficients refuse exactly");
        p[12+n]=saved;
    }
    const double w=p[3];
    for(double invalid:{0.,-1.,2.,std::numeric_limits<double>::quiet_NaN()}) {
        p[3]=invalid;
        reject("nonunit, nonpositive and nonfinite source weights refuse"); p[3]=w;
    }
    SmTArray<SmEdgeuse*> uses; faces[0]->GetUpwardEdgeuses(uses);
    auto* edge=uses[0]->GetEdge(); const auto interval=edge->GetInterval();
    auto* curve=static_cast<SmBSplineCurve*>(edge->GetCurve()); ULONG count=0; double* controls=nullptr;
    demand(curve->GetControlPointsPointer(count,controls)==SM_SUCCESS && count==2,"actual boundary negative controls");
    const double edge_weight=controls[3]; controls[3]=0;
    reject("nonpositive boundary weight refuses"); controls[3]=edge_weight;
    const double off_plane=controls[n]; controls[n]=std::nextafter(off_plane,std::numeric_limits<double>::infinity());
    reject("one-ULP off-plane complete edge hull refuses"); controls[n]=off_plane;
    edge->SetInterval(SmExtent1d(interval.GetMin()-100,interval.GetMax()+100));
    reject("out-of-support full edge interval refuses"); edge->SetInterval(interval);
    SmTArray<SmLoop*> loops; faces[0]->GetLoops(loops); auto* lu=loops[0]->GetLoopuse(); const auto orient=lu->GetOrientation();
    lu->SetOrientation(SM_OT_OPPOSITE);
    reject("hole or wrong outer-side ownership refuses"); lu->SetOrientation(orient);
    auto foreign=box(); SmTArray<SmFace*> foreign_faces; foreign->GetFaces(foreign_faces);
    refuses([&] { certify_plane_source_rectangle(source.get(),foreign_faces[0]); },"foreign face owner has no source authority");
    // Existing malformed trim witness applies to this seam too, before any
    // raw getter could call GetOrCreateGwNurbPointer on the broken trim.
    auto* context=SmApiGetOrCreateContext();
    auto* broken=new (*context) SmBSplineCurve(); uses[0]->SetUVTrimCurve(broken,0,TRUE);
    reject("present unmaterialized trim cannot be bypassed by affine proof");
    demand(broken->GetGwNurbPointer()==nullptr && uses[0]->GetUVTrimCurve()==broken,"negative unmaterialized trim identity preserved");
}
}
void run_plane_source_domain_tests() {
    auto* context=SmApiGetOrCreateContext(); raw_context::Restore restore(context);
    exact_predicates();
    auto source=box(); replace_planes(*source); prove_generics(*source,"explicit-generic-replacement",6);
    auto survey=box(5000000,-2000000,100); replace_planes(*survey); prove_generics(*survey,"explicit-survey-generic-replacement",6);
    const double identity[]={1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};
    const double reflection[]={-2,0,0,0,0,3,0,0,0,0,4,0,5000000,-2000000,100,1};
    auto authored=box();
    for(const double* matrix:{identity,reflection}) {
        ifclite_smlib_affine_certificate c{}; auto transformed=copy_affine_rational(authored.get(),matrix,c);
        demand(c.version!=0,"actual SDK affine output certificate");
        prove_generics(*transformed,matrix==identity?"actual-identity-affine":"actual-reflected-survey-affine",6);
    }
    const double plane[]={0.5,0,0,1,0,0}; ifclite_smlib_plane_certificate c{};
    auto sealed=clip_finite_plane(authored.get(),plane,1,IFCLITE_SMLIB_INTERSECTION,c);
    demand(c.version && !c.empty,"actual first sealed Clip source, not inferred affine ancestry");
    prove_analytic_clip(*sealed);
    clipped_affine_positive(*sealed,identity);
    std::fprintf(stderr,"affine source BEGIN actual tolerance enclosure fixtures\n");
    tolerance_enclosures();
    std::fprintf(stderr,"affine source BEGIN actual shared operation ledger fixtures\n");
    production_ledgers();
    std::fprintf(stderr,"affine source BEGIN strict malformed source negatives\n");
    negative_fixtures();
}
