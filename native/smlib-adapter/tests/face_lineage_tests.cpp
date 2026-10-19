// SPDX-License-Identifier: MPL-2.0
// Actual SDK event/ownership invariants. UNRUN; not paired qualification.
#include "face_lineage.hpp"
#include "copy.hpp"
#include "sweep.hpp"
#include "context_metadata.hpp"
#include "representation_seal.hpp"
#include "ifclite_smlib.h"
#include <SmApiGeneral.h>
#include <SmApiPrimitives.h>
#include <SmApiQueries.h>
#include <SmEdge.h>
#include <SmFace.h>
#include <SmLine.h>
#include <SmMerge.h>
#include <SmPlane.h>
#include <SmVertex.h>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <vector>
namespace {
using namespace face_lineage;
// Expose the real SDK face ctor/dtor for allocation-only invariants. No
// geometry, notification implementation or allocator is replaced.
class FixtureFace final:public SmFace {
public:
    FixtureFace()=default;
    ~FixtureFace() override=default;
};
class FixtureVertex final:public SmVertex {
public:
    FixtureVertex()=default;
    ~FixtureVertex() override=default;
};
void require(bool value,const char* message) { if(!value) throw std::runtime_error(message); }
bool bits(double a,double b) { return std::memcmp(&a,&b,sizeof(a))==0; }
struct Solids {
    std::unique_ptr<SmBrep> source,first,second,third;
    ~Solids() { if(kernel_domain_is_tainted()) { source.release(); first.release(); second.release(); third.release(); } }
};
std::unique_ptr<SmBrep> box() {
    SmBrep* raw=nullptr;
    try {
        require(SmApiCreateBox(SmVector3d(0,0,0),2,2,2,raw)==SM_SUCCESS && raw,"actual SDK box source");
        return std::unique_ptr<SmBrep>(raw);
    } catch(...) { rethrow_tainted_kernel_domain("lineage fixture construction"); }
}
std::vector<Seed> seeds(SmBrep& source) {
    SmTArray<SmFace*> faces; source.GetFaces(faces);
    std::vector<Seed> result; for(auto* f:faces) result.push_back({f,RootKind::SourceBoundary});
    return result;
}
void admit(Ledger& ledger,SmBrep& source) {
    const auto actual=seeds(source);
    // Test issuance: actual object revision, not STEP face authorship or an
    // input-provided certificate. Ledger issues each face's opaque identity.
    ledger.admit_roots(source,ObjectRevision{901,41,7,3,14,0},actual.data(),actual.size());
}
Root single(Ledger& ledger,Identity id) {
    std::array<Root,16> roots{};
    require(ledger.roots(id,roots.data(),roots.size())==1,"one deduplicated source origin");
    return roots[0];
}
class Foreign final:public SmNotifyCallback {
public:
    unsigned calls=0;
    bool refuse=false,throws=false;
    bool constructor_fault=false;
    SmVertex* nested_vertex=nullptr;
    SmFace* hidden_mutation=nullptr;
    unsigned hidden_changes=0;
    SmNotifyCallback* replacement=nullptr;
    SmStatus Execute(SmNotifyOperation op,SmObject* object,SmObject*,SmObject*,SmObject*) override {
        ++calls;
        if(op==SM_NO_CONSTRUCTION && nested_vertex) {
            auto* vertex=nested_vertex; nested_vertex=nullptr;
            vertex->SetPoint(vertex->GetPoint()); // Actual setter, identical bits.
        }
        if(op==SM_NO_CONSTRUCTION && hidden_mutation) {
            const auto original=hidden_mutation->GetUVDomain();
            hidden_mutation->SetUVDomain(SmExtent2d(original.GetUMin(),original.GetVMin(),original.GetUMax()*0.75,original.GetVMax()));
            hidden_mutation->SetUVDomain(original); ++hidden_changes;
            // Two real silent writes, restored before returning SUCCESS.
            // Equal pre/post representations cannot prove these never happened.
        }
        if(constructor_fault && op==SM_NO_CONSTRUCTION) {
            if(throws) throw std::runtime_error("foreign constructor callback injection");
            if(refuse) return SM_ERR;
        }
        if(op==SM_NO_CONSTRUCTION && replacement) {
            const_cast<SmContext*>(object->GetContext())->SetUserNotifyCallback(replacement);
            replacement=nullptr;
        }
        if(op==SM_NO_COPY && object->GetType()==SmFace_TYPE) {
            if(throws) throw std::runtime_error("foreign callback fault injection");
            if(refuse) return SM_ERR;
        }
        return SM_SUCCESS;
    }
};
struct ForeignSlot {
    SmContext& context;
    SmNotifyCallback* previous;
    ForeignSlot(SmContext& ctx,SmNotifyCallback& callback):context(ctx),previous(ctx.GetUserNotifyCallback()) {
        context.SetUserNotifyCallback(&callback);
    }
    ~ForeignSlot() { context.SetUserNotifyCallback(previous); }
};
void direct_read_refusal() {
    std::fprintf(stderr,"lineage BEGIN direct unaudited numerical read remains refused\n");
    Solids owned; owned.source=box(); auto& context=*const_cast<SmContext*>(owned.source->GetContext());
    Ledger ledger; Scope lifetime(ledger,context); admit(ledger,*owned.source);
    Scope phase(ledger,context); double volume=0;
    const auto status=SmApiBrepComputeVolume(owned.source.get(),1e-8,volume);
    const auto origin=ledger.failure_origin();
    require(status==SM_SUCCESS && ledger.failed()==Failure::UnsupportedGeometryChange &&
        origin.operation==SM_NO_PRE_EDIT && origin.caller_type==SmBSplineCurve_TYPE,
        "direct SDK property query still refuses an unissued transient numerical edit");
    // Completed observation-only negative: publish no geometry/evidence. The
    // real setter acts on a detached copy; no public failure recovery claimed.
    owned.source.reset(); phase.finish(); lifetime.finish();
}
void copy_lifetime() {
    std::fprintf(stderr,"lineage BEGIN actual copies, opaque origins, source immutability and release lifetime\n");
    Solids owned; owned.source=box();
    auto& context=*const_cast<SmContext*>(owned.source->GetContext());
    auto* previous=context.GetUserNotifyCallback();
    Ledger ledger; Scope lifetime(ledger,context); admit(ledger,*owned.source);
    auto* system=context.GetSysNotifyCallback();
    const auto original=seeds(*owned.source);
    std::vector<Identity> roots; for(auto seed:original) roots.push_back(single(ledger,ledger.identity(seed.face)).identity);
    const auto metadata=raw_context::Access<SmBrep>::get(*owned.source);
    const auto policy=raw_context::Access<SmContext>::get(context);
    SmTArray<SmVertex*> before; owned.source->GetVertices(before);
    std::vector<SmPoint3d> points; for(auto* vertex:before) points.push_back(vertex->GetPoint());
    std::fprintf(stderr,"lineage copy-lifetime stage=first-owned-copy\n");
    owned.first=checked_brep_copy(owned.source.get(),&ledger);
    std::fprintf(stderr,"lineage copy-lifetime stage=second-owned-copy\n");
    owned.second=checked_brep_copy(owned.first.get(),&ledger);
    require(context.GetUserNotifyCallback()==&lifetime && context.GetSysNotifyCallback()==system,
        "continuous observer preserved, system slot unchanged");
    const auto after_metadata=raw_context::Access<SmBrep>::get(*owned.source);
    const auto after_policy=raw_context::Access<SmContext>::get(context);
    require(bits(metadata.size,after_metadata.size) && bits(metadata.ratio,after_metadata.ratio) && bits(metadata.zone,after_metadata.zone) &&
        bits(policy.size,after_policy.size) && bits(policy.ratio,after_policy.ratio) && bits(policy.zone,after_policy.zone),
        "raw source/context metadata and sentinels preserved bitwise");
    SmTArray<SmVertex*> after; owned.source->GetVertices(after);
    require(after.GetSize()==before.GetSize(),"source vertex inventory preserved");
    for(ULONG i=0;i<after.GetSize();++i) {
        const auto p=after[i]->GetPoint();
        require(after[i]==before[i] && bits(p.x,points[i].x) && bits(p.y,points[i].y) && bits(p.z,points[i].z),
            "source vertex identity and coordinates unchanged");
    }
    {
        Scope phase(ledger,context);
        owned.source.reset(); ledger.check();
        owned.first.reset(); ledger.check();
        phase.finish(); ledger.check();
    }
    ledger.verify_inventory(*owned.second);
    const auto live=seeds(*owned.second);
    std::vector<Identity> seen;
    for(auto seed:live) {
        const auto root=single(ledger,ledger.identity(seed.face));
        require(root.kind==RootKind::SourceBoundary && root.object.incarnation==901 && root.object.session==41 &&
            root.object.slot==7 && root.object.generation==3 && root.object.revision==14,
            "immutable independently issued source object/revision binding survives copies");
        bool known=false; for(auto id:roots) known|=id==root.identity;
        require(known,"live copied face retains actual original opaque face identity"); seen.push_back(root.identity);
    }
    require(seen.size()==roots.size(),"complete copied source inventory survives operand release");
    {
        Scope phase(ledger,context);
        std::fprintf(stderr,"lineage copy-lifetime stage=sealed-surviving-volume\n");
        const auto current=seeds(*owned.second); std::vector<Identity> identities;
        for(auto seed:current) identities.push_back(ledger.identity(seed.face));
        // Repeated fixed phases must consume fresh transient generations even
        // when the SDK allocator reuses its temporary addresses.
        for(unsigned read=0;read<2;++read) {
            const auto event_start=ledger.event_size(),node_start=ledger.node_size();
            const auto volume=NumericalRead::volume(ledger,*owned.second,1e-8);
            require(std::abs(volume-8)<1e-6,"surviving actual copied geometry has analytic volume8");
            unsigned edits=0;
            for(uint32_t e=event_start;e<ledger.event_size();++e) {
                const auto& event=ledger.event(e);
                if((event.operation==SM_NO_PRE_EDIT || event.operation==SM_NO_POST_EDIT) && event.before[0].sequence) {
                    ++edits;
                    require(event.after[0]!=event.before[0] && event.after[0].sequence>event.before[0].sequence &&
                        event.before[0].sequence>node_start,"each actual transient edit retains a fresh current-read event generation");
                }
            }
            require(edits>0,"fixed actual volume read reached tracked detached numerical-copy edits");
            for(size_t i=0;i<current.size();++i)
                require(ledger.identity(current[i].face)==identities[i] && single(ledger,identities[i]).object.revision==14,
                    "fixed numerical phases preserve actual face generations and original object revision");
        }
        ledger.check(); owned.second.reset(); ledger.check(); phase.finish(); ledger.check();
    }
    lifetime.finish(); ledger.check();
    require(context.GetUserNotifyCallback()==previous,"continuous observer restores caller slot after all releases");
}
std::unique_ptr<SmBrep> plane_sheet(SmFace*& face) {
    auto* context=SmApiGetOrCreateContext(); auto result=raw_context::construct_brep(context);
    try {
        SmAxis2Placement position;
        require(position.SetCanonical(SmPoint3d(0,0,0),SmVector3d(1,0,0),SmVector3d(0,1,0))==SM_SUCCESS,
            "actual declared interface/source plane frame");
        SmPlane* surface=nullptr;
        require(SmPlane::CreateCanonical(*context,position,surface)==SM_SUCCESS && surface,"actual analytic plane construction");
        const SmExtent2d domain(0,0,2,2);
        require(surface->AdjustSTEPUVDomain(domain)==SM_SUCCESS && result->CreateFaceFromSurface(surface,domain,face)==SM_SUCCESS && face,
            "actual independently issued plane patch");
        // Prepare genuine original trim representation before adoption. The
        // raw intentionally trimless refusal fixture remains in root tests.
        double ms=0,xs=0,me=0,xe=0,mv=0,xv=0;
        require(face->CreateUVTrimCurves(FALSE,nullptr,nullptr,ms,xs,me,xe,mv,xv)==SM_SUCCESS,
            "actual mixed-origin source trims prepared before root adoption");
        return result;
    } catch(...) { result.release(); rethrow_tainted_kernel_domain("lineage sheet fixture construction"); }
}
void mixed_origins() {
    std::fprintf(stderr,"lineage BEGIN coplanar source/generated origin union via actual already-mated copy\n");
    Solids owned; SmFace* original=nullptr; SmFace* generated=nullptr;
    owned.source=plane_sheet(original); owned.first=plane_sheet(generated);
    auto& context=*const_cast<SmContext*>(owned.source->GetContext());
    Ledger ledger; Scope lifetime(ledger,context);
    const Seed a{original,RootKind::SourceBoundary},b{generated,RootKind::GeneratedInterface};
    ledger.admit_roots(*owned.source,ObjectRevision{901,41,19,2,18,0},&a,1);
    ledger.admit_roots(*owned.first,ObjectRevision{901,41,20,4,19,202},&b,1);
    const auto source_id=ledger.identity(original),generated_id=ledger.identity(generated);
    owned.second=checked_brep_copy(owned.source.get(),&ledger);
    original=seeds(*owned.second)[0].face;
    const auto original_id=ledger.identity(original);
    try {
        Scope phase(ledger,context);
        {
        SmMerge merge(context,owned.second.get(),owned.first.get()); ledger.check();
        // These two fixtures are independently constructed from the SAME
        // declared analytic frame, UV domain and boundary, not matched by
        // proximity, normals or tessellation. Exercise the actual SDK's
        // already-related MakeFaceuse path (which returns no new face list).
        require(merge.GetTopologyIntersector().Relate(original,generated)==SM_SUCCESS,"checked declared identical patch relation"); ledger.check();
        SmRegion* old_region=nullptr; SmRegion* new_region=nullptr; SmTArray<SmFace*> added;
        require(merge.MakeFaceuse(generated->GetUpwardFaceuse(),old_region,new_region,nullptr,&added)==SM_SUCCESS,
            "actual SDK already-mated face copy"); ledger.check();
        require(added.GetSize()==0,"already-mated copy supplies no newly constructed face array");
        } // SDK relation owner dies while both actual operands are still alive.
        const auto mixed=ledger.identity(original);
        require(ledger.descends_from(mixed,original_id) && ledger.descends_from(mixed,generated_id),"copy onto existing face preserves both input ancestors");
        std::array<Root,4> roots{};
        require(ledger.roots(mixed,roots.data(),roots.size())==2,"bounded union keeps both distinct root labels");
        require(roots[0].kind!=roots[1].kind,"coplanar generated interface cannot erase original boundary provenance");
        phase.finish(); ledger.check();
        owned.third=checked_brep_copy(owned.second.get(),&ledger);
        const auto copied=seeds(*owned.third);
        require(copied.size()==1 && ledger.roots(ledger.identity(copied[0].face),roots.data(),roots.size())==2,
            "both source/generated labels survive subsequent owned copy");
        require(single(ledger,source_id).kind==RootKind::SourceBoundary,
            "original input lineage remains unchanged by owned result union");
        Scope release(ledger,context); owned.source.reset(); ledger.check(); owned.first.reset(); ledger.check();
        owned.second.reset(); ledger.check(); owned.third.reset(); ledger.check(); release.finish(); ledger.check();
    } catch(...) { rethrow_tainted_kernel_domain("actual mixed-origin lineage witness"); }
}
void split_merge() {
    std::fprintf(stderr,"lineage BEGIN actual MakeEdgeInFace/DeleteEdge fragment events\n");
    Solids owned; owned.source=box(); Ledger ledger;
    auto& context=*const_cast<SmContext*>(owned.source->GetContext());
    Scope lifetime(ledger,context); admit(ledger,*owned.source);
    owned.first=checked_brep_copy(owned.source.get(),&ledger);
    auto* working=owned.first.get();
    const auto inventory=seeds(*working); SmFace* original=inventory.front().face;
    const auto root=single(ledger,ledger.identity(original)); const auto parent=ledger.identity(original);
    SmTArray<SmVertex*> vertices; original->GetVertices(vertices);
    require(vertices.GetSize()==4,"real quadrilateral box face");
    SmVertex* start=nullptr; SmVertex* end=nullptr; double distance=0;
    for(auto* a:vertices) for(auto* b:vertices) {
        const auto delta=a->GetPoint()-b->GetPoint(); const double d=delta.Dot(delta);
        if(d>distance) { distance=d; start=a; end=b; }
    }
    require(start && end && distance==8,"choose actual opposite corners without an invented edge");
    Scope phase(ledger,context,owned.source.get());
    SmEdge* cut=nullptr; SmLoop* loop=nullptr; SmFace* fragment=nullptr; SmLine* line=nullptr;
    try {
        require(SmLine::CreateLineSegment(context,3,start->GetPoint(),end->GetPoint(),line)==SM_SUCCESS && line,
            "actual SDK diagonal curve"); ledger.check();
        working->m_bEditingEnabled=TRUE;
        require(working->MakeEdgeInFace(original,start,end,line,nullptr,line->GetNaturalInterval(),SM_OT_SAME,
            working->GetTolerance(),cut,loop,fragment)==SM_SUCCESS && cut && fragment,
            "actual SDK face split produces a reached new fragment"); ledger.check();
        ledger.verify_inventory(*working);
        const auto one=ledger.identity(original),two=ledger.identity(fragment);
        require(one!=parent && two!=parent && one!=two && ledger.descends_from(one,parent) && ledger.descends_from(two,parent),
            "both fragments have distinct event generations and the same frozen parent");
        require(single(ledger,one).identity==root.identity && single(ledger,two).identity==root.identity,
            "split fragments preserve actual original boundary ancestry");
        require(working->DeleteEdge(cut)==SM_SUCCESS,"actual SDK removal merges split face fragments");
        ledger.check(); ledger.verify_inventory(*working);
        require(working->GetNumFaces()==6,"actual split/merge restores box face cardinality");
        bool reached=false;
        for(auto seed:seeds(*working)) {
            const auto id=ledger.identity(seed.face);
            if(single(ledger,id).identity==root.identity) {
                require(ledger.descends_from(id,one) && ledger.descends_from(id,two),"merged face retains both fragment ancestors");
                reached=true;
            }
        }
        require(reached,"actual merged source face reached");
        working->m_bEditingEnabled=FALSE;
        phase.finish(); ledger.check();
        owned.second=checked_brep_copy(working,&ledger);
        require(owned.source->GetNumFaces()==6,"original source face inventory survives owned split/merge");
        ledger.verify_inventory(*owned.source);
        Scope release(ledger,context); owned.source.reset(); ledger.check(); owned.first.reset(); ledger.check();
        owned.second.reset(); ledger.check(); release.finish(); ledger.check();
    } catch(...) { rethrow_tainted_kernel_domain("actual lineage split/merge witness"); }
}
void address_reuse() {
    std::fprintf(stderr,"lineage BEGIN real SDK allocator reuse (must be observed, never skipped)\n");
    auto& context=*SmApiGetOrCreateContext(); Ledger ledger;
    auto allocation_owner=raw_context::construct_brep(&context);
    Scope phase(ledger,context);
    std::array<uintptr_t,128> addresses{}; std::array<Identity,128> births{}; bool reused=false;
    for(unsigned i=0;i<addresses.size();++i) {
        auto* face=new (allocation_owner.get()) FixtureFace(); ledger.check();
        const auto birth=ledger.event(ledger.event_size()-1).after[0];
        require(birth.sequence!=0,"actual face constructor reported an event-time identity");
        const auto address=reinterpret_cast<uintptr_t>(face);
        for(unsigned j=0;j<i;++j) if(addresses[j]==address) {
            require(birth!=births[j] && birth.sequence>births[j].sequence,"reused raw address has a fresh identity generation");
            reused=true;
        }
        bool unavailable=false;
        try { ledger.identity(face); } catch(const SweepFailure&) { unavailable=true; }
        require(unavailable,"new lifetime never inherits ancestry from an older address binding");
        addresses[i]=address; births[i]=birth;
        delete face; ledger.check();
        require(ledger.event(ledger.event_size()-1).before[0]==birth,"actual destructor freezes the matching event-time identity");
    }
    require(reused,"allocator alias witness did not reach address reuse; no alias qualification");
    phase.finish(); ledger.check();
}
void refusals() {
    std::fprintf(stderr,"lineage BEGIN missing history, callback replacement and bounded event refusal\n");
    Solids owned; owned.source=box();
    Ledger unknown; bool rejected=false;
    try { auto result=checked_brep_copy(owned.source.get(),&unknown); }
    catch(const SweepFailure&) { rejected=true; }
    require(rejected && !kernel_domain_is_tainted(),"unknown source history refuses before copying/taint/publication");
    auto& context=*const_cast<SmContext*>(owned.source->GetContext());
    {
        Ledger ledger(Limits{8,1,1}); Scope phase(ledger,context);
        auto* one=new (owned.source.get()) FixtureFace(); auto* two=new (owned.source.get()) FixtureFace();
        require(ledger.failed()==Failure::EventLimit,"actual constructor events exhaust fixed storage without growth");
        delete one; delete two; phase.finish();
        bool bounded=false; try { ledger.check(); } catch(const SweepFailure& error) { bounded=error.status==IFCLITE_SMLIB_RESOURCE_LIMIT; }
        require(bounded,"overflow is an explicit latched resource refusal");
    }
    {
        Ledger ledger(Limits{1,32,1}); Scope phase(ledger,context);
        auto* one=new (owned.source.get()) FixtureFace(); auto* two=new (owned.source.get()) FixtureFace();
        require(ledger.failed()==Failure::NodeLimit,"actual face generations cannot grow beyond the admitted node quota");
        delete one; delete two; phase.finish();
    }
    {
        Ledger ledger; Foreign foreign; ForeignSlot install(context,foreign); Scope lifetime(ledger,context);
        foreign.hidden_mutation=seeds(*owned.source)[0].face;
        bool refused=false; try { admit(ledger,*owned.source); } catch(const SweepFailure&) { refused=true; }
        require(refused && ledger.failed()==Failure::UntrustedCallback,"SUCCESS foreign callback is not closed-world authority");
        auto* temporary=new (owned.source.get()) FixtureFace(); delete temporary;
        lifetime.finish();
        require(foreign.calls>0 && foreign.hidden_changes==1 && context.GetUserNotifyCallback()==&foreign,
            "SUCCESS callback with restored silent intermediate edits remains unavailable and still chains/restores");
    }
    for(bool depth_limit:{false,true}) {
        // Unattached actual SDK vertex has no uses to propagate ahead of the
        // vertex callback. It is allocated before this observation-only test.
        auto* vertex=new (owned.source.get()) FixtureVertex();
        vertex->SetPoint(SmPoint3d(0,0,0));
        Limits limits; if(depth_limit) limits.callback_depth=1;
        Ledger ledger(limits); Foreign foreign; foreign.nested_vertex=vertex;
        foreign.constructor_fault=true; foreign.refuse=true;
        ForeignSlot install(context,foreign); Scope phase(ledger,context);
        const auto first=ledger.event_size();
        auto* temporary=new (owned.source.get()) FixtureFace();
        const auto origin=ledger.failure_origin();
        require(origin.failure==(depth_limit?Failure::CallbackDepthLimit:Failure::ReentrantCallback) &&
            origin.operation==SM_NO_CHANGE_GEOMETRY && origin.caller_type==SmVertex_TYPE &&
            origin.event==first+2 && origin.frame==1,
            "nested actual setter owns the first failure, not outer face construction or foreign status");
        delete temporary; delete vertex; phase.finish();
        const auto retained=ledger.failure_origin();
        require(retained.failure==origin.failure && retained.operation==origin.operation &&
            retained.caller_type==origin.caller_type && retained.event==origin.event && retained.frame==origin.frame,
            "later SDK callbacks and outer foreign failure cannot overwrite nested first-failure origin");
        require(context.GetUserNotifyCallback()==&foreign,"nested refusal restores the foreign callback slot");
    }
    for(bool exception:{false,true}) {
        Ledger ledger; Foreign foreign; foreign.constructor_fault=true; foreign.throws=exception; foreign.refuse=!exception;
        ForeignSlot install(context,foreign); Scope phase(ledger,context);
        auto* temporary=new (owned.source.get()) FixtureFace();
        require(ledger.failed()==(exception?Failure::ForeignException:Failure::ForeignStatus),
            "real SDK construction returns while foreign status/exception is latched without crossing SDK");
        const auto origin=ledger.failure_origin();
        require(origin.operation==SM_NO_CONSTRUCTION && origin.caller_type==SmFace_TYPE && origin.event==1,
            "outer foreign status/exception retains its actual constructor event context");
        delete temporary; phase.finish();
        require(context.GetUserNotifyCallback()==&foreign,"faulting caller callback restored on observation-only refusal");
    }
    {
        Ledger ledger; Scope lifetime(ledger,context); admit(ledger,*owned.source);
        Scope phase(ledger,context,owned.source.get());
        SmTArray<SmVertex*> vertices; owned.source->GetVertices(vertices); require(vertices.GetSize()>0,"actual source vertex");
        const auto point=vertices[0]->GetPoint();
        // The actual setter notifies before writing. Write identical bits so
        // this rejection witness cannot perturb the geometry of later fixtures.
        vertices[0]->SetPoint(point);
        require(ledger.failed()==Failure::ReadOnlyMutation,"actual source geometry setter is detected while protected");
        const auto after=vertices[0]->GetPoint();
        require(bits(point.x,after.x) && bits(point.y,after.y) && bits(point.z,after.z),"negative witness leaves original coordinates unchanged");
        phase.finish();
    }
    {
        Foreign original,replacement; ForeignSlot install(context,original); Ledger ledger;
        original.replacement=&replacement;
        Scope phase(ledger,context); auto* face=new (owned.source.get()) FixtureFace(); phase.finish();
        require(context.GetUserNotifyCallback()==&original && ledger.failed()==Failure::CallbackReplaced,
            "foreign slot replacement latches failure and restores the caller callback"); delete face;
    }
    {
        Ledger ledger; Scope lifetime(ledger,context); admit(ledger,*owned.source);
        owned.first=checked_brep_copy(owned.source.get(),&ledger);
        Scope phase(ledger,context,owned.source.get());
        SmTArray<SmVertex*> vertices; owned.first->GetVertices(vertices);
        require(vertices.GetSize()>0,"actual established copied vertex");
        vertices[0]->SetPoint(vertices[0]->GetPoint());
        require(ledger.failed()==Failure::UnsupportedGeometryChange,
            "an established owned vertex cannot acquire unreported geometry history after a phase gap");
        phase.finish(); owned.first.reset();
    }
    {
        Ledger ledger; auto* original_callback=context.GetUserNotifyCallback();
        Scope lifetime(ledger,context); admit(ledger,*owned.source);
        const auto saved=single(ledger,ledger.identity(seeds(*owned.source)[0].face)).identity;
        lifetime.finish();
        require(ledger.failed()==Failure::ObservationGap && context.GetUserNotifyCallback()==original_callback,
            "closing observation with a live rooted object invalidates history and restores caller slot");
        bool refused=false;
        try { Scope detached(ledger,context); } catch(const SweepFailure&) { refused=true; }
        require(refused,"observer cannot be reattached across an unobserved destruction/reuse gap");
        std::array<Root,1> roots{}; refused=false;
        try { ledger.roots(saved,roots.data(),roots.size()); } catch(const SweepFailure&) { refused=true; }
        require(refused,"saved root evidence cannot bypass an invalidated observation lifetime");
    }
}
void terminal_budget_failure() {
    std::fprintf(stderr,"lineage BEGIN terminal event-budget refusal during actual checked copy\n");
    Solids owned; owned.source=box();
    auto& context=*const_cast<SmContext*>(owned.source->GetContext());
    uint64_t session=0; ifclite_smlib_handle handle{};
    require(ifclite_smlib_session_create(&session)==0 && ifclite_smlib_box(session,0,0,0,1,1,1,&handle)==0,
        "actual unrelated live session before terminal copy fault");
    auto* previous=context.GetUserNotifyCallback(); Ledger ledger(Limits{8192,16,1024,16});
    Scope lifetime(ledger,context); admit(ledger,*owned.source);
    std::unique_ptr<SmBrep> published; bool tainted=false;
    try { published=checked_brep_copy(owned.source.get(),&ledger); }
    catch(const KernelDomainTainted&) { tainted=true; }
    require(tainted && !published && ledger.failed()==Failure::EventLimit && kernel_domain_is_tainted(),
        "ignored observer refusal cannot publish a partial copy");
    lifetime.finish();
    require(context.GetUserNotifyCallback()==previous,"caller slot restored on terminal copy failure");
    double volume=0;
    require(ifclite_smlib_volume(session,handle,1e-8,&volume)==IFCLITE_SMLIB_TAINTED_DOMAIN,
        "terminal lineage failure poisons the entire isolation, including unrelated handles");
    owned.source.release(); // No SDK cleanup or recovery claim after uncertainty.

}
}
void run_root_issuance_tests();
void run_face_lineage_tests() {
    run_root_issuance_tests(); direct_read_refusal(); copy_lifetime(); split_merge(); mixed_origins(); address_reuse(); refusals(); terminal_budget_failure();
    std::fprintf(stderr,"lineage witnesses PASS; paired split/classification/extraction still unimplemented\n");
}
