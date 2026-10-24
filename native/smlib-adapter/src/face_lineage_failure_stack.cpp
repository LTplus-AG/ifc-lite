// SPDX-License-Identifier: MPL-2.0
#include "face_lineage.hpp"
#include <execinfo.h>
#include <cstdio>
#include <unistd.h>
namespace face_lineage {
void Ledger::capture_failure_stack() noexcept {
    // Called only AFTER the first-failure latch is set, while the SDK call
    // stack still exists. No SDK getters, event replay, or acceptance changes.
    // execinfo may lazily load its unwinder: this is an opt-in diagnostic build,
    // not a bounded-allocation production callback or performance measurement.
    const int count=::backtrace(failed_stack.frames.data(),int(failed_stack.frames.size()));
    failed_stack.size=count>0?uint32_t(count):0;
}
void Ledger::report_failure_stack() const noexcept {
    std::fprintf(stderr,"lineage first_failure_stack frames=%u capacity=%zu sdk=c9c5979f04cea8c38213004d4f04df0dcfb40d05\n",
        failed_stack.size,failed_stack.frames.size());
    // Symbol output includes binary-relative offsets for offline addr2line.
    // Full capacity means the trace may be truncated; never imply completeness.
    ::backtrace_symbols_fd(failed_stack.frames.data(),int(failed_stack.size),STDERR_FILENO);
    std::fprintf(stderr,"lineage first_failure_stack end\n");
}
}
