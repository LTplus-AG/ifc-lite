// SPDX-License-Identifier: MPL-2.0
// #7955 J5-STATIC-01: real global latch with an independently healthy ledger.
#include "owned_lineage_access.hpp"
#include "copy.hpp"
#include "failure.hpp"
#include <cstring>
#include <stdexcept>
#include <utility>
namespace {
using namespace face_lineage;
void require(bool ok,const char* why) { if(!ok) throw std::runtime_error(why); }
}
void owned_terminal_refusal(const char* operation) {
    auto moved=OwnedBoundary::box(2,3,4);
    const auto root=moved.faces().front();
    auto owner=std::move(moved);
    const auto& ledger=OwnedBoundaryTestAccess::ledger(owner);
    const auto events=ledger.event_size(),nodes=ledger.node_size();
    require(ledger.failed()==Failure::None,"terminal fixture starts with healthy owned ledger");
    try {
        try { throw AdapterFailure{IFCLITE_SMLIB_KERNEL_ERROR,"independent injected terminal fault"}; }
        catch(...) { rethrow_tainted_kernel_domain("owned terminal regression"); }
    } catch(const KernelDomainTainted&) {
        require(kernel_domain_is_tainted(),"real terminal latch must be set");
    }
    bool rejected=false;
    std::unique_ptr<AdapterMesh> mesh;
    try {
        if(std::strcmp(operation,"terminal-faces")==0) (void)owner.faces();
        else if(std::strcmp(operation,"terminal-tessellate")==0) mesh=owner.tessellate(0.01,15);
        else if(std::strcmp(operation,"terminal-ancestors")==0) (void)owner.ancestors(root);
        else if(std::strcmp(operation,"terminal-copy")==0) (void)owner.copy();
        else throw std::runtime_error("unknown terminal witness selector");
    } catch(const KernelDomainTainted&) { rejected=true; }
    require(rejected && !mesh && ledger.failed()==Failure::None &&
        ledger.event_size()==events && ledger.node_size()==nodes,
        "terminal owner refuses before SDK events or mesh publication");
    // Terminal takes precedence even on a moved-from receiver, for every method.
    const auto terminal=[&](auto action) {
        bool refused=false;
        try { action(); } catch(const KernelDomainTainted&) { refused=true; }
        require(refused,"terminal policy includes moved-from and unsupported owner methods");
    };
    terminal([&] { (void)moved.faces(); });
    terminal([&] { (void)moved.copy(); });
    terminal([&] { (void)moved.ancestors(root); });
    terminal([&] { (void)moved.tessellate(0.01,15); });
    terminal([&] { (void)owner.affine(nullptr); });
    terminal([&] { (void)owner.boolean(owner,IFCLITE_SMLIB_UNION); });
    terminal([&] { (void)owner.clip(nullptr,1,IFCLITE_SMLIB_INTERSECTION); });
    require(!mesh && ledger.failed()==Failure::None && ledger.event_size()==events && ledger.node_size()==nodes,
        "terminal refusal leaves healthy ledger and SDK event stream unchanged");
    // No reset: caller exits this process/module. Owner abandons SDK allocations.
}
void owned_moved_from_refusal() {
    auto moved=OwnedBoundary::box(2,3,4);
    const auto root=moved.faces().front();
    auto owner=std::move(moved);
    const auto& ledger=OwnedBoundaryTestAccess::ledger(owner);
    const auto events=ledger.event_size();
    const auto invalid=[&](auto action) {
        bool rejected=false;
        try { action(); } catch(const AdapterFailure& e) { rejected=e.status==IFCLITE_SMLIB_INVALID_ARGUMENT; }
        require(rejected,"moved-from owner refuses before SDK access");
    };
    invalid([&] { (void)moved.faces(); });
    invalid([&] { (void)moved.copy(); });
    invalid([&] { (void)moved.ancestors(root); });
    invalid([&] { (void)moved.tessellate(0.01,15); });
    invalid([&] { (void)moved.affine(nullptr); });
    invalid([&] { (void)moved.boolean(owner,IFCLITE_SMLIB_UNION); });
    invalid([&] { (void)moved.clip(nullptr,1,IFCLITE_SMLIB_INTERSECTION); });
    require(!kernel_domain_is_tainted() && ledger.failed()==Failure::None && ledger.event_size()==events &&
        owner.faces().size()==6,"moved-from refusal preserves moved-to owner");
}
