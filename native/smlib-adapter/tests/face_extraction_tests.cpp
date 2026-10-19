// SPDX-License-Identifier: MPL-2.0
// Real SDK extraction and terminal partial-mutation witnesses. UNRUN.
#include "face_extraction.hpp"
#include "generated_plane.hpp"
#include "context_metadata.hpp"
#include "copy.hpp"
#include "sweep.hpp"
#include "ifclite_smlib.h"
#include <SmApiGeneral.h>
#include <SmApiPrimitives.h>
#include <SmAssertArray.h>
#include <SmBSplineSurface.h>
#include <SmFace.h>
#include <SmFaceuse.h>
#include <SmEdgeuse.h>
#include <SmLoop.h>
#include <SmMerge.h>
#include <SmPlane.h>
#include <SmShell.h>
#include <SmVertex.h>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <stdexcept>
namespace {
using namespace face_lineage;
void require(bool ok,const char* message) { if(!ok) throw std::runtime_error(message); }
bool bits(double a,double b) { return std::memcmp(&a,&b,sizeof(a))==0; }
struct Owned {
    std::unique_ptr<SmBrep> source,target,copy;
    std::unique_ptr<SmMerge> relations;
    ~Owned() {
        if(kernel_domain_is_tainted()) { source.release(); target.release(); copy.release(); relations.release(); }
        else relations.reset(); // Relation maps cannot outlive their operands.
    }
};
std::unique_ptr<SmBrep> box() {
    SmBrep* raw=nullptr;
    try {
        require(SmApiCreateBox(SmVector3d(0,0,0),2,2,2,raw)==SM_SUCCESS && raw,"real SDK box");
        return std::unique_ptr<SmBrep>(raw);
    } catch(...) { rethrow_tainted_kernel_domain("extraction box fixture construction"); }
}
void admit(Ledger& ledger,SmBrep& source,RootKind kind=RootKind::SourceBoundary) {
    SmTArray<SmFace*> faces; source.GetFaces(faces); std::vector<Seed> seeds;
    for(auto* face:faces) seeds.push_back({face,kind});
    ledger.admit_roots(source,ObjectRevision{901,41,39,6,29,kind==RootKind::SourceBoundary?0u:404u},seeds.data(),seeds.size());
}
void release(Owned& owned,Ledger& ledger,SmContext& context) {
    Scope phase(ledger,context); owned.relations.reset(); ledger.check();
    owned.source.reset(); ledger.check(); owned.target.reset(); ledger.check();
    if(owned.copy) {
        ledger.verify_inventory(*owned.copy); SmTArray<SmFace*> faces; owned.copy->GetFaces(faces);
        for(auto* face:faces) {
            std::array<Root,8> roots{};
            require(ledger.roots(ledger.identity(face),roots.data(),roots.size())==1 && roots[0].object.incarnation==901,
                "actual extracted-copy root evidence survives original/target/operator release");
        }
    }
    owned.copy.reset(); ledger.check();
    phase.finish(); ledger.check();
}
void box_transfer() {
    std::fprintf(stderr,"extraction BEGIN all-face box transfer, live mates, repeated mated branch and signed boundary integral\n");
    Owned owned; owned.source=box(); auto& context=*const_cast<SmContext*>(owned.source->GetContext());
    Ledger ledger; Scope lifetime(ledger,context);
    std::fprintf(stderr,"extraction stage=source-root-admission\n"); admit(ledger,*owned.source);
    std::fprintf(stderr,"extraction stage=source-root-admitted\n");
    const auto metadata=raw_context::Access<SmBrep>::get(*owned.source);
    SmTArray<SmFace*> source; owned.source->GetFaces(source);
    SmTArray<SmVertex*> vertices; owned.source->GetVertices(vertices);
    std::vector<SmPoint3d> before; for(auto* v:vertices) before.push_back(v->GetPoint());
    std::vector<Identity> original; for(auto* f:source) original.push_back(ledger.identity(f));
    {
        Scope phase(ledger,context); std::fprintf(stderr,"extraction stage=target-constructor\n"); owned.target=raw_context::construct_brep(&context); ledger.check();
        std::fprintf(stderr,"extraction stage=relation-constructor\n");
        owned.relations=std::unique_ptr<SmMerge>(new (context) SmMerge(context,owned.target.get(),owned.source.get())); ledger.check();
        phase.finish(); ledger.check();
    }
    std::fprintf(stderr,"extraction stage=duplicate-preflight\n");
    SmFace* duplicate[]{source[0],source[0]}; bool refused=false;
    try { checked_extract_faces(*owned.source,*owned.target,*owned.relations,duplicate,2,ledger); }
    catch(const SweepFailure&) { refused=true; }
    require(refused && !kernel_domain_is_tainted() && owned.target->GetNumFaces()==0,"duplicate preflight performs no extraction mutation");
    {
        Scope phase(ledger,context); std::fprintf(stderr,"extraction stage=reversed-relation-constructor\n");
        SmMerge wrong(context,owned.source.get(),owned.target.get()); ledger.check(); refused=false;
        try { checked_extract_faces(*owned.source,*owned.target,wrong,source.GetDataArray(),source.GetSize(),ledger); }
        catch(const SweepFailure&) { refused=true; }
        require(refused && !kernel_domain_is_tainted() && owned.target->GetNumFaces()==0,"wrong ordered relation owner refuses before mutation");
        phase.finish(); ledger.check();
    }
    std::fprintf(stderr,"extraction stage=selected-face-transfer\n");
    const auto transfers=checked_extract_faces(*owned.source,*owned.target,*owned.relations,source.GetDataArray(),source.GetSize(),ledger);
    require(transfers.size()==6 && owned.target->GetNumFaces()==6,"actual complete selected-face transfer");
    std::fprintf(stderr,"extraction stage=repeated-mated-transfer\n");
    const auto repeated=checked_extract_faces(*owned.source,*owned.target,*owned.relations,source.GetDataArray(),source.GetSize(),ledger);
    require(repeated.size()==6 && owned.target->GetNumFaces()==6,"already-mated SDK branch retains complete face inventory without duplicates");
    for(ULONG i=0;i<source.GetSize();++i) {
        require(ledger.identity(source[i])==original[i] && repeated[i].source==original[i] &&
            ledger.descends_from(repeated[i].output,original[i]),"exact selected source fragment survives actual map transfer");
    }
    {
        Scope phase(ledger,context,owned.source.get());
        std::fprintf(stderr,"extraction stage=target-topology-validation\n");
        SmAssertArray reports;
        require(owned.target->ValidatePointers(&reports,SM_LEVEL_2)==SM_SUCCESS && !reports.GetSize(),"actual extracted topology status and report collection"); ledger.check();
        require(owned.target->IsManifoldSolid(),"all-face box transfer has closed manifold topology");
        SmTArray<SmFace*> faces; owned.target->GetFaces(faces); double volume=0,area=0;
        std::fprintf(stderr,"extraction stage=target-boundary-integral\n");
        for(auto* face:faces) {
            auto* use=face->GetUpwardFaceuse();
            if(use->GetShell()->GetRegion()==owned.target->GetInfiniteRegion()) use=use->GetMate();
            require(use->GetShell()->GetRegion()!=owned.target->GetInfiniteRegion(),"actual bounded-side faceuse incidence");
            SmTArray<SmLoop*> loops; face->GetLoops(loops);
            for(auto* loop:loops) require(loop->IsClosedPtrs() && loop->IsClosed3d(),"actual extracted trim closure");
            double a=0,v=0; SmTArray<SmVector3d> moments;
            require(face->ComputePreciseProperties(use->GetOrientation(),1e-8,SmPoint3d(1,1,1),4.,0.,a,v,moments,
                SM_PPF_AREA|SM_PPF_VOLUME)==SM_SUCCESS,"checked exact-boundary numerical integral"); ledger.check();
            area+=a; volume+=v;
        }
        // Integrate actual bounded-side faceuses directly. MakeFaceuse does
        // not set material flags; no region classification is fabricated here.
        require(std::abs(volume-8)<1e-6 && std::abs(area-24)<1e-6,"analytic signed box boundary volume8 and area24");
        phase.finish(); ledger.check();
    }
    const auto after=raw_context::Access<SmBrep>::get(*owned.source);
    require(bits(metadata.size,after.size) && bits(metadata.ratio,after.ratio) && bits(metadata.zone,after.zone),"original raw metadata preserved");
    for(ULONG i=0;i<vertices.GetSize();++i) {
        const auto p=vertices[i]->GetPoint();
        require(bits(p.x,before[i].x) && bits(p.y,before[i].y) && bits(p.z,before[i].z),"original coordinates unchanged");
    }
    std::fprintf(stderr,"extraction stage=target-owned-copy\n");
    owned.copy=checked_brep_copy(owned.target.get(),&ledger);
    std::fprintf(stderr,"extraction stage=release-source-target-operator\n");
    release(owned,ledger,context); lifetime.finish(); ledger.check();
}
void generated_transfer() {
    std::fprintf(stderr,"extraction BEGIN generated interface constructed under observer, first root, extraction and later copy\n");
    auto& context=*SmApiGetOrCreateContext(); Ledger ledger; Scope lifetime(ledger,context); Owned owned;
    SmFace* face=nullptr;
    {
        Scope phase(ledger,context,nullptr,Phase::InitialConstruction);
        SmAxis2Placement frame;
        require(frame.SetCanonical(SmPoint3d(0,0,0),SmVector3d(1,0,0),SmVector3d(0,1,0))==SM_SUCCESS,"real generated plane frame");
        owned.source=GeneratedPlane::create(ledger,ObjectRevision{901,41,39,6,29,404},frame,SmExtent2d(0,0,2,2),face);
        admit(ledger,*owned.source,RootKind::GeneratedInterface); phase.finish(); ledger.check();
    }
    const auto root=ledger.identity(face);
    {
        Scope phase(ledger,context); owned.target=raw_context::construct_brep(&context);
        owned.relations=std::unique_ptr<SmMerge>(new (context) SmMerge(context,owned.target.get(),owned.source.get())); ledger.check(); phase.finish(); ledger.check();
    }
    const auto transfers=checked_extract_faces(*owned.source,*owned.target,*owned.relations,&face,1,ledger);
    require(transfers.size()==1 && ledger.descends_from(transfers[0].output,root),"actual generated fragment extraction ancestry");
    owned.copy=checked_brep_copy(owned.target.get(),&ledger);
    SmTArray<SmFace*> faces; owned.copy->GetFaces(faces); std::array<Root,2> roots{};
    require(faces.GetSize()==1 && ledger.roots(ledger.identity(faces[0]),roots.data(),roots.size())==1 &&
        roots[0].kind==RootKind::GeneratedInterface && roots[0].object.operation==404,"generated interface label survives extraction and subsequent copy");
    release(owned,ledger,context); lifetime.finish(); ledger.check();
}
class FailingSurface final:public SmBSplineSurface {
public:
    unsigned& calls;
    SmBrep*& target;
    unsigned& vertices;
    unsigned& edges;
    FailingSurface(const SmBSplineSurface& source,unsigned& counter,SmBrep*& actual_target,unsigned& v,unsigned& e):
        SmBSplineSurface(source),calls(counter),target(actual_target),vertices(v),edges(e) {}
    SmStatus CopyAndAddAnalytics(const SmContext&,SmSurface*& output) const override {
        if(target) { vertices=target->GetNumVertices(); edges=target->GetNumEdges(); }
        ++calls; output=nullptr; return SM_ERR;
    }
};
void terminal_failure() {
    std::fprintf(stderr,"extraction BEGIN actual MakeFaceuse virtual surface-copy failure after boundary mutation\n");
    Owned owned; owned.source=box(); auto& context=*const_cast<SmContext*>(owned.source->GetContext());
    SmTArray<SmFace*> faces; owned.source->GetFaces(faces);
    unsigned surface_copy_calls=0,boundary_vertices=0,boundary_edges=0; SmBrep* fault_target=nullptr;
    auto* original=static_cast<SmBSplineSurface*>(faces[0]->GetSurface());
    const auto domain=faces[0]->GetUVDomain(); const auto rectangular=faces[0]->GetRectangularTrim();
    struct Trim { SmEdgeuse* owner; std::unique_ptr<SmBSplineCurve> copy; };
    std::vector<Trim> trims; SmTArray<SmEdgeuse*> uses; faces[0]->GetUpwardEdgeuses(uses);
    for(auto* use:uses) {
        SmEdgeuse* owner=nullptr; auto* actual=use->GetUVTrimCurve(&owner);
        require(actual && owner && actual->GetDim()==2,"genuine existing UV trim before fault installation");
        bool seen=false; for(const auto& trim:trims) seen|=trim.owner==owner;
        if(seen) continue;
        SmBSplineCurve* copy=nullptr; require(actual->Copy(context,copy)==SM_SUCCESS && copy,"checked genuine trim preservation");
        trims.push_back({owner,std::unique_ptr<SmBSplineCurve>(copy)});
    }
    auto* injected=new (context) FailingSurface(*original,surface_copy_calls,fault_target,boundary_vertices,boundary_edges);
    ULONG nu=0,nv=0,ncu=0,ncv=0,ku=0,kv=0,kcu=0,kcv=0;
    double *p=nullptr,*copy_p=nullptr,*u=nullptr,*v=nullptr,*copy_u=nullptr,*copy_v=nullptr;
    require(original->GetControlPointsPointer(nu,nv,p)==SM_SUCCESS && injected->GetControlPointsPointer(ncu,ncv,copy_p)==SM_SUCCESS &&
        nu==ncu && nv==ncv && nu && nv && std::memcmp(p,copy_p,4*nu*nv*sizeof(double))==0,"fault surface preserves actual homogeneous coefficients and weights");
    require(original->GetKnotsPointers(ku,kv,u,v)==SM_SUCCESS && injected->GetKnotsPointers(kcu,kcv,copy_u,copy_v)==SM_SUCCESS &&
        ku==kcu && kv==kcv && std::memcmp(u,copy_u,ku*sizeof(double))==0 && std::memcmp(v,copy_v,kv*sizeof(double))==0,
        "fault surface preserves actual knot representation");
    faces[0]->SetSurface(injected,TRUE); // SetSurface deliberately clears trims.
    const auto after=faces[0]->GetUVDomain();
    require(bits(domain.GetUMin(),after.GetUMin()) && bits(domain.GetUMax(),after.GetUMax()) &&
        bits(domain.GetVMin(),after.GetVMin()) && bits(domain.GetVMax(),after.GetVMax()) &&
        rectangular==faces[0]->GetRectangularTrim(),"fault installation preserves exact face domain and rectangular semantics");
    for(auto& trim:trims) trim.owner->SetUVTrimCurve(trim.copy.release(),0.,TRUE);
    for(auto* use:uses) require(use->GetUVTrimCurve(),"genuine trims restored before root adoption and sealed preflight");
    require(surface_copy_calls==0,"fault has not fired during valid authentic fixture preparation");
    uint64_t session=0; ifclite_smlib_handle handle{};
    require(ifclite_smlib_session_create(&session)==0 && ifclite_smlib_box(session,0,0,0,1,1,1,&handle)==0,"real unrelated live handle before extraction failure");
    auto* previous=context.GetUserNotifyCallback();
    Ledger ledger; auto* system=context.GetSysNotifyCallback(); Scope lifetime(ledger,context);
    admit(ledger,*owned.source);
    {
        Scope phase(ledger,context); owned.target=raw_context::construct_brep(&context);
        fault_target=owned.target.get();
        owned.relations=std::unique_ptr<SmMerge>(new (context) SmMerge(context,owned.target.get(),owned.source.get())); ledger.check(); phase.finish(); ledger.check();
    }
    std::vector<FaceTransfer> published; bool failed=false;
    try { published=checked_extract_faces(*owned.source,*owned.target,*owned.relations,faces.GetDataArray(),1,ledger); }
    catch(const KernelDomainTainted& error) {
        failed=error.message.find("checked SDK face extraction failed")!=std::string::npos;
    }
    require(failed && published.empty() && kernel_domain_is_tainted(),"real failed SDK phase cannot return transfer evidence");
    // Callback/context scalar restoration is permitted; no SDK graph access or
    // destructors after uncertain failure, even to count partial allocations.
    require(surface_copy_calls==1 && boundary_vertices==4 && boundary_edges==4,
        "fault reached actual surface-copy seam after four real target vertices and edges were merged");
    lifetime.finish();
    require(context.GetUserNotifyCallback()==previous && context.GetSysNotifyCallback()==system,
        "caller slot restored and system slot untouched on failure");
    double volume=0;
    require(ifclite_smlib_volume(session,handle,1e-8,&volume)==IFCLITE_SMLIB_TAINTED_DOMAIN,"failed extraction taints unrelated public handles");
    require(ifclite_smlib_session_destroy(session)==IFCLITE_SMLIB_TAINTED_DOMAIN,"no reset recovery after partial extraction");
    owned.source.release(); owned.target.release(); owned.relations.release();
}
}
int main(int argc,char** argv) {
    SmApiCreateContext();
    try {
        require(argc==2,"explicit extraction witness lane required");
        if(std::strcmp(argv[1],"--transfer")==0) { box_transfer(); generated_transfer(); }
        else if(std::strcmp(argv[1],"--terminal-failure")==0) terminal_failure();
        else require(false,"unknown extraction witness lane");
    }
    catch(const KernelDomainTainted& e) { std::fprintf(stderr,"extraction unexpected status8: %s\n",e.message.c_str()); return 1; }
    catch(const SweepFailure& e) { std::fprintf(stderr,"extraction refusal: %s\n",e.message); return 1; }
    catch(const std::exception& e) { std::fprintf(stderr,"extraction witness: %s\n",e.what()); return 1; }
    std::puts("checked face transfer witnesses PASS; paired partition and interface proof remain unavailable");
}
