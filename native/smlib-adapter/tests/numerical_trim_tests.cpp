// SPDX-License-Identifier: MPL-2.0
// #7955: real SDK copy constructors, edits, destruction and allocator reuse.
#include "owned_lineage_access.hpp"
#include "representation_seal.hpp"
#include "failure.hpp"
#include <SmApiGeneral.h>
#include <SmBSplineCurve.h>
#include <SmEdgeuse.h>
#include <SmFace.h>
#include <array>
#include <cstring>
#include <memory>
#include <stdexcept>
namespace face_lineage {
// Test-only access to the fixed calls' private phase. No runtime callable seam.
struct NumericalReadTestAccess {
    static void begin(Ledger& ledger,SmBrep& source) { NumericalRead::begin(ledger,source); }
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
        auto helper=copy(*original); ledger.check(); const auto old=reinterpret_cast<uintptr_t>(helper.get());
        helper.reset(); ledger.check(); bool reused=false;
        for(unsigned i=0;i<128 && !reused;++i) {
            auto unrelated=copy(*foreign); ledger.check();
            if(reinterpret_cast<uintptr_t>(unrelated.get())!=old) continue;
            reused=true; unrelated->SetOwner(original->GetOwner()); reverse(*unrelated);
            require(ledger.failed()!=Failure::None,"recycled helper address cannot authorize a foreign constructor");
        }
        require(reused,"actual foreign-copy address reuse must be reached, never skipped");
    } else if(std::strcmp(name,"replacement")==0) {
        auto helper=copy(*original); helper->SetOwner(original->GetOwner());
        phase.finish();
        Scope replacement(ledger,*SmApiGetOrCreateContext(),&solid);
        reverse(*helper);
        require(ledger.failed()!=Failure::None,"same-depth replacement frame cannot replay helper authority");
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
}
void run_numerical_trim_case(const char* name) {
    if(std::strcmp(name,"positive")==0) positive(false);
    else if(std::strcmp(name,"reuse")==0) positive(true);
    else negative(name);
}
