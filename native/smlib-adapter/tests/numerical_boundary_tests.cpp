// SPDX-License-Identifier: MPL-2.0
// #7955 / D96 review gaps 2 and 4. Actual SDK work; no callback substitution.
#include "numerical_read_test_access.hpp"
#include "owned_lineage_access.hpp"
#include "failure.hpp"
#include <SmApiGeneral.h>
#include <SmBSplineCurve.h>
#include <SmCopyBrepMap.h>
#include <algorithm>
#include <cstdio>
#include <cstring>
#include <memory>
#include <stdexcept>
#include <vector>
namespace {
using namespace face_lineage;
void require(bool ok,const char* message) { if(!ok) throw std::runtime_error(message); }
SmBrep& body(const OwnedBoundary& owner) { return const_cast<SmBrep&>(OwnedBoundaryTestAccess::solid(owner)); }
Ledger& history(const OwnedBoundary& owner) { return const_cast<Ledger&>(OwnedBoundaryTestAccess::ledger(owner)); }

// SmObject's allocator writes the context before the base constructor. A
// user-provided ctor avoids value-initialization erasing it (R14). Neither
// notification code nor geometry is replaced; this exposes protected lifetime.
class SurvivingFace final:public SmFace {
public:
    SurvivingFace() {}
    ~SurvivingFace() override=default;
};
void durable_reclaim() {
    auto owner=OwnedBoundary::box(2,3,4); auto& solid=body(owner); auto& ledger=history(owner);
    const auto roots=owner.faces();
    Scope phase(ledger,*SmApiGetOrCreateContext(),&solid); RepresentationSeal seal(ledger,solid);
    const auto nodes=ledger.node_size(),events=ledger.event_size();
    NumericalReadTestAccess::tessellation(ledger,solid);
    SmCopyBrepMap map;
    auto internal=std::unique_ptr<SmBrep>(new (*solid.GetContext()) SmBrep(solid,&map));
    ledger.check();
    require(internal->GetNumFaces()==6 && ReadAccountingTestAccess::live(ledger)>0,
        "durable reclaim setup observes an actual internal box copy");
    internal.reset(); ledger.check(); NumericalReadTestAccess::end(ledger);
    seal.verify(); ledger.verify_inventory(solid);
    require(ReadAccountingTestAccess::live(ledger)==0 && ledger.node_size()>nodes,
        "durable reclaim setup completed with zero live scratch generations");

    const auto first=ReadAccountingTestAccess::event_size(ledger),before=ledger.node_size();
    auto* raw=new (&solid) SurvivingFace();
    // Check before adopting a deleter: a lost allocator context must produce a
    // setup assertion, never crash while unwinding through the SDK destructor.
    require(raw->GetContext()==solid.GetContext(),"durable face setup preserves actual allocator context");
    std::unique_ptr<SurvivingFace> survivor(raw); ledger.check();
    const auto id=ReadAccountingTestAccess::durable_constructor(ledger,raw);
    require(id.sequence && ledger.node_size()==before+1 && ReadAccountingTestAccess::live(ledger)==0 &&
        ReadAccountingTestAccess::event_size(ledger)==first+1 &&
        ReadAccountingTestAccess::event(ledger,first).operation==SM_NO_CONSTRUCTION &&
        ReadAccountingTestAccess::event(ledger,first).after[0]==id,
        "durable face setup has one real constructor node and no scratch lifetime");
    std::fprintf(stderr,"durable reclaim healthy live_scratch=0 constructor_sequence=%llu retained_nodes=%u current_nodes=%u\n",
        static_cast<unsigned long long>(id.sequence),nodes,ledger.node_size());
    bool refused=false; const char* reason=nullptr;
    try { NumericalReadTestAccess::release(ledger); }
    catch(const AdapterFailure& e) { refused=e.status==IFCLITE_SMLIB_UNSUPPORTED; reason=e.message; }
    // This MUST be the first failed assertion for removal of retained(b.current).
    // No later destructor/inventory check is permitted to count as a kill.
    if(refused) require(reason && std::strcmp(reason,"numerical journal still has a live generation")==0 &&
        ledger.failed()==Failure::None,"durable reclaim must reach its specific surviving-binding guard");
    require(refused,"journal release independently refuses a surviving durable face generation");
    require(ledger.failed()==Failure::None && ledger.node_size()==before+1 && ledger.event_size()==events &&
        ReadAccountingTestAccess::durable_constructor(ledger,raw)==id && owner.faces()==roots,
        "durable reclaim refusal preserves live identity and the unreclaimed suffix");
    const auto death=ReadAccountingTestAccess::event_size(ledger);
    survivor.reset(); ledger.check();
    require(ReadAccountingTestAccess::event_size(ledger)==death+1 &&
        ReadAccountingTestAccess::event(ledger,death).operation==SM_NO_DESTRUCTION &&
        ReadAccountingTestAccess::event(ledger,death).before[0]==id,
        "actual durable face destructor retires the refused generation");
    NumericalReadTestAccess::release(ledger); seal.verify(); ledger.verify_inventory(solid);
    require(ledger.node_size()==nodes && ledger.event_size()==events && owner.faces()==roots,
        "durable face destruction permits reclaim without losing source ancestry");
    phase.finish(); ledger.check();
}

SmEdge* boundary_edge(SmBrep& solid) {
    SmTArray<SmEdge*> edges; solid.GetEdges(edges);
    for(auto* edge:edges) {
        auto* curve=edge->GetCurve();
        if(edge->GetEdgeuseCount()!=4 || !curve || !curve->IsKindOf(SmBSplineCurve_TYPE) ||
            static_cast<SmBSplineCurve*>(curve)->GetDegree()!=1) continue;
        SmTArray<SmEdgeuse*> uses; edge->GetEdgeuses(uses); unsigned trims=0;
        for(auto* use:uses) trims+=use->GetUVTrimCurvePointer()!=nullptr;
        if(trims==2) return edge;
    }
    throw std::runtime_error("split cap setup needs a real linear four-use two-trim box edge");
}
void split_cap(bool refuse) {
    // Breadth-first bisection stays well above SDK endpoint/vertex tolerances;
    // repeatedly halving just one child would stop long before 4096 splits.
    // Integer box coordinates and dyadic cuts avoid relying on knot snapping.
    auto owner=OwnedBoundary::box(2,3,4); auto& solid=body(owner); auto& ledger=history(owner);
    const auto roots=owner.faces();
    Scope phase(ledger,*SmApiGetOrCreateContext(),&solid); RepresentationSeal seal(ledger,solid);
    const auto retained_nodes=ledger.node_size(),retained_events=ledger.event_size();
    NumericalReadTestAccess::tessellation(ledger,solid);
    SmCopyBrepMap map;
    auto internal=std::unique_ptr<SmBrep>(new (*solid.GetContext()) SmBrep(solid,&map)); ledger.check();
    auto* initial=boundary_edge(*internal); const auto domain=initial->GetInterval();
    const auto initial_live=ReadAccountingTestAccess::live(ledger),nodes=ledger.node_size();
    const auto limits=ReadAccountingTestAccess::quotas(ledger);
    require(limits.nodes==8192 && limits.events==32768 && limits.read_objects==65536 &&
        limits.read_callbacks==2097152 && initial_live+13*4097<limits.read_objects,
        "split cap setup uses unchanged default quotas with room for 4097 real splits");
    std::vector<SmEdge*> queue{initial}; queue.reserve(8195);
    uint32_t max_callbacks=0;
    for(unsigned i=0;i<4096;++i) {
        ledger.check(); auto* edge=queue[i]; const auto interval=edge->GetInterval();
        const double cut=interval.GetMin()+(interval.GetMax()-interval.GetMin())/2;
        const auto first=ReadAccountingTestAccess::event_size(ledger);
        SmEdge *one=nullptr,*two=nullptr; SmVertex* vertex=nullptr;
        const auto status=internal->MakeVertexSplitEdge(edge,cut,one,two,vertex);
        require(status==SM_SUCCESS && one==edge && two && vertex,
            "split cap setup SDK call returns actual split topology");
        if(i==4095) {
            const auto origin=ledger.failure_origin();
            require(ledger.failed()==Failure::None || (ledger.failed()==Failure::UnsupportedGeometryChange &&
                origin.operation==SM_NO_PRE_EDIT && origin.caller_type==SmEdge_TYPE && origin.event==first+1),
                "4096th split must not fail at a later protocol or resource guard");
            require(ledger.failed()==Failure::None,"split cap accepts the 4096th actual SDK subdivision");
        } else ledger.check(); // early failures must never match a mutation marker
        SubdivisionTestAccess::finish(ledger);
        const auto last=ReadAccountingTestAccess::event_size(ledger),delta=last-first;
        require(delta>0 && delta<=257,"split cap setup respects the per-split callback bound");
        max_callbacks=std::max(max_callbacks,delta);
        const auto& receipt=ReadAccountingTestAccess::event(ledger,last-1);
        require(receipt.operation==SM_NO_SPLIT_IN_BREP && receipt.before[0].sequence &&
            receipt.after[0]==receipt.before[0] && receipt.after[1].sequence && receipt.after[1]!=receipt.after[0],
            "split cap setup has genuine distinct-generation completion receipts");
        require(ledger.node_size()==nodes && ledger.event_size()==retained_events &&
            ReadAccountingTestAccess::live(ledger)==initial_live+13*(i+1),
            "split cap setup retains exactly 13 scratch objects per completed manifold split");
        queue.push_back(one); queue.push_back(two);
    }
    // All unsplit queue entries are actual final leaves, independent of which
    // SDK output retained the lower interval. Prove the complete partition.
    std::vector<SmExtent1d> leaves; leaves.reserve(4097);
    for(size_t i=4096;i<queue.size();++i) leaves.push_back(queue[i]->GetInterval());
    std::sort(leaves.begin(),leaves.end(),[](const auto& a,const auto& b) { return a.GetMin()<b.GetMin(); });
    double next=domain.GetMin();
    for(const auto& leaf:leaves) {
        require(leaf.GetMin()==next && leaf.GetMin()<leaf.GetMax(),"4096 split leaves form an exact gap-free partition");
        next=leaf.GetMax();
    }
    require(leaves.size()==4097 && next==domain.GetMax() && owner.faces()==roots,
        "4096 actual splits preserve the entire input interval and source roots");
    std::fprintf(stderr,"split cap healthy completed=4096 leaves=%zu live=%u callbacks=%u max_split_callbacks=%u nodes=%u\n",
        leaves.size(),ReadAccountingTestAccess::live(ledger),ReadAccountingTestAccess::event_size(ledger),max_callbacks,nodes);
    if(refuse) {
        ledger.check(); const auto first=ReadAccountingTestAccess::event_size(ledger);
        auto* edge=queue[4096]; const auto interval=edge->GetInterval();
        SmEdge *one=nullptr,*two=nullptr; SmVertex* vertex=nullptr;
        const auto status=internal->MakeVertexSplitEdge(edge,interval.GetMin()+(interval.GetMax()-interval.GetMin())/2,
            one,two,vertex);
        // Pinned SDK ignores the notification return here. Success cannot
        // override the ledger's refusal; the new topology must not publish.
        require(status==SM_SUCCESS && one==edge && two && vertex,"4097th SDK split reaches its genuine notification path");
        const auto origin=ledger.failure_origin();
        if(ledger.failed()!=Failure::None) require(ledger.failed()==Failure::UnsupportedGeometryChange &&
            origin.operation==SM_NO_PRE_EDIT && origin.caller_type==SmEdge_TYPE && origin.event==first+1,
            "4097th split must not fail at a later protocol or resource guard");
        require(ledger.failed()!=Failure::None,
            "split cap refuses the 4097th actual SDK subdivision at its first notification");
        bool rejected=false;
        try { ledger.check(); } catch(const AdapterFailure& e) { rejected=e.status==IFCLITE_SMLIB_UNSUPPORTED; }
        require(rejected,"split cap callback refusal cannot be overridden by SDK success");
    } else {
        internal.reset(); ledger.check(); NumericalReadTestAccess::end(ledger);
        require(ReadAccountingTestAccess::live(ledger)==0,"4096 completed splits retire every scratch generation");
        seal.verify(); ledger.verify_inventory(solid); NumericalReadTestAccess::release(ledger);
        require(ledger.node_size()==retained_nodes && ledger.event_size()==retained_events && owner.faces()==roots,
            "4096 completed splits reclaim only temporary history");
    }
    phase.finish();
}
}
void run_numerical_boundary_case(const char* name) {
    if(std::strcmp(name,"journal-durable")==0) durable_reclaim();
    else if(std::strcmp(name,"split-cap-release")==0) split_cap(false);
    else if(std::strcmp(name,"split-cap-refusal")==0) split_cap(true);
    else throw std::runtime_error("unknown numerical boundary witness");
}
