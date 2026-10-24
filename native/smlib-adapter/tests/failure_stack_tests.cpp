// SPDX-License-Identifier: MPL-2.0
// #7955: diagnostic evidence is bounded and belongs to the FIRST refusal.
#include "face_lineage.hpp"
#include "failure.hpp"
#include <SmApiGeneral.h>
#include <SmLine.h>
#include <cstdio>
#include <stdexcept>
namespace {
void require(bool value,const char* message) {
    if(!value) throw std::runtime_error(message);
}
}
int main() {
    try {
        SmApiCreateContext();
        face_lineage::Ledger ledger({8192,1,1024,16});
        face_lineage::Scope observation(ledger,*SmApiGetOrCreateContext());
        // Actual SDK constructor callbacks exhaust the one-event budget.
        SmLine first;
        SmLine second;
        const auto origin=ledger.failure_origin();
        const auto stack=ledger.failure_stack();
        require(origin.failure==face_lineage::Failure::EventLimit,
            "diagnostic constructor witness must hit the actual event budget");
        require(stack.size>0 && stack.size<=stack.frames.size() && stack.frames[0],
            "first refusal captures a bounded native stack");
        // Later SDK callbacks and repeated reports must preserve exact evidence.
        SmLine third;
        for(unsigned i=0;i<2;++i) {
            bool refused=false;
            try { ledger.check(); } catch(const AdapterFailure&) { refused=true; }
            require(refused,"diagnostics cannot turn a failed ledger into success");
        }
        const auto after=ledger.failure_stack();
        const auto later=ledger.failure_origin();
        require(stack.size==after.size && stack.frames==after.frames &&
            origin.failure==later.failure && origin.operation==later.operation &&
            origin.event==later.event && origin.frame==later.frame && origin.nodes==later.nodes &&
            origin.caller_type==later.caller_type,
            "later callbacks preserve the first refusal stack and origin");
        std::fprintf(stderr,"lineage failure stack witness PASS\n");
        return 0;
    } catch(const std::exception& e) {
        std::fprintf(stderr,"failure stack FAIL: %s\n",e.what());
    } catch(...) { std::fprintf(stderr,"failure stack FAIL: unexpected SDK failure\n"); }
    return 1;
}
