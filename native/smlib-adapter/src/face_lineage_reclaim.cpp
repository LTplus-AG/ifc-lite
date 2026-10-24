// SPDX-License-Identifier: MPL-2.0
#include "face_lineage.hpp"
#include "failure.hpp"
#include "ifclite_smlib.h"
#include <SmPoly.h>
#include <SmFace.h>
#include <algorithm>
#include <cstdio>
namespace face_lineage {
void Ledger::reclaim_tessellation_history(SmPolyBrep* output) {
    // #7955: fixed numerical reads create an internal BRep that must be gone
    // before publication. Its generations are operation scratch, not new face
    // ancestry in the returned mesh. Do not refund unfinished/failed work.
    check();
    auto require=[](bool ok,const char* why) {
        if(!ok) throw AdapterFailure{IFCLITE_SMLIB_UNSUPPORTED,why};
    };
    require(numerical.tessellation && !numerical.source && !numerical.copy && !subdivision &&
        frame_count==numerical.frame && frame_count && frames[frame_count-1]->serial==numerical.serial,
        "only a completed current tessellation can release history");
    require(read_live==0,"numerical journal still has a live scratch generation"); // read-live-reclaim
    const auto keep_nodes=numerical.retained_nodes,keep_events=numerical.retained_events;
    require(keep_nodes<node_count && keep_events<=event_count,"invalid numerical journal checkpoint");
    auto retained=[&](Identity id) {
        const auto* n=node(id); return n && size_t(n-nodes.data())<keep_nodes;
    };
    // SmTess creates attribute receipts for both temporary UV polygons (1793)
    // and final 3D polygons (6675). Phase3DeleteFacePolygons destroys UV scratch;
    // only the returned 3D inventory is rebound by ConvertToPolyBrep:37552.
    // Scratch receipt pointers may be dead: compare them, never dereference them.
    // Walk the actual returned hierarchy with the existing 8192 receipt bound.
    // Three levels (region/shell/face) permit at most 3*8192 inspected entries.
    std::vector<SmPolyFace*> published;
    uint32_t work=0;
    auto children=[&](SmOwningTopology& owner,ULONG type,auto visit) {
        const auto size=owner.GetSize(); auto* first=owner.GetList(); auto* item=first;
        require(size<=8192 && (size==0)==(first==nullptr),"invalid polygon output list size");
        for(ULONG i=0;i<size;++i) {
            require(++work<=3*8192 && item && (!i || item!=first) && item->GetType()==type &&
                item->GetOwner()==&owner,"invalid bounded polygon output topology");
            visit(item); item=item->GetNext();
        }
        require(item==first,"polygon output list does not close at its declared size");
    };
    if(output) children(*output,SmPolyRegion_TYPE,[&](SmTopology* region) {
        children(*static_cast<SmPolyRegion*>(region),SmPolyShell_TYPE,[&](SmTopology* shell) {
            children(*static_cast<SmPolyShell*>(shell),SmPolyFace_TYPE,[&](SmTopology* face) {
                require(published.size()<8192,"polygon output exceeds receipt bound");
                published.push_back(static_cast<SmPolyFace*>(face));
            });
        });
    });
    for(const auto& receipt:numerical.polygons) {
        require(retained(receipt.input),"polygon receipt input is not retained ancestry");
        if(receipt.rebound) require(receipt.body==output &&
            std::find(published.begin(),published.end(),receipt.polygon)!=published.end(),
            "rebound polygon is absent from the returned inventory");
    }
    for(auto* polygon:published) {
        const NumericalPhase::PolygonReceipt* receipt=nullptr;
        for(const auto& candidate:numerical.polygons) if(candidate.polygon==polygon) {
            require(!receipt,"duplicate returned polygon receipt"); receipt=&candidate;
        }
        require(receipt,"returned polygon has no attribute receipt"); // published-polygon-receipt
        require(receipt->rebound && receipt->body==output && polygon->GetPolyBrep()==output,
            "returned polygon has no matching final rebind"); // published-polygon-rebind
        const auto* original=binding(polygon->GetOriginalFace(),false);
        require(original && original->alive && !original->retired && original->current==receipt->input,
            "returned polygon original differs from its checked rebind"); // published-polygon-original
    }
    // Every primary and auxiliary generation in a surviving binding must be
    // outside the discarded suffix. Dead bindings may be forgotten; their
    // monotonically issued generation is NEVER made available for reuse.
    for(const auto& b:bindings) if(b.alive) {
        require(retained(b.current),"numerical journal still has a live generation");
        for(auto id:{b.numerical_operation,b.owned_transition,b.numerical_parent,b.numerical_owner_copy_operation,
            b.numerical_parent_owner,b.numerical_face_input,b.subdivision_operation,b.subdivision_owner})
            require(!id.sequence || retained(id),"live binding retains temporary operation authority");
    }
    for(uint32_t i=0;i<keep_nodes;++i) for(auto parent:nodes[i].parent)
        require(!parent.sequence || retained(parent),"persistent ancestry references temporary history");
    for(uint32_t i=0;i<root_count;++i)
        require(retained(root_records[i].identity),"issued root cannot be reclaimed");
    for(uint32_t i=0;i<keep_events;++i) {
        const auto& e=events[i];
        for(auto id:{e.before[0],e.before[1],e.after[0],e.after[1]})
            require(!id.sequence || retained(id),"retained event references temporary history");
    }
    // Rebuild the open-addressed table, rather than leaving holes in probe
    // chains or accumulating dead-address tombstones across reads. Scratch is
    // preallocated and included in the constructor's unchanged 64 MiB ceiling.
    std::fill(binding_scratch.begin(),binding_scratch.end(),Binding{});
    for(const auto& b:bindings) if(b.address && retained(b.current)) {
        size_t index=(b.address/alignof(void*))%binding_scratch.size(),probes=0;
        while(binding_scratch[index].address && probes++<binding_scratch.size())
            index=(index+1)%binding_scratch.size();
        require(probes<binding_scratch.size(),"bounded numerical binding rehash exhausted");
        binding_scratch[index]=b;
    }
#ifdef IFCLITE_LINEAGE_FAILURE_STACK
    std::fprintf(stderr,"lineage tessellation journal release nodes=%u events=%u retained_nodes=%u retained_events=%u issued_sequence=%llu\n",
        node_count-keep_nodes,event_count-keep_events,keep_nodes,keep_events,static_cast<unsigned long long>(issued_sequence));
    std::fprintf(stderr,"lineage tessellation read release live=%u peak=%u limit=%u callbacks=%u callback_limit=%u\n",
        read_live,read_peak,limits.read_objects,read_callbacks,limits.read_callbacks);
    for(auto& trace:diagnostic_events) trace={};
#endif
    bindings.swap(binding_scratch);
    node_count=keep_nodes; event_count=keep_events; // storage checkpoint only; never rewind issued_sequence
    read_bindings.clear(); read_callbacks=0; read_trace={};
    numerical.tessellation=false; numerical.operation={}; numerical.copy_generation={}; numerical.polygons.clear();
}
}
