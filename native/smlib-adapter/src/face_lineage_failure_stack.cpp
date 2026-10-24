// SPDX-License-Identifier: MPL-2.0
#include "face_lineage.hpp"
#include "edge_subdivision.hpp"
#include <execinfo.h>
#include <cstdio>
#include <unistd.h>
namespace face_lineage {
void Ledger::trace_event(SmNotifyOperation op,SmObject* caller,SmObject* a,SmObject* b,SmObject* c) noexcept {
    auto& trace=diagnostic_events[(current_event-1)%diagnostic_events.size()];
    trace={}; trace.event=current_event; trace.frame=frame_count;
    trace.operation=long(op); trace.type=caller?long(caller->GetType()):0;
    trace.caller=reinterpret_cast<uintptr_t>(caller); trace.a=reinterpret_cast<uintptr_t>(a);
    trace.b=reinterpret_cast<uintptr_t>(b); trace.c=reinterpret_cast<uintptr_t>(c);
    // Payload slots may be arrays. Do not dereference them or chase ownership.
    if(auto* entry=binding(caller,false)) {
        trace.generation=entry->current; trace.numerical_operation=entry->numerical_operation;
        trace.alive=entry->alive; trace.retired=entry->retired;
    }
}
void Ledger::capture_failure_stack() noexcept {
    // Called only AFTER the first-failure latch is set, while the SDK call
    // stack still exists. No SDK getters, event replay, or acceptance changes.
    // execinfo may lazily load its unwinder: this is an opt-in diagnostic build,
    // not a bounded-allocation production callback or performance measurement.
    const int count=::backtrace(failed_stack.frames.data(),int(failed_stack.frames.size()));
    failed_stack.size=count>0?uint32_t(count):0;
}
void Ledger::report_resource_occupancy() const noexcept {
    // #7955/r12: frozen ledger metadata only. No SDK dereference, allocation,
    // retirement, quota refund, or inference that an unmarked node is disposable.
    // The physical node table is capped at 65536 by Ledger's constructor.
    std::array<unsigned char,65536> marked{};
    std::array<uint32_t,11> kinds{};
    uint32_t alive=0,dead=0,live_current=0,invalid=0,subdivision_live=0;
    auto mark=[&](Identity id) {
        if(!id.sequence) return;
        const auto* n=node(id);
        if(!n) {
            for(const auto& token:read_bindings) if(token.alive && token.current==id) return;
            ++invalid; return;
        }
        marked[size_t(n-nodes.data())]=1;
    };
    for(const auto& b:bindings) if(b.address) {
        if(!b.alive) { ++dead; continue; }
        ++alive;
        const auto* current=node(b.current);
        if(current && !marked[size_t(current-nodes.data())]) ++live_current;
        mark(b.current);
        subdivision_live+=b.subdivision_operation.sequence!=0;
    }
    for(uint32_t i=0;i<numerical.retained_nodes && i<node_count;++i) marked[i]=1;
    for(const auto& b:bindings) if(b.alive)
        for(auto id:{b.numerical_operation,b.owned_transition,b.numerical_parent,b.numerical_owner_copy_operation,
            b.numerical_parent_owner,b.numerical_face_input,b.subdivision_operation,b.subdivision_owner}) mark(id);
    for(uint32_t i=0;i<root_count;++i) mark(root_records[i].identity);
    mark(numerical.operation); mark(numerical.copy_generation);
    for(const auto& polygon:numerical.polygons) mark(polygon.input);
    for(uint32_t i=node_count;i>0;--i) if(marked[i-1])
        for(auto parent:nodes[i-1].parent) mark(parent);
    uint32_t reachable=0;
    for(uint32_t i=0;i<node_count;++i) { reachable+=marked[i]!=0; ++kinds[unsigned(nodes[i].change)]; }
    std::fprintf(stderr,"lineage quota_census nodes=%u node_limit=%u events=%u event_limit=%u "
        "alive_bindings=%u dead_bindings=%u live_current_nodes=%u authority_reachable_nodes=%u "
        "other_nodes=%u missing_identity_refs=%u subdivision_uv_live=%u retained_nodes=%u retained_events=%u "
        "binding_capacity=%zu issued_sequence=%llu\n",node_count,limits.nodes,event_count,limits.events,
        alive,dead,live_current,reachable,node_count-reachable,invalid,subdivision_live,
        numerical.retained_nodes,numerical.retained_events,bindings.size(),static_cast<unsigned long long>(issued_sequence));
    std::fprintf(stderr,"lineage quota_node_kinds construct=%u admit=%u copy=%u split=%u merge=%u "
        "remove=%u add=%u destroy=%u edit=%u audit=%u\n",kinds[0],kinds[1],kinds[2],kinds[3],kinds[4],
        kinds[5],kinds[6],kinds[7],kinds[8],kinds[9]);
    std::fprintf(stderr,"lineage read_census live=%u limit=%u callbacks=%u callback_limit=%u capacity=%zu\n",
        read_live,limits.read_objects,read_callbacks,limits.read_callbacks,read_bindings.size());
    if(subdivision) subdivision->report_exception();
}
void Ledger::report_failure_stack() const noexcept {
    if(failure==Failure::NodeLimit || failure==Failure::EventLimit ||
        failure==Failure::ReadObjectLimit || failure==Failure::ReadCallbackLimit) report_resource_occupancy();
    std::fprintf(stderr,"lineage diagnostic_events total=%u capacity=%zu numerical_source=%p operation=%llu frame=%u serial=%llu\n",
        failed_event,diagnostic_events.size(),static_cast<void*>(numerical.source),
        static_cast<unsigned long long>(numerical.operation.sequence),numerical.frame,
        static_cast<unsigned long long>(numerical.serial));
    const auto recorded=numerical.tessellation?read_callbacks:event_count;
    const auto first=recorded>diagnostic_events.size()?recorded-uint32_t(diagnostic_events.size()):0;
    for(uint32_t i=first;i<recorded;++i) {
        const auto& t=diagnostic_events[i%diagnostic_events.size()];
        if(t.event!=i+1) continue; // a discharged numerical journal is no longer retained
        std::fprintf(stderr,"lineage event=%u frame=%u op=%ld type=%ld caller=%zx a=%zx b=%zx c=%zx generation=%llu numerical=%llu alive=%u retired=%u\n",
            t.event,t.frame,t.operation,t.type,size_t(t.caller),size_t(t.a),size_t(t.b),size_t(t.c),
            static_cast<unsigned long long>(t.generation.sequence),
            static_cast<unsigned long long>(t.numerical_operation.sequence),unsigned(t.alive),unsigned(t.retired));
    }
    for(auto* trim:numerical.trims)
        std::fprintf(stderr,"lineage inventoried_trim=%p\n",static_cast<void*>(trim));
    std::fprintf(stderr,"lineage first_failure_stack frames=%u capacity=%zu sdk=c9c5979f04cea8c38213004d4f04df0dcfb40d05\n",
        failed_stack.size,failed_stack.frames.size());
    // Symbol output includes binary-relative offsets for offline addr2line.
    // Full capacity means the trace may be truncated; never imply completeness.
    ::backtrace_symbols_fd(failed_stack.frames.data(),int(failed_stack.size),STDERR_FILENO);
    std::fprintf(stderr,"lineage first_failure_stack end\n");
}
}
