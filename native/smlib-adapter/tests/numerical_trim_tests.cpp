// SPDX-License-Identifier: MPL-2.0
// #7955: real SDK copy constructors, edits, destruction and allocator reuse.
#include "owned_lineage_access.hpp"
#include "representation_seal.hpp"
#include "failure.hpp"
#include "edge_subdivision.hpp"
#include "planar_transition_detail.hpp"
#include "context_metadata.hpp"
#include <SmEdge.h>
#include <SmApiGeneral.h>
#include <SmBSplineCurve.h>
#include <SmCopyBrepMap.h>
#include <SmEdgeuse.h>
#include <SmFace.h>
#include <SmPoly.h>
#include <SmCone.h>
#include <SmSurfOfExtrusion.h>
#include <array>
#include <cstring>
#include <cstdio>
#include <memory>
#include <new>
#include <stdexcept>
namespace face_lineage {
// Test-only access to the fixed calls' private phase. No runtime callable seam.
struct SubdivisionTestAccess {
    static void finish(Ledger& ledger) { ledger.subdivision->finish(); }
};
struct NumericalReadTestAccess {
    static void begin(Ledger& ledger,SmBrep& source) { NumericalRead::begin(ledger,source); }
    static void tessellation(Ledger& ledger,SmBrep& source) { NumericalRead::begin_tessellation(ledger,source); }
    static void end(Ledger& ledger) { NumericalRead::end(ledger); }
    static void release(Ledger& ledger,SmPolyBrep* output=nullptr) { NumericalRead::release_tessellation_history(ledger,output); }
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
void planar_coefficients(bool positive) {
    // #7955 / r6: real linear UV representation, fixed acceptance boundary.
    // The observed -2*epsilon residue is data; it never sets the policy bound.
    SmBSplineCurve* raw=nullptr;
    require(SmBSplineCurve::CreateLineSegment(*SmApiGetOrCreateContext(),2,
        SmPoint3d(0,0,0),SmPoint3d(2,0,0),raw)==SM_SUCCESS && raw,"actual planar coefficient fixture");
    std::unique_ptr<SmBSplineCurve> line(raw);
    ULONG n=0; double* p=nullptr;
    require(line->GetControlPointsPointer(n,p)==SM_SUCCESS && n==2 && p,"actual planar coefficient support");
    const double eps=std::numeric_limits<double>::epsilon();
    const double bound=8*eps; // independent fixed contract, not the helper's return
    for(double residue:positive?std::array<double,2>{-2*eps,-bound}:
        std::array<double,2>{std::nextafter(bound,INFINITY),std::nextafter(-bound,-INFINITY)}) {
        p[5]=residue; const auto controls=planar_detail::linear(*line,2); bool refused=false;
        try { planar_detail::correspondence(controls[1],SmPoint3d(2,0,0)); }
        catch(const AdapterFailure& e) { refused=e.status==IFCLITE_SMLIB_UNSUPPORTED; }
        require(refused!=positive,positive?"planar correspondence accepts fixed rounding budget":
            "planar correspondence refuses the first value beyond fixed budget");
    }
    if(!positive) {
        // Neither a large unrelated coordinate nor nonfinite input may enlarge
        // the allowance for this zero-valued component.
        require(!planar_detail::coefficient_point(SmPoint3d(1e12,2*bound,0),SmPoint3d(1e12,0,0)) &&
            !planar_detail::coefficient(INFINITY,INFINITY) &&
            !planar_detail::coefficient(std::numeric_limits<double>::quiet_NaN(),0),
            "planar correspondence keeps component scale and finite guards");
    }
}
void planar_intervals(bool positive) {
    // #7955: the original rectangle can have a non-unit parameterization;
    // a parameter mismatch must still refuse even when endpoints coincide.
    auto* context=SmApiGetOrCreateContext(); SmBSplineCurve *a=nullptr,*b=nullptr;
    require(SmBSplineCurve::CreateLineSegment(*context,2,SmPoint3d(0,0,0),SmPoint3d(2,0,0),a)==SM_SUCCESS && a,
        "actual parameter UV fixture");
    std::unique_ptr<SmBSplineCurve> uv(a);
    require(SmBSplineCurve::CreateLineSegment(*context,3,SmPoint3d(0,0,0),SmPoint3d(0,2,0),b)==SM_SUCCESS && b,
        "actual parameter 3D fixture");
    std::unique_ptr<SmBSplineCurve> edge(b);
    const SmExtent1d domain(0,2);
    require(edge->EditParameterization(domain)==SM_SUCCESS && uv->EditParameterization(domain)==SM_SUCCESS,
        "actual matching non-unit parameterization");
    if(!positive) require(uv->EditParameterization(SmExtent1d(0,1))==SM_SUCCESS,"actual mismatched UV parameterization");
    bool refused=false;
    try { planar_detail::common_interval(domain,uv->GetNaturalInterval(),edge->GetNaturalInterval()); }
    catch(const AdapterFailure& e) { refused=e.status==IFCLITE_SMLIB_UNSUPPORTED; }
    require(refused!=positive,positive?"planar original intervals need not be unit length":
        "planar interval correspondence rejects a mismatched UV domain");
}
void polygon_journal() {
    // #7955/r10: actual UV scratch destruction and final 3D SetOriginalFace
    // callbacks, as in SmTess::Phase3DeleteFacePolygons and ConvertToPolyBrep.
    // No synthetic receipt/map: FALSE performs the SDK's real silent backlink
    // edit, which must not manufacture the missing callback or replace its root.
    for(unsigned fault=0;fault<4;++fault) {
        auto owner=OwnedBoundary::box(2,3,4); auto& solid=body(owner); auto& ledger=history(owner);
        Scope phase(ledger,*SmApiGetOrCreateContext(),&solid); RepresentationSeal seal(ledger,solid);
        const auto nodes=ledger.node_size(),events=ledger.event_size(); const auto roots=owner.faces();
        NumericalReadTestAccess::tessellation(ledger,solid);
        SmCopyBrepMap map; auto internal=std::unique_ptr<SmBrep>(new (*solid.GetContext()) SmBrep(solid,&map));
        SmTArray<SmFace*> faces; internal->GetFaces(faces); ledger.check();
        require(faces.GetSize()==6,"polygon journal has genuine internal copy faces");
        auto* copied=faces[0]; auto* input=static_cast<SmFace*>(map.GetAt(copied));
        require(input && input->GetBrep()==&solid,"polygon journal uses the actual SDK copy map");
        auto make_poly=[&] { return std::unique_ptr<SmPolyBrep>(new (*solid.GetContext()) SmPolyBrep(solid.GetTolerance())); };
        auto scratch=make_poly(),output=make_poly();
        auto* uv=new (scratch.get()) SmPolyFace(solid.GetTolerance(),scratch.get(),nullptr,nullptr);
        uv->SetOriginalFace(copied,TRUE);
        auto* polygon=new (output.get()) SmPolyFace(solid.GetTolerance(),output.get(),nullptr,nullptr);
        if(fault!=2) polygon->SetOriginalFace(copied,TRUE);
        polygon->SetOriginalFace(input,fault==1 || fault==2?FALSE:TRUE);
        ledger.check();
        if(fault==3) {
            SmTArray<SmFace*> originals; solid.GetFaces(originals);
            auto* wrong=originals[0]==input?originals[1]:originals[0];
            polygon->SetOriginalFace(wrong,FALSE);
        }
        scratch.reset(); internal.reset(); ledger.check(); NumericalReadTestAccess::end(ledger);
        seal.verify(); ledger.verify_inventory(solid);
        bool refused=false; const char* reason=nullptr;
        try { NumericalReadTestAccess::release(ledger,output.get()); }
        catch(const AdapterFailure& e) { refused=e.status==IFCLITE_SMLIB_UNSUPPORTED; reason=e.message; }
        const char* marker=fault==0?"polygon journal releases deleted UV scratch after checked final output":
            fault==1?"polygon journal refuses a missing final rebind callback":
            fault==2?"polygon journal refuses an output without an attribute receipt":
                     "polygon journal refuses a silently changed final original";
        require(refused==(fault!=0),marker);
        if(fault) {
            const char* expected=fault==1?"returned polygon has no matching final rebind":
                fault==2?"returned polygon has no attribute receipt":"returned polygon original differs from its checked rebind";
            require(reason && std::strcmp(reason,expected)==0 && ledger.node_size()>nodes && ledger.failed()==Failure::None,
                "polygon journal negative reaches its intended output guard without reclaiming");
        } else require(ledger.node_size()==nodes && ledger.event_size()==events && owner.faces()==roots,
            "polygon journal preserves persistent roots and storage checkpoint");
        output.reset(); phase.finish();
    }
}
void read_journal() {
    // #7955: actual constructor/destructor lifetimes, never a fabricated map.
    // Reuse bounded storage across completed reads without recycling identity.
    auto owner=OwnedBoundary::box(2,3,4); auto& solid=body(owner); auto& ledger=history(owner);
    const auto roots=owner.faces(); Identity retired{};
    Scope phase(ledger,*SmApiGetOrCreateContext(),&solid); RepresentationSeal seal(ledger,solid);
    const auto nodes=ledger.node_size(),events=ledger.event_size();
    for(unsigned read=0;read<20;++read) {
        NumericalReadTestAccess::tessellation(ledger,solid);
        SmCopyBrepMap map; auto internal=std::unique_ptr<SmBrep>(new (*solid.GetContext()) SmBrep(solid,&map));
        ledger.check(); SmTArray<SmFace*> faces; internal->GetFaces(faces);
        require(faces.GetSize()==6,"actual temporary read face inventory");
        const auto current=ledger.identity(faces[0]);
        if(retired.sequence) {
            bool refused=false; std::array<Root,6> out;
            try { ledger.roots(retired,out.data(),out.size()); } catch(const AdapterFailure&) { refused=true; }
            require(refused && current.sequence>retired.sequence && current!=retired,
                "reclaimed journal storage never reissues a retired generation");
        }
        // A refund cannot conceal a surviving actual copy or an unfinished phase.
        bool refused=false;
        try { NumericalReadTestAccess::release(ledger); } catch(const AdapterFailure&) { refused=true; }
        require(refused && ledger.failed()==Failure::None && ledger.identity(faces[0])==current,
            "unfinished numerical reads cannot release live history");
        auto helper=copy(*trim(*internal)); helper->SetOwner(trim(*internal)->GetOwner()); reverse(*helper);
        helper.reset(); internal.reset(); ledger.check(); NumericalReadTestAccess::end(ledger); seal.verify();
        auto escaped=raw_context::construct_brep(solid.GetContext()); ledger.check();
        refused=false;
        try { NumericalReadTestAccess::release(ledger); } catch(const AdapterFailure&) { refused=true; }
        require(refused && ledger.failed()==Failure::None,"journal release refuses a live escaped constructor generation");
        escaped.reset(); ledger.check(); seal.verify();
        NumericalReadTestAccess::release(ledger);
        require(ledger.node_size()==nodes && ledger.event_size()==events && owner.faces()==roots,
            "completed numerical reads release only temporary journal");
        retired=current;
    }
    auto sibling=owner.copy();
    for(auto id:sibling.faces()) require(sibling.ancestors(id).size()==1,"persistent ancestry remains valid across sequence gaps");
    phase.finish();
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
    SmCopyBrepMap actual_map;
    auto internal=std::unique_ptr<SmBrep>(new (*solid.GetContext()) SmBrep(solid,&actual_map));
    ledger.check();
    SmTArray<SmFace*> faces;
    (std::strcmp(name,"poly-foreign")==0?body(sibling):*internal).GetFaces(faces);
    require(faces.GetSize()>0,"polygon fixture has an actual face");
    auto* original=faces[0];
    const auto before=ledger.identity(original);
    auto polygon=std::unique_ptr<SmPolyBrep>(new (*solid.GetContext()) SmPolyBrep(solid.GetTolerance()));
    auto* polyface=new (polygon.get()) SmPolyFace(solid.GetTolerance(),polygon.get(),nullptr,nullptr);
    const auto first=ledger.event_size(); polyface->SetOriginalFace(original,TRUE);
    const bool rebind=std::strcmp(name,"poly-rebind")==0 || std::strcmp(name,"poly-wrong-root")==0;
    if(rebind) {
        ledger.check(); auto* input=static_cast<SmFace*>(actual_map.GetAt(original));
        require(input && input->GetBrep()==&solid,"polygon rebind consumes actual SDK copy map");
        if(std::strcmp(name,"poly-wrong-root")==0) {
            SmTArray<SmFace*> source_faces; solid.GetFaces(source_faces);
            for(auto* candidate:source_faces) if(candidate!=input) { input=candidate; break; }
        }
        const auto input_id=ledger.identity(input); polyface->SetOriginalFace(input,TRUE);
        if(std::strcmp(name,"poly-wrong-root")==0) {
            require(ledger.failed()!=Failure::None,"polygon rebind refuses a different original root"); phase.finish(); return;
        }
        require(ledger.failed()==Failure::None && ledger.event(first+1).before[0]==input_id &&
            !ledger.event(first+1).after[0].sequence,"polygon final rebind matches its observed copy ancestor");
    }
    if(std::strcmp(name,"poly-positive")==0 || rebind) {
        require(ledger.failed()==Failure::None,"polygon attribute copy preserves actual face identity");
        require(ledger.event_size()==first+(rebind?2:1) && ledger.event(first).before[0]==before &&
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
// Fault injector wraps genuine SDK notifications. It never constructs a map or
// substitutes a success result. Only negative witnesses use this slot seam.
struct ExtrusionFaultAccess:SmSurfOfExtrusion {
    static void vector(SmSurfOfExtrusion& surface,const SmVector3d& value) {
        surface.*(&ExtrusionFaultAccess::m_vExtrusionVec)=value;
    }
};
struct SplitFault:SmNotifyCallback {
    SmContext& context; SmNotifyCallback* observer; Ledger& ledger; const char* mode;
    SmEdge* edge=nullptr; unsigned faults=0; bool healthy_before_fault=false;
    SmCone* changed_surface=nullptr; double saved_radius=0;
    SmSurfOfExtrusion* changed_extrusion=nullptr; SmVector3d saved_vector;
    SplitFault(SmContext& c,Ledger& l,const char* m):context(c),observer(c.GetUserNotifyCallback()),ledger(l),mode(m) { context.SetUserNotifyCallback(this); }
    ~SplitFault() {
        context.SetUserNotifyCallback(observer);
        if(changed_surface) changed_surface->SetBaseRadius(saved_radius); // cleanup, never clear the refusal
        if(changed_extrusion) ExtrusionFaultAccess::vector(*changed_extrusion,saved_vector);
    }
    SmStatus Execute(SmNotifyOperation op,SmObject* caller,SmObject* a,SmObject* b,SmObject* c) noexcept override {
        if(op==SM_NO_PRE_EDIT && caller && caller->GetType()==SmEdge_TYPE) edge=static_cast<SmEdge*>(caller);
        if(op==SM_NO_SPLIT_IN_BREP && edge && a==edge && std::strcmp(mode,"split-missing")==0) { healthy_before_fault=ledger.failed()==Failure::None; ++faults; return SM_SUCCESS; }
        if(op==SM_NO_ADD_TO_BREP && edge && !faults) {
            healthy_before_fault=ledger.failed()==Failure::None;
            if(std::strcmp(mode,"split-curve")==0) {
                ULONG n=0; double* controls=nullptr;
                if(static_cast<SmBSplineCurve*>(edge->GetCurve())->GetControlPointsPointer(n,controls)==SM_SUCCESS && n && controls) {
                    controls[0]+=.125; ++faults;
                }
            } else if(std::strcmp(mode,"split-interval")==0) {
                auto interval=edge->GetInterval(); interval.SetMinMax(interval.GetMin(),interval.GetMax()+.125);
                edge->SetInterval(interval); ++faults;
            } else if(std::strcmp(mode,"split-extrusion-surface")==0) {
                SmTArray<SmFace*> incident; edge->GetFaces(incident);
                for(auto* face:incident) if(face->GetSurface()->GetType()==SmSurfOfExtrusion_TYPE) {
                    changed_extrusion=static_cast<SmSurfOfExtrusion*>(face->GetSurface());
                    saved_vector=changed_extrusion->GetExtrusionVector(); auto changed=saved_vector; changed.x+=.125;
                    ExtrusionFaultAccess::vector(*changed_extrusion,changed); ++faults; break;
                }
            } else if(std::strcmp(mode,"split-surface")==0) {
                SmTArray<SmFace*> incident; edge->GetFaces(incident);
                for(auto* face:incident) if(face->GetSurface()->GetType()==SmCone_TYPE) {
                    auto* cone=static_cast<SmCone*>(face->GetSurface());
                    SmAxis2Placement frame; double angle=0;
                    if(cone->GetCanonical(frame,saved_radius,angle)==SM_SUCCESS) {
                        changed_surface=cone; cone->SetBaseRadius(saved_radius+.125); ++faults;
                    }
                    break;
                }
            }
        }
        context.SetUserNotifyCallback(observer);
        const auto status=observer->Execute(op,caller,a,b,c);
        context.SetUserNotifyCallback(this); return status;
    }
};
void subdivision(const char* name) {
    const bool extrusion=std::strncmp(name,"split-extrusion",15)==0;
    auto source=OwnedBoundary::cylinder(2,3);
    const std::array<double,16> scale{2,0,0,0,0,3,0,0,0,0,4,0,7,-4,2,1};
    auto owner=extrusion?source.affine(scale.data()):std::move(source); auto& solid=body(owner); auto& ledger=history(owner);
    const auto roots=owner.faces(); Scope phase(ledger,*SmApiGetOrCreateContext(),&solid);
    RepresentationSeal seal(ledger,solid); NumericalReadTestAccess::tessellation(ledger,solid);
    SmCopyBrepMap map;
    auto internal=std::unique_ptr<SmBrep>(new (*solid.GetContext()) SmBrep(solid,&map)); ledger.check();
    SmTArray<SmEdge*> edges; internal->GetEdges(edges); SmEdge* edge=nullptr;
    for(auto* candidate:edges) {
        auto interval=candidate->GetInterval();
        if(interval.GetMax()-interval.GetMin()>6 && candidate->GetEdgeuseCount()==4) { edge=candidate; break; }
    }
    require(edge,"subdivision fixture has a real curved four-use edge");
    if(extrusion) {
        SmTArray<SmFace*> incident; edge->GetFaces(incident); bool found=false;
        for(auto* face:incident) found|=face->GetSurface()->GetType()==SmSurfOfExtrusion_TYPE;
        require(found,"affine subdivision fixture reaches actual SDK extrusion recognition");
    }
    auto interval=edge->GetInterval(); double cut=interval.GetMin()+(interval.GetMax()-interval.GetMin())/64;
    double existing_knot=0;
    const bool knot_case=std::strcmp(name,"split-knot")==0 || std::strcmp(name,"split-knot-outside")==0;
    if(knot_case) {
        auto* curve=static_cast<SmBSplineCurve*>(edge->GetCurve()); const auto count=curve->GetNumberNaturalKnots();
        require(count && count<=65536,"bounded actual curved knot fixture");
        std::array<double,65536> knots{};
        require(curve->GetKnotsExpert(0,count-1,knots.data())==SM_SUCCESS,"actual curved knot getter");
        bool found=false; double knot=0;
        for(ULONG i=0;i<count;++i) if(knots[i]>interval.GetMin() && knots[i]<interval.GetMax()) { knot=knots[i]; found=true; break; }
        require(found,"curved split fixture has an existing interior knot");
        existing_knot=knot;
        if(std::strcmp(name,"split-knot")==0) cut=std::nextafter(std::nextafter(knot,INFINITY),INFINITY);
        else {
            const double eps=std::numeric_limits<double>::epsilon();
            cut=knot+8*eps*std::max(1.,std::abs(knot));
            // Independently choose the FIRST representable request above the
            // fixed bound. Do not call the production predicate (a mutant may
            // remove it). This remains far inside the SDK's wider snap zone.
            unsigned moves=0;
            while(cut-knot<=8*eps*std::max(1.,std::abs(cut)) && moves++<16) cut=std::nextafter(cut,INFINITY);
            require(moves<16 && cut<interval.GetMax(),"bounded first-outside parameter fixture");
        }
    }
    SmEdge *one=nullptr,*two=nullptr; SmVertex* vertex=nullptr; SmStatus status; unsigned faults=0; bool healthy_before_fault=false;
    const auto first=ledger.event_size();
    {
        std::unique_ptr<Scope> nested;
        if(std::strcmp(name,"split-frame")==0) nested=std::make_unique<Scope>(ledger,*SmApiGetOrCreateContext());
        SplitFault fault(*SmApiGetOrCreateContext(),ledger,name);
        status=internal->MakeVertexSplitEdge(edge,cut,one,two,vertex); faults=fault.faults; healthy_before_fault=fault.healthy_before_fault;
    }
    require(status==SM_SUCCESS && one==edge && two && vertex,"actual SDK subdivision status and outputs");
    if(knot_case) {
        const auto a=one->GetInterval(),b=two->GetInterval();
        const bool same=a.GetMin()==interval.GetMin();
        require(cut!=existing_knot && (same?a.GetMax():a.GetMin())==existing_knot &&
            (same?b.GetMin():b.GetMax())==existing_knot,"actual SDK knot snap reached in both restriction outputs");
    }
    // Preserve the real first failure in every witness, including positive.
    // Reporting is read-only; only the assertion below decides acceptance.
    if(ledger.failed()!=Failure::None) try { ledger.check(); }
    catch(const AdapterFailure& error) {
        std::fprintf(stderr,"subdivision witness first refusal status=%d reason=%s\n",error.status,error.message);
    }
    if(std::strcmp(name,"split-positive")==0 || std::strcmp(name,"split-extrusion")==0 || std::strcmp(name,"split-knot")==0) {
        require(ledger.failed()==Failure::None,"checked subdivision accepts genuine restriction receipts");
        bool receipt=false;
        for(auto i=first;i<ledger.event_size();++i) if(ledger.event(i).operation==SM_NO_SPLIT_IN_BREP) {
            const auto& e=ledger.event(i); receipt=e.before[0].sequence && e.after[0]==e.before[0] &&
                e.after[1].sequence && e.after[1]!=e.after[0];
        }
        require(receipt,"subdivision receipt carries distinct observed edge generations");
        SubdivisionTestAccess::finish(ledger);
        // Verify that a real installed child UV can be the origin of a later
        // numerical helper without permitting edits to that installed child.
        SmTArray<SmEdgeuse*> uses; two->GetEdgeuses(uses);
        for(auto* use:uses) if(auto* uv=use->GetUVTrimCurvePointer()) {
            auto helper=copy(*uv); helper->SetOwner(uv->GetOwner()); reverse(*helper); ledger.check();
        }
        internal.reset(); ledger.check(); NumericalReadTestAccess::end(ledger); seal.verify();
        require(owner.faces()==roots,"subdivision preserves input face identities and representation");
    } else if(std::strcmp(name,"split-knot-outside")==0) {
        require(!faults && ledger.failed()==Failure::UnsupportedGeometryChange &&
            ledger.failure_origin().operation==SM_NO_SPLIT && ledger.failure_origin().caller_type==SmBSplineCurve_TYPE,
            "subdivision refuses the first request beyond fixed knot rounding budget");
    } else {
        require(faults==(std::strcmp(name,"split-frame")==0?0u:1u),"subdivision negative reaches its actual SDK mutation point");
        if(std::strcmp(name,"split-frame")!=0)
            require(healthy_before_fault,"subdivision fault witness requires healthy setup before its intended fault");
        else require(ledger.failed()==Failure::None ||
            (ledger.failure_origin().operation==SM_NO_PRE_EDIT && ledger.failure_origin().caller_type==SmEdge_TYPE &&
             ledger.failure_origin().event==first+1),"subdivision frame witness reaches the first real edge edit");
        bool rejected=ledger.failed()!=Failure::None;
        if(std::strcmp(name,"split-missing")==0) {
            try { SubdivisionTestAccess::finish(ledger); } catch(const AdapterFailure&) { rejected=true; }
        }
        require(rejected,"subdivision rejects changed geometry intervals or missing completion");
    }
    phase.finish();
}

}
void run_numerical_trim_case(const char* name) {
    if(std::strcmp(name,"journal")==0) { read_journal(); polygon_journal(); }
    else if(std::strcmp(name,"planar-rounding")==0) planar_coefficients(true);
    else if(std::strcmp(name,"planar-outside")==0) planar_coefficients(false);
    else if(std::strcmp(name,"planar-domain")==0) planar_intervals(true);
    else if(std::strcmp(name,"planar-domain-mismatch")==0) planar_intervals(false);
    else if(std::strncmp(name,"split-",6)==0) {
        subdivision(name);
        if(std::strcmp(name,"split-positive")==0) subdivision("split-extrusion");
        if(std::strcmp(name,"split-surface")==0) subdivision("split-extrusion-surface");
    }
    else if(std::strncmp(name,"poly-",5)==0) polygon_copy(name);
    else if(std::strncmp(name,"internal-",9)==0) internal_copy(name);
    else if(std::strcmp(name,"positive")==0) positive(false);
    else if(std::strcmp(name,"reuse")==0) positive(true);
    else negative(name);
}
