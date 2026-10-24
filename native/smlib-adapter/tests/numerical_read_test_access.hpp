// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "edge_subdivision.hpp"
#include <stdexcept>
namespace face_lineage {
// Test-only read diagnostics, never an ancestry/receipt credential.
struct ReadAccountingTestAccess {
    static uint32_t event_size(const Ledger& l) { return l.numerical.tessellation?l.read_callbacks:l.event_size(); }
    static const Event& event(const Ledger& l,uint32_t i) {
        if(!l.numerical.tessellation) return l.event(i);
        if(i>=l.read_callbacks || l.read_callbacks-i>l.read_trace.size())
            throw std::runtime_error("read trace diagnostic index expired");
        return l.read_trace[i%l.read_trace.size()];
    }
    static void limits(Ledger& l,uint32_t objects,uint32_t callbacks) {
        // Only reduce constructor-validated limits, before allocation.
        if(l.numerical.tessellation || !objects || objects>l.limits.read_objects ||
            !callbacks || callbacks>l.limits.read_callbacks) throw std::runtime_error("invalid test quota");
        l.limits.read_objects=objects; l.limits.read_callbacks=callbacks;
    }
    static uint32_t live(const Ledger& l) { return l.read_live; }
    static Limits quotas(const Ledger& l) { return l.limits; }
    static Identity durable_constructor(Ledger& l,SmObject* object) {
        const auto* b=l.binding(object,false);
        const auto* n=b?l.node(b->current):nullptr;
        return b && !l.temporary(b) && b->alive && !b->retired && n && n->change==Change::Construct?
            b->current:Identity{};
    }
    static Identity identity(Ledger& l,SmObject* o) {
        const auto* b=l.read_binding(o,false); return b?b->current:Identity{};
    }
    static bool refund(Ledger& l,SmObject* o,Identity id) { return l.refund_read_binding(o,id); }
};
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
