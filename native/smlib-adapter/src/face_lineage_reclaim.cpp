// SPDX-License-Identifier: MPL-2.0
#include "face_lineage.hpp"
#include "failure.hpp"
#include "ifclite_smlib.h"
#include <algorithm>
#include <cstdio>
namespace face_lineage {
void Ledger::reclaim_tessellation_history() {
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
    const auto keep_nodes=numerical.retained_nodes,keep_events=numerical.retained_events;
    require(keep_nodes<node_count && keep_events<=event_count,"invalid numerical journal checkpoint");
    auto retained=[&](Identity id) {
        const auto* n=node(id); return n && size_t(n-nodes.data())<keep_nodes;
    };
    for(const auto& polygon:numerical.polygons)
        require(polygon.rebound && retained(polygon.input),"polygon result still references temporary ancestry");
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
    for(auto& trace:diagnostic_events) if(trace.event>keep_events) trace={};
#endif
    bindings.swap(binding_scratch);
    node_count=keep_nodes; event_count=keep_events; // storage checkpoint only; never rewind issued_sequence
    numerical.tessellation=false; numerical.operation={}; numerical.copy_generation={}; numerical.polygons.clear();
}
}
