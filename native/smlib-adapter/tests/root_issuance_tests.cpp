// SPDX-License-Identifier: MPL-2.0
// Actual SDK first-issuance witnesses for pinned review P2. UNRUN.
#include "face_lineage.hpp"
#include "context_metadata.hpp"
#include "copy.hpp"
#include "representation_seal.hpp"
#include "generated_plane.hpp"
#include "sweep.hpp"
#include <SmApiGeneral.h>
#include <SmFace.h>
#include <SmEdge.h>
#include <SmEdgeuse.h>
#include <SmVertex.h>
#include <SmBSplineCurve.h>
#include <SmPlane.h>
#include <array>
#include <cstdio>
#include <cstring>
#include <stdexcept>
namespace {
using namespace face_lineage;
void require(bool ok,const char* message) { if(!ok) throw std::runtime_error(message); }
struct Owned {
    std::unique_ptr<SmBrep> source,copy;
    ~Owned() { if(kernel_domain_is_tainted()) { source.release(); copy.release(); } }
};
const ObjectRevision generated{901,41,29,5,21,303};
std::unique_ptr<SmBrep> patch(SmContext& context,SmFace*& face,Ledger* ledger=nullptr) {
    if(ledger) {
        SmAxis2Placement frame;
        require(frame.SetCanonical(SmPoint3d(0,0,0),SmVector3d(1,0,0),SmVector3d(0,1,0))==SM_SUCCESS,"audited generated frame");
        return GeneratedPlane::create(*ledger,generated,frame,SmExtent2d(0,0,2,2),face);
    }
    auto source=raw_context::construct_brep(&context);
    try {
        SmAxis2Placement frame;
        require(frame.SetCanonical(SmPoint3d(0,0,0),SmVector3d(1,0,0),SmVector3d(0,1,0))==SM_SUCCESS,"real plane frame");
        SmPlane* surface=nullptr;
        require(SmPlane::CreateCanonical(context,frame,surface)==SM_SUCCESS && surface,"real plane surface");
        const SmExtent2d domain(0,0,2,2);
        require(surface->AdjustSTEPUVDomain(domain)==SM_SUCCESS &&
            source->CreateFaceFromSurface(surface,domain,face)==SM_SUCCESS && face,"real generated plane patch");
        return source;
    } catch(...) { source.release(); rethrow_tainted_kernel_domain("initial issuance fixture construction"); }
}
std::unique_ptr<SmBrep> prepared_patch(SmContext& context,SmFace*& face) {
    auto source=patch(context,face); // Authentic unobserved source, before adoption.
    try {
        const auto before=face->GetUVDomain();
        double ms=0,xs=0,me=0,xe=0,mv=0,xv=0;
        require(face->CreateUVTrimCurves(FALSE,nullptr,nullptr,ms,xs,me,xe,mv,xv)==SM_SUCCESS,
            "real checked initial UV trim preparation before adoption");
        const auto after=face->GetUVDomain();
        auto equal=[](double a,double b) { return std::memcmp(&a,&b,sizeof(a))==0; };
        require(equal(before.GetUMin(),after.GetUMin()) && equal(before.GetUMax(),after.GetUMax()) &&
            equal(before.GetVMin(),after.GetVMin()) && equal(before.GetVMax(),after.GetVMax()),
            "initial trim preparation preserves exact face domain");
        SmTArray<SmEdgeuse*> uses; face->GetUpwardEdgeuses(uses);
        require(uses.GetSize()==4,"actual prepared four-edge patch inventory");
        for(auto* use:uses) {
            SmEdgeuse* owner=nullptr; auto* trim=use->GetUVTrimCurve(&owner);
            require(trim && owner && trim->GetOwner()==owner && trim->GetDim()==2,
                "genuine materialized trim with exact live owner before adoption");
        }
        return source;
    } catch(...) { source.release(); rethrow_tainted_kernel_domain("initial trim fixture preparation"); }
}
bool refuses(Ledger& ledger,SmBrep& source,const Seed* seeds,uint32_t count) {
    try { ledger.admit_roots(source,generated,seeds,count); }
    catch(const SweepFailure&) { return true; }
    return false;
}
}
void run_root_issuance_tests() {
    std::fprintf(stderr,"lineage BEGIN reviewed P2 audited constructor-only first generated issuance\n");
    auto& context=*SmApiGetOrCreateContext();
    {
        Ledger ledger; Scope lifetime(ledger,context); Owned owned; SmFace* face=nullptr;
        {
            Scope construction(ledger,context,nullptr,Phase::InitialConstruction);
            owned.source=patch(context,face,&ledger); ledger.check();
            const Seed seed{face,RootKind::GeneratedInterface};
            require(refuses(ledger,*owned.source,nullptr,0),"missing live face inventory cannot issue a root");
            const Seed duplicate[]{seed,seed};
            require(refuses(ledger,*owned.source,duplicate,2),"duplicate live face inventory cannot issue a root");
            const Seed relabel{face,RootKind::SourceBoundary};
            require(refuses(ledger,*owned.source,&relabel,1),"pending generated receipt cannot become original source boundary");
            auto wrong=generated; ++wrong.revision; bool wrong_revision=false;
            try { ledger.admit_roots(*owned.source,wrong,&seed,1); } catch(const SweepFailure&) { wrong_revision=true; }
            require(wrong_revision,"pending constructor receipt binds the exact issued object revision");
            ledger.admit_roots(*owned.source,generated,&seed,1); ledger.verify_inventory(*owned.source);
            require(refuses(ledger,*owned.source,&seed,1),"rooted constructor cannot be reissued or relabelled");
            construction.finish(); ledger.check();
        }
        const auto id=ledger.identity(face);
        owned.copy=checked_brep_copy(owned.source.get(),&ledger);
        SmTArray<SmFace*> faces; owned.copy->GetFaces(faces);
        require(faces.GetSize()==1 && ledger.descends_from(ledger.identity(faces[0]),id),"first generated root survives actual owned copy");
        std::array<Root,2> roots{};
        require(ledger.roots(ledger.identity(faces[0]),roots.data(),roots.size())==1 &&
            roots[0].kind==RootKind::GeneratedInterface && roots[0].object.operation==303 &&
            roots[0].object.revision==21,"generated operation/revision binding retained");
        const Seed copied{faces[0],RootKind::SourceBoundary};
        {
            Scope construction(ledger,context,nullptr,Phase::InitialConstruction);
            require(refuses(ledger,*owned.copy,&copied,1),"copied history cannot become authored source");
            construction.finish(); ledger.check();
        }
        Scope release(ledger,context); owned.source.reset(); ledger.check(); owned.copy.reset(); ledger.check();
        release.finish(); ledger.check(); lifetime.finish(); ledger.check();
    }
    for(bool audited:{false,true}) {
        Ledger ledger; Scope lifetime(ledger,context); Owned owned; SmFace* face=nullptr;
        {
            Scope phase(ledger,context,nullptr,audited?Phase::InitialConstruction:Phase::Mutation);
            owned.source=patch(context,face,audited?&ledger:nullptr); ledger.check();
            if(!audited) {
                const Seed seed{face,RootKind::GeneratedInterface};
                require(refuses(ledger,*owned.source,&seed,1),"ordinary unknown construction history cannot be relabelled");
            }
            phase.finish(); ledger.check();
        }
        {
            Scope later(ledger,context,nullptr,Phase::InitialConstruction);
            const Seed seed{face,RootKind::GeneratedInterface};
            require(refuses(ledger,*owned.source,&seed,1),"expired construction frame cannot acquire first root later");
            owned.source.reset(); ledger.check(); later.finish(); ledger.check();
        }
        lifetime.finish(); ledger.check();
    }
    {
        Ledger ledger; Scope lifetime(ledger,context); Owned owned; SmFace* face=nullptr;
        Scope construction(ledger,context,nullptr,Phase::InitialConstruction);
        owned.source=patch(context,face,&ledger); ledger.check();
        // Real notifying surface replacement, even by an exactly equal copy,
        // is subsequent geometry history rather than constructor issuance.
        SmSurface* replacement=nullptr;
        require(face->GetSurface()->Copy(context,replacement)==SM_SUCCESS && replacement,"real equal surface copy for refusal");
        face->SetSurface(replacement,TRUE); ledger.check();
        const Seed seed{face,RootKind::GeneratedInterface};
        require(refuses(ledger,*owned.source,&seed,1),"edited unrooted face cannot be relabelled as initial generated geometry");
        owned.source.reset(); ledger.check(); construction.finish(); ledger.check(); lifetime.finish(); ledger.check();
    }
    {
        Ledger ledger; Scope lifetime(ledger,context); Owned owned; SmFace* face=nullptr;
        Scope construction(ledger,context,nullptr,Phase::InitialConstruction);
        owned.source=patch(context,face,&ledger); ledger.check();
        auto domain=face->GetUVDomain();
        require(static_cast<SmPlane*>(face->GetSurface())->TrimWithDomain(domain)==SM_SUCCESS,
            "real attached SmPlane TrimWithDomain emits surface PRE_EDIT"); ledger.check();
        const Seed seed{face,RootKind::GeneratedInterface};
        require(refuses(ledger,*owned.source,&seed,1),"attached surface edit cannot acquire constructor-only first root");
        owned.source.reset(); ledger.check(); construction.finish(); ledger.check(); lifetime.finish(); ledger.check();
    }
    // Audit the complete notifying owner family, before and after first roots,
    // while edge/vertex generations are STILL newborn in the same frame.
    for(bool rooted:{false,true}) for(unsigned mutation=0;mutation<6;++mutation) {
        Ledger ledger; Scope lifetime(ledger,context); Owned owned; SmFace* face=nullptr;
        Scope construction(ledger,context,nullptr,Phase::InitialConstruction);
        owned.source=patch(context,face,&ledger); ledger.check();
        const Seed seed{face,RootKind::GeneratedInterface};
        if(rooted) ledger.admit_roots(*owned.source,generated,&seed,1);
        if(mutation==0) {
            SmTArray<SmEdge*> edges; face->GetEdges(edges); require(edges.GetSize()>0,"actual boundary edge");
            SmCurve* copied=nullptr; require(edges[0]->GetCurve()->Copy(context,copied)==SM_SUCCESS && copied,"actual equal 3D boundary curve copy");
            require(edges[0]->Replace3DCurve(copied)==SM_SUCCESS,"real notifying edge replacement");
        } else if(mutation==1) {
            SmTArray<SmVertex*> vertices; face->GetVertices(vertices); require(vertices.GetSize()>0,"actual boundary vertex");
            vertices[0]->SetPoint(vertices[0]->GetPoint()); // Second setter, identical bits.
        } else if(mutation==2) {
            SmTArray<SmEdgeuse*> uses; face->GetUpwardEdgeuses(uses); require(uses.GetSize()>0,"actual trim owner use");
            auto* curve=uses[0]->GetUVTrimCurve(); require(curve,"actual materialized 2D trim");
            const auto interval=curve->GetNaturalInterval();
            require(curve->EditParameterization(SmExtent1d(interval.GetMin(),interval.GetMax()+0.25),TRUE)==SM_SUCCESS,"real attached UV trim PRE/POST edit");
        } else if(mutation==3) {
            auto domain=face->GetUVDomain();
            require(static_cast<SmPlane*>(face->GetSurface())->TrimWithDomain(domain)==SM_SUCCESS,"actual attached surface PRE_EDIT");
        } else if(mutation==4) {
            SmTArray<SmEdge*> edges; face->GetEdges(edges); require(edges.GetSize()>0,"actual owned 3D curve");
            auto* curve=static_cast<SmBSplineCurve*>(edges[0]->GetCurve()); const auto interval=curve->GetNaturalInterval();
            require(curve->EditParameterization(SmExtent1d(interval.GetMin(),interval.GetMax()+0.25),TRUE)==SM_SUCCESS,"actual owned 3D curve PRE/POST edit");
        } else {
            auto* surface=face->GetSurface(); surface->SetOwner(nullptr); surface->SetOwner(face);
            // Same owner transition as MakeFace, but OUTSIDE the private fixed
            // call. Restoring equal final ownership cannot restore history.
        }
        if(rooted) require(ledger.failed()==Failure::UnsupportedGeometryChange,"same-frame rooted numerical history never has newborn exemption");
        else {
            ledger.check(); require(refuses(ledger,*owned.source,&seed,1),"edited boundary/trim history cannot issue first constructor root");
        }
        // The injected setters completed successfully. This direct SDK
        // witness publishes no evidence; production wrappers taint on failure.
        owned.source.reset(); construction.finish(); lifetime.finish();
    }
    {
        Ledger ledger; Scope lifetime(ledger,context); Owned owned; SmFace* face=nullptr;
        Scope construction(ledger,context,nullptr,Phase::InitialConstruction);
        owned.source=patch(context,face,&ledger);
        auto domain=face->GetUVDomain();
        face->SetUVDomain(SmExtent2d(domain.GetUMin(),domain.GetVMin(),domain.GetUMax()*0.75,domain.GetVMax()));
        const Seed seed{face,RootKind::GeneratedInterface};
        require(refuses(ledger,*owned.source,&seed,1) && ledger.failed()==Failure::RepresentationChanged,
            "pending private construction seal refuses actual silent domain mutation before first roots");
        owned.source.reset(); construction.finish(); lifetime.finish();
    }
    {
        // Preserve the exact missing-trim refusal, separately from the prepared
        // silent-edit controls. No constructor or seal guard is relaxed.
        Owned owned; SmFace* face=nullptr; owned.source=patch(context,face);
        Ledger ledger; Scope lifetime(ledger,context); const Seed seed{face,RootKind::GeneratedInterface};
        ledger.admit_roots(*owned.source,generated,&seed,1);
        bool refused=false;
        try { RepresentationSeal missing(ledger,*owned.source); }
        catch(const SweepFailure& error) { refused=std::strcmp(error.message,"missing actual UV trim in seal")==0; }
        require(refused,"authentic trimless fixture remains unavailable for a representation seal");
        owned.source.reset(); ledger.check(); lifetime.finish(); ledger.check();
    }
    // Silent setter breach simulation at a private source-read boundary. The
    // closed-world allowlisted production paths never accept a user mutator.
    for(unsigned mutation=0;mutation<3;++mutation) {
        Owned owned; SmFace* face=nullptr; owned.source=prepared_patch(context,face);
        std::fprintf(stderr,"lineage silent-edit stage=prepared-fixture mutation=%u\n",mutation);
        Ledger ledger; Scope lifetime(ledger,context); const Seed seed{face,RootKind::GeneratedInterface};
        ledger.admit_roots(*owned.source,generated,&seed,1);
        Scope phase(ledger,context,owned.source.get()); RepresentationSeal seal(ledger,*owned.source); seal.verify();
        std::fprintf(stderr,"lineage silent-edit stage=unchanged-seal-verified mutation=%u\n",mutation);
        SmTArray<SmEdgeuse*> uses; face->GetUpwardEdgeuses(uses); require(uses.GetSize()>0,"actual sealed trim incidence");
        std::unique_ptr<SmCurve> retained_trim;
        if(mutation==0) {
            auto uv=face->GetUVDomain(); uv=SmExtent2d(uv.GetUMin(),uv.GetVMin(),uv.GetUMax()*0.75,uv.GetVMax());
            face->SetUVDomain(uv); // No SDK notification.
        } else if(mutation==1) {
            auto* original=uses[0]->GetUVTrimCurve(); require(original,"materialized trim for silent replacement");
            SmCurve* copied=nullptr; require(original->Copy(context,copied)==SM_SUCCESS && copied,"real trim copy");
            uses[0]->SetUVTrimCurve(static_cast<SmBSplineCurve*>(copied),0.,FALSE); retained_trim.reset(original);
            // Retained original is still live; no destructor notification can
            // be mistaken for detection of the SDK's silent pointer swap.
        } else {
            ULONG count=0; double* controls=nullptr;
            require(uses[0]->GetUVTrimCurve()->GetControlPointsPointer(count,controls)==SM_SUCCESS && count && controls,"actual writable trim control storage");
            controls[0]+=0.125; // Raw SDK storage write emits no callback.
        }
        require(ledger.failed()==Failure::None,"silent numerical edit did not notify observer");
        bool refused=false; try { seal.verify(); } catch(const SweepFailure&) { refused=true; }
        require(refused && ledger.failed()==Failure::RepresentationChanged,"exact retained representation comparison refuses silent setter family");
        std::fprintf(stderr,"lineage silent-edit stage=intended-edit-refused mutation=%u\n",mutation);
        retained_trim.reset(); owned.source.reset(); phase.finish(); lifetime.finish();
    }
}
