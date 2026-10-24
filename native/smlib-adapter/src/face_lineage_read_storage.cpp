// SPDX-License-Identifier: MPL-2.0
#include "face_lineage.hpp"
#include "failure.hpp"
#include "ifclite_smlib.h"
#include <functional>
#include <algorithm>
namespace face_lineage {
bool Ledger::read_frame() const noexcept {
    return numerical.tessellation && numerical.operation.sequence && frame_count &&
        numerical.frame==frame_count && numerical.serial==frames[frame_count-1]->serial;
}
bool Ledger::temporary(const Binding* entry) const noexcept {
    if(!entry || read_bindings.empty()) return false;
    const std::less<const Binding*> less;
    return !less(entry,read_bindings.data()) && less(entry,read_bindings.data()+read_bindings.size());
}
void Ledger::prepare_read_storage() {
    check();
    if(numerical.tessellation || read_live)
        throw AdapterFailure{IFCLITE_SMLIB_UNSUPPORTED,"unfinished read storage cannot be replaced"};
    // Size and total byte ceiling were checked by Ledger before allocation.
    // 2x capacity keeps open addressing below 50% occupied, independently of
    // the ancestry journal. No callback allocates or grows this table.
    read_bindings.assign(2*size_t(limits.read_objects)+1,Binding{});
    read_peak=read_callbacks=0; read_trace={};
#ifdef IFCLITE_LINEAGE_FAILURE_STACK
    diagnostic_events={};
#endif
}
Ledger::Binding* Ledger::read_binding(SmObject* object,bool create) noexcept {
    if(!object || read_bindings.empty()) return nullptr;
    const auto address=reinterpret_cast<uintptr_t>(object);
    size_t index=(address/alignof(void*))%read_bindings.size();
    for(size_t probes=0;probes<read_bindings.size();++probes,index=(index+1)%read_bindings.size()) {
        auto& entry=read_bindings[index];
        if(entry.address==address) return &entry;
        if(!entry.address) {
            if(!create) return nullptr;
            if(!read_frame()) { fail(Failure::InvalidEvent); return nullptr; }
            if(read_live==limits.read_objects) { fail(Failure::ReadObjectLimit); return nullptr; }
            entry.address=address; ++read_live; read_peak=std::max(read_peak,read_live); return &entry;
        }
    }
    fail(Failure::ReadObjectLimit); return nullptr;
}
Identity Ledger::lifetime(Binding* entry,Change change,Identity parent) noexcept {
    if(!temporary(entry)) return append(change,parent);
    if(failure!=Failure::None) return {};
    if(!read_frame() || (change!=Change::Construct && change!=Change::Edit) ||
        (change==Change::Construct && (entry->alive || parent.sequence)) ||
        (change==Change::Edit && (!entry->alive || entry->retired || entry->current!=parent))) {
        fail(Failure::UnknownHistory); return {};
    }
    if(issued_sequence==UINT64_MAX) { fail(Failure::NodeLimit); return {}; }
    entry->constructed=change==Change::Construct;
    return {domain,++issued_sequence}; // lifetime token only: no ancestry node
}
bool Ledger::constructed(const Binding* entry) const noexcept {
    if(!entry) return false;
    if(temporary(entry)) return entry->constructed;
    const auto* birth=node(entry->current); return birth && birth->change==Change::Construct;
}
bool Ledger::refund_read_binding(SmObject* object,Identity generation) noexcept {
    auto* entry=read_binding(object,false);
    if(!entry || entry->alive || !entry->retired || entry->current!=generation || !read_live) return false;
    // Backshift deletion closes the probe chain; it leaves no tombstone that
    // could make an old address a constructor credential or consume capacity.
    // No SDK dereference is needed after its destructor notification.
    const size_t size=read_bindings.size();
    size_t hole=size_t(entry-read_bindings.data()),next=(hole+1)%size;
    while(read_bindings[next].address) {
        const size_t home=(read_bindings[next].address/alignof(void*))%size;
        if((hole+size-home)%size < (next+size-home)%size) {
            read_bindings[hole]=read_bindings[next]; hole=next;
        }
        next=(next+1)%size;
    }
    read_bindings[hole]=Binding{};
    --read_live; // one actual destruction refunds one live slot; never sequence
    return true;
}
}
