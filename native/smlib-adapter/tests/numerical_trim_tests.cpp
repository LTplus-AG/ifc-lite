// SPDX-License-Identifier: MPL-2.0
// #7955: real SDK copy constructors, edits, destruction and allocator reuse.
#include "owned_lineage_access.hpp"
#include "representation_seal.hpp"
#include "failure.hpp"
#include <SmApiGeneral.h>
#include <SmBSplineCurve.h>
#include <SmCopyBrepMap.h>
#include <SmEdgeuse.h>
#include <SmFace.h>
#include <SmPoly.h>
#include <array>
#include <cstring>
#include <memory>
#include <new>
#include <stdexcept>
namespace face_lineage {
// Test-only access to the fixed calls' private phase. No runtime callable seam.
struct NumericalReadTestAccess {
    static void begin(Ledger& ledger,SmBrep& source) { NumericalRead::begin(ledger,source); }
    static void tessellation(Ledger& ledger,SmBrep& source) { NumericalRead::begin_tessellation(ledger,source); }
    static void end(Ledger& ledger) { NumericalRead::end(ledger); }
};
}
namespace {
using namespace face_lineage;
void require(bool ok,const char* message) { if(!ok) throw std::runtime_error(message); }
SmBrep& body(const OwnedBoundary& owner) { return const_cast<SmBrep&>(OwnedBoundaryTestAccess::solid(owner)); }
Ledger& history(const OwnedBoundary& owner) { return const_cast<Ledger&>(OwnedBoundaryTestAccess::ledger(owner)); }
SmBSplineCurve* trim(SmBrep& solid) {
    SmTArray<SmFace*> faces; solid.GetFaces(faces);
    require(faces.GetSize()>0,"trim fixture has actual faces");
    SmTArray<SmEdgeuse*> uses; faces[0]->GetUpwardEdgeuses(uses);
    require(uses.GetSize()>0,"trim fixture has actual edgeuses");
    auto* result=uses[0]->GetUVTrimCurve();
    require(result && result->GetOwner() && result->GetDim()==2,"trim fixture has materialized owned UV curve");
    return result;
}
std::unique_ptr<SmCurve> copy(SmCurve& original) {
    SmCurve* raw=nullptr;
    require(original.Copy(*original.GetContext(),raw)==SM_SUCCESS && raw,"actual SDK trim copy");
    return std::unique_ptr<SmCurve>(raw);
}
void reverse(SmCurve& curve) {
    auto interval=curve.GetNaturalInterval();
    require(curve.ReverseParameterization(interval,interval)==SM_SUCCESS,"actual SDK trim reverse executes");
}
void positive(bool reuse) {
    auto owner=OwnedBoundary::box(2,3,4); auto& ledger=history(owner); auto& solid=body(owner);
    auto* original=trim(solid); const auto roots=owner.faces();
    Scope phase(ledger,*SmApiGetOrCreateContext(),&solid);
    RepresentationSeal seal(ledger,solid);
    NumericalReadTestAccess::begin(ledger,solid);
    std::array<uintptr_t,128> addresses{}; std::array<Identity,128> births{}; bool reused=false;
    for(unsigned i=0;i<(reuse?128u:1u);++i) {
        const auto first_event=ledger.event_size(); auto helper=copy(*original); ledger.check();
        Identity birth{};
        for(auto j=first_event;j<ledger.event_size();++j)
            if(ledger.event(j).operation==SM_NO_CONSTRUCTION) birth=ledger.event(j).after[0];
        require(birth.sequence,"copied trim gets an observed constructor generation");
        const auto address=reinterpret_cast<uintptr_t>(helper.get());
        for(unsigned j=0;j<i;++j) if(addresses[j]==address) {
            require(birth!=births[j] && birth.sequence>births[j].sequence,
                "reused helper address receives a fresh constructor generation");
            reused=true;
        }
        addresses[i]=address; births[i]=birth;
        helper->SetOwner(original->GetOwner()); reverse(*helper); ledger.check();
        helper.reset(); ledger.check();
        const auto& death=ledger.event(ledger.event_size()-1);
        require(death.operation==SM_NO_DESTRUCTION && death.before[0].sequence>=birth.sequence,
            "copied helper destruction retires its live generation");
    }
    require(!reuse || reused,"actual helper allocator reuse must be reached, never skipped");
    NumericalReadTestAccess::end(ledger); seal.verify(); ledger.verify_inventory(solid);
    require(owner.faces()==roots,"temporary trim edits preserve complete original face identities");
    phase.finish(); ledger.check();
}
void negative(const char* name) {
    auto owner=OwnedBoundary::box(2,3,4); auto sibling=owner.copy();
    auto& solid=body(owner); auto& ledger=history(owner);
    auto* original=trim(solid); auto* foreign=trim(body(sibling));
    Scope phase(ledger,*SmApiGetOrCreateContext(),&solid);
    NumericalReadTestAccess::begin(ledger,solid);
    if(std::strcmp(name,"original")==0) {
        reverse(*original);
        require(ledger.failed()!=Failure::None,"issued trim read still refuses original geometry edits");
    } else if(std::strcmp(name,"origin")==0) {
        auto helper=copy(*foreign); helper->SetOwner(original->GetOwner()); reverse(*helper);
        require(ledger.failed()!=Failure::None,"foreign constructor origin cannot borrow source trim authority");
    } else if(std::strcmp(name,"reuse-foreign")==0) {
        // Reuse actual object storage, not a probabilistic allocator bin. The
        // SDK base copy constructor and destructor emit the real notifications;
        // no callback replay or historical address is supplied to the ledger.
        alignas(SmBSplineCurve) unsigned char storage[sizeof(SmBSplineCurve)];
        auto destroy=[](SmBSplineCurve* curve) { curve->~SmBSplineCurve(); };
        using LocalCurve=std::unique_ptr<SmBSplineCurve,decltype(destroy)>;
        uintptr_t old=0;
        {
            LocalCurve helper(::new (static_cast<void*>(storage)) SmBSplineCurve(*original),destroy);
            ledger.check(); old=reinterpret_cast<uintptr_t>(helper.get());
        }
        ledger.check();
        LocalCurve unrelated(::new (static_cast<void*>(storage)) SmBSplineCurve(*foreign),destroy);
        ledger.check();
        const bool reused=reinterpret_cast<uintptr_t>(unrelated.get())==old;
        require(reused,"actual foreign-copy address reuse must be reached, never skipped");
        unrelated->SetOwner(original->GetOwner()); reverse(*unrelated);
        require(ledger.failed()!=Failure::None,"recycled helper address cannot authorize a foreign constructor");
    } else if(std::strcmp(name,"replacement")==0) {
        auto helper=copy(*original); helper->SetOwner(original->GetOwner());
        phase.finish();
        Scope replacement(ledger,*SmApiGetOrCreateContext(),&solid);
        reverse(*helper);
        require(ledger.failed()!=Failure::None,"same-depth replacement frame cannot replay helper authority");
    } else if(std::strcmp(name,"attached")==0) {
        auto helper=copy(*original); ledger.check();
        auto* use=static_cast<SmEdgeuse*>(original->GetOwner());
        // Actual SDK silent attachment, not a fake callback or owner-only edit.
        use->SetMemberUVTrimCurve(static_cast<SmBSplineCurve*>(helper.get()));
        ledger.check(); reverse(*helper);
        const bool refused=ledger.failed()!=Failure::None;
        // Restore valid fixture ownership for destruction, never the latch.
        use->SetMemberUVTrimCurve(original); helper.reset();
        require(refused,"observed copied helper loses authority when actually attached");
    } else if(std::strcmp(name,"owner")==0) {
        auto helper=copy(*original); helper->SetOwner(foreign->GetOwner()); reverse(*helper);
        require(ledger.failed()!=Failure::None,"authentic helper cannot edit under foreign ownership");
    } else if(std::strcmp(name,"leak")==0) {
        auto helper=copy(*original); ledger.check(); bool refused=false;
        try { NumericalReadTestAccess::end(ledger); } catch(const AdapterFailure&) { refused=true; }
        require(refused && ledger.failed()==Failure::UnknownHistory,
            "issued trim read refuses a surviving temporary generation");
    } else if(std::strcmp(name,"frame")==0) {
        auto helper=copy(*original); helper->SetOwner(original->GetOwner());
        Scope nested(ledger,*SmApiGetOrCreateContext()); reverse(*helper);
        require(ledger.failed()!=Failure::None,"helper authority cannot cross its issuing frame");
    } else throw std::runtime_error("unknown trim negative selector");
    const auto first=ledger.failure_origin();
    // Retirement and scope teardown cannot erase the original refusal.
    phase.finish();
    require(ledger.failure_origin().failure==first.failure && ledger.failure_origin().event==first.event,
        "trim failure remains latched through phase teardown");
}
void polygon_copy(const char* name) {
    // #7955 / 6e8c90bd: SetOriginalFace(TRUE) reports a real attributes-only
    // COPY from SmFace to SmPolyFace. It cannot issue BRep ancestry.
    auto owner=OwnedBoundary::box(2,3,4); auto sibling=owner.copy();
    auto& solid=body(owner); auto& ledger=history(owner); const auto roots=owner.faces();
    Scope phase(ledger,*SmApiGetOrCreateContext(),&solid);
    RepresentationSeal seal(ledger,solid);
    if(std::strcmp(name,"poly-outside")==0) NumericalReadTestAccess::begin(ledger,solid);
    else NumericalReadTestAccess::tessellation(ledger,solid);
    auto internal=std::unique_ptr<SmBrep>(new (*solid.GetContext()) SmBrep(solid));
    ledger.check();
    SmTArray<SmFace*> faces;
    (std::strcmp(name,"poly-foreign")==0?body(sibling):*internal).GetFaces(faces);
    require(faces.GetSize()>0,"polygon fixture has an actual face");
    auto* original=faces[0];
    const auto before=ledger.identity(original);
    auto polygon=std::unique_ptr<SmPolyBrep>(new (*solid.GetContext()) SmPolyBrep(solid.GetTolerance()));
    auto* polyface=new (polygon.get()) SmPolyFace(solid.GetTolerance(),polygon.get(),nullptr,nullptr);
    const auto first=ledger.event_size(); polyface->SetOriginalFace(original,TRUE);
    if(std::strcmp(name,"poly-positive")==0) {
        require(ledger.failed()==Failure::None,"polygon attribute copy preserves actual face identity");
        require(ledger.event_size()==first+1 && ledger.event(first).before[0]==before &&
            !ledger.event(first).after[0].sequence && ledger.identity(original)==before,
            "polygon attribute receipt never issues face ancestry");
        polygon.reset(); internal.reset(); ledger.check(); NumericalReadTestAccess::end(ledger);
        seal.verify(); require(owner.faces()==roots,"polygon propagation preserves source roots");
    } else require(ledger.failed()!=Failure::None,"polygon copy requires current owned tessellation phase");
    phase.finish();
}
void internal_copy(const char* name) {
    // #7955 / observation 7f2d7e07: the actual tessellator copies the BRep,
    // then copies an attached trim of that copy before reversing the helper.
    auto owner=OwnedBoundary::box(2,3,4); auto sibling=owner.copy();
    auto& solid=body(owner); auto& ledger=history(owner);
    auto* original=trim(solid); auto* foreign=trim(body(sibling));
    const auto roots=owner.faces();
    const bool unobserved=std::strcmp(name,"internal-unobserved")==0;
    SmCopyBrepMap actual_map;
    std::unique_ptr<SmBrep> internal;
    if(unobserved) internal.reset(new (*solid.GetContext()) SmBrep(solid,&actual_map));
    ledger.check();
    Scope phase(ledger,*SmApiGetOrCreateContext(),&solid);
    RepresentationSeal seal(ledger,solid);
    NumericalReadTestAccess::tessellation(ledger,solid);
    if(!unobserved) internal.reset(new (*solid.GetContext()) SmBrep(
        std::strcmp(name,"internal-foreign")==0?body(sibling):solid,&actual_map));
    ledger.check(); auto* copied=trim(*internal);
    if(std::strcmp(name,"internal-original")==0 || std::strcmp(name,"internal-backlink")==0) {
        auto* installed_owner=copied->GetOwner();
        if(std::strcmp(name,"internal-backlink")==0) {
            // Consume the SDK-produced topology map, never face/edge ordering.
            auto* input_owner=actual_map.GetAt(static_cast<SmEdgeuse*>(installed_owner));
            require(input_owner && input_owner->GetType()==SmEdgeuse_TYPE,"actual copy map names original trim owner");
            copied->SetOwner(input_owner);
        }
        reverse(*copied);
        copied->SetOwner(installed_owner);
        require(ledger.failed()!=Failure::None,"internal attached original still refuses edits");
    } else {
        const auto first=ledger.event_size(); auto helper=copy(*copied); ledger.check();
        if(std::strcmp(name,"internal-positive")==0) {
            Identity birth{};
            for(auto i=first;i<ledger.event_size();++i)
                if(ledger.event(i).operation==SM_NO_CONSTRUCTION) birth=ledger.event(i).after[0];
            require(birth.sequence,"internal trim helper requires actual two-generation issuance");
        }
        helper->SetOwner(std::strcmp(name,"internal-owner")==0?foreign->GetOwner():copied->GetOwner());
        if(std::strcmp(name,"internal-attached")==0) {
            auto* use=static_cast<SmEdgeuse*>(copied->GetOwner());
            use->SetMemberUVTrimCurve(static_cast<SmBSplineCurve*>(helper.get()));
            reverse(*helper); const bool refused=ledger.failed()!=Failure::None;
            use->SetMemberUVTrimCurve(copied);
            require(refused,"internal helper cannot replace its attached original");
        } else {
            reverse(*helper);
            if(std::strcmp(name,"internal-positive")==0) ledger.check();
            else require(ledger.failed()!=Failure::None,"internal helper requires current copy and exact owner authority");
        }
    }
    internal.reset();
    if(std::strcmp(name,"internal-positive")==0) {
        ledger.check(); NumericalReadTestAccess::end(ledger); seal.verify();
        require(owner.faces()==roots && original==trim(solid),"internal trim lifecycle preserves input roots and trim ownership");
    }
    phase.finish();
}
}
void run_numerical_trim_case(const char* name) {
    if(std::strncmp(name,"poly-",5)==0) polygon_copy(name);
    else if(std::strncmp(name,"internal-",9)==0) internal_copy(name);
    else if(std::strcmp(name,"positive")==0) positive(false);
    else if(std::strcmp(name,"reuse")==0) positive(true);
    else negative(name);
}
