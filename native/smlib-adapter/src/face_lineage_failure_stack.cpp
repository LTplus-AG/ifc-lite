// SPDX-License-Identifier: MPL-2.0
#include "face_lineage.hpp"
#include <execinfo.h>
#include <cstdio>
#include <unistd.h>
namespace face_lineage {
void Ledger::trace_event(SmNotifyOperation op,SmObject* caller,SmObject* a,SmObject* b,SmObject* c) noexcept {
    auto& trace=diagnostic_events[(event_count-1)%diagnostic_events.size()];
    trace={}; trace.event=event_count; trace.frame=frame_count;
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
void Ledger::report_failure_stack() const noexcept {
    std::fprintf(stderr,"lineage diagnostic_events total=%u capacity=%zu numerical_source=%p operation=%llu frame=%u serial=%llu\n",
        failed_event,diagnostic_events.size(),static_cast<void*>(numerical.source),
        static_cast<unsigned long long>(numerical.operation.sequence),numerical.frame,
        static_cast<unsigned long long>(numerical.serial));
    const auto recorded=event_count;
    const auto first=recorded>diagnostic_events.size()?recorded-uint32_t(diagnostic_events.size()):0;
    for(uint32_t i=first;i<recorded;++i) {
        const auto& t=diagnostic_events[i%diagnostic_events.size()];
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
