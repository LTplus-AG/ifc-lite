// SPDX-License-Identifier: MPL-2.0
#include "face_lineage.hpp"
#include "sweep.hpp"
#include "ifclite_smlib.h"
#include "empty.hpp"
#include "representation_seal.hpp"
#include <SmBrep.h>
#include <SmCopyBrepMap.h>
#include <SmFace.h>
#include <algorithm>
#include <atomic>
#include <limits>
#include <cstdio>
namespace face_lineage {
namespace {
std::atomic<uint64_t> next_domain{1};
void require(bool value,const char* message) {
    if(!value) throw SweepFailure{IFCLITE_SMLIB_UNSUPPORTED,message};
}
bool valid(const ObjectRevision& o) {
    return o.incarnation && o.session && o.generation && o.revision;
}
}
Ledger::Ledger(Limits requested):limits(requested),domain(0) {
    // Checked before any adapter allocation. Fixed tables never grow in a
    // callback. Defaults use under 8 MiB; all admitted configurations <=64 MiB.
    require(limits.nodes && limits.nodes<=65536 && limits.events && limits.events<=131072 &&
        limits.roots && limits.roots<=limits.nodes && limits.callback_depth && limits.callback_depth<=64,
        "invalid lineage resource limits");
    const uint64_t bytes=uint64_t(limits.nodes)*(sizeof(Node)+sizeof(uint32_t))+
        (2*uint64_t(limits.nodes)+1)*sizeof(Binding)+uint64_t(limits.roots)*sizeof(Root)+
        uint64_t(limits.events)*sizeof(Event)+8192*sizeof(SmObject*);
    require(bytes<=64*1024*1024,"lineage storage exceeds fixed adapter limit");
    uint64_t expected=next_domain.load();
    do {
        require(expected!=UINT64_MAX,"lineage domain identity exhausted");
    } while(!next_domain.compare_exchange_weak(expected,expected+1));
    domain=expected;
    nodes.resize(limits.nodes); bindings.resize(2*size_t(limits.nodes)+1);
    root_records.resize(limits.roots); events.resize(limits.events);
    visited.resize(limits.nodes);
}
Ledger::~Ledger()=default;
const Ledger::Node* Ledger::node(Identity id) const noexcept {
    return id.domain==domain && id.sequence && id.sequence<=node_count?&nodes[id.sequence-1]:nullptr;
}
bool Ledger::complete(Identity id) const noexcept {
    const auto* n=node(id); return n && n->complete;
}
Ledger::Binding* Ledger::binding(SmObject* object,bool create) noexcept {
    if(!object) return nullptr;
    const auto address=reinterpret_cast<uintptr_t>(object);
    size_t i=(address/alignof(void*))%bindings.size();
    for(size_t step=0;step<bindings.size();++step,i=(i+1)%bindings.size()) {
        auto& b=bindings[i];
        if(b.address==address) return &b;
        if(!b.address) {
            if(!create) return nullptr;
            b.address=address; return &b;
        }
    }
    fail(Failure::NodeLimit); return nullptr;
}
Identity Ledger::append(Change kind,Identity a,Identity b,uint32_t root) noexcept {
    if(failure!=Failure::None) return {};
    if(node_count==limits.nodes) { fail(Failure::NodeLimit); return {}; }
    Node n; n.change=kind; n.parent[0]=a; n.parent[1]=b; n.root=root;
    n.complete=root!=UINT32_MAX || (complete(a) && (!b.sequence || complete(b)));
    nodes[node_count++]=n;
    return {domain,node_count};
}
void Ledger::replace(Binding* b,Identity id) noexcept {
    if(b && id.sequence) { b->current=id; b->alive=true; b->retired=false; b->removed=false; }
}
bool Ledger::readonly(SmBrep* owner) const noexcept {
    if(!owner) return false;
    for(uint32_t i=0;i<frame_count;++i) if(protected_sources[i]==owner) return true;
    return false;
}
void Ledger::check() const {
    if(failure==Failure::None) return;
    if(!failure_reported) {
        failure_reported=true;
        std::fprintf(stderr,"lineage first_failure=%u event=%u operation=%ld caller_type=%ld frame=%u nodes=%u\n",
            unsigned(failure),failed_event,long(failed_operation),failed_type,failed_frame,failed_nodes);
    }
    const bool resource=failure==Failure::NodeLimit || failure==Failure::EventLimit || failure==Failure::RootLimit ||
        failure==Failure::CallbackDepthLimit;
    throw SweepFailure{resource?IFCLITE_SMLIB_RESOURCE_LIMIT:IFCLITE_SMLIB_UNSUPPORTED,
        resource?"bounded face lineage storage exhausted":"face lineage history/callback verification failed"};
}
void Ledger::admit_roots(SmBrep& source,const ObjectRevision& object,const Seed* seeds,uint32_t count) {
    check();
    require(attached && !closed && source.GetContext() && valid(object) && (seeds || !count),
        "root admission requires explicit issued object revision and bounded face inventory");
    if(observer->previous || context->GetSysNotifyCallback() || context->GetAttributeCallbacks()) {
        fail(Failure::UntrustedCallback); check();
    }
    if(count>limits.roots-root_count) { fail(Failure::RootLimit); check(); }
    require(!context || context==source.GetContext(),"lineage cannot cross SDK contexts");
    require(source.GetNumFaces()==count,"root admission must cover every actual live face");
    require(count || semantically_empty_brep(&source),"faceless nonempty source has no admissible boundary ancestry");
    SmTArray<SmFace*> faces; source.GetFaces(faces);
    require(faces.GetSize()==count,"source face inventory changed during root admission");
    // Preflight the ENTIRE admission before issuing a single root.
    for(uint32_t i=0;i<count;++i) {
        uint32_t hits=0; for(auto* f:faces) hits+=f==seeds[i].face;
        require(hits==1,"missing/foreign live root seed");
        require(seeds[i].face && seeds[i].face->GetBrep()==&source &&
            seeds[i].face->GetType()==SmFace_TYPE,"root seed is not an actual source face");
        for(uint32_t j=0;j<i;++j) require(seeds[j].face!=seeds[i].face,"duplicate root seed");
        auto* existing=binding(seeds[i].face,false);
        if(existing) {
            const auto* n=node(existing->current);
            const auto* parent=n?node(n->parent[0]):nullptr;
            const bool constructor_only=n && !n->complete &&
                (n->change==Change::Construct || (n->change==Change::Add && parent &&
                 parent->change==Change::Construct && !n->parent[1].sequence));
            require(existing->alive && !existing->retired && !existing->removed && existing->newborn &&
                existing->initial_issuance && existing->birth_frame==frame_count && constructor_only &&
                frames[frame_count-1]->phase==Phase::InitialConstruction,
                "only current audited constructor-only history permits first root issuance");
        }
        require(seeds[i].kind==RootKind::SourceBoundary || seeds[i].kind==RootKind::GeneratedInterface ||
            seeds[i].kind==RootKind::DerivedAuxiliary,"unknown boundary origin kind");
        require(seeds[i].kind==RootKind::SourceBoundary || object.operation,"generated root requires issued operation");
    }
    if(count>limits.nodes-node_count) { fail(Failure::NodeLimit); check(); }
    if(creation.object==&source && creation_seal) {
        require(count==1 && seeds[0].kind==RootKind::GeneratedInterface,
            "generated plane receipt permits only its actual generated-interface root");
        const auto& r=creation.revision;
        require(object.incarnation==r.incarnation && object.session==r.session && object.slot==r.slot &&
            object.generation==r.generation && object.revision==r.revision && object.operation==r.operation,
            "generated construction receipt does not bind the actual issued object revision");
        creation_seal->verify();
    }
    context=const_cast<SmContext*>(source.GetContext());
    for(uint32_t i=0;i<count;++i) {
        auto* b=binding(seeds[i].face,true);
        const auto id=append(Change::Admit,{},{},root_count);
        root_records[root_count++]={id,object,seeds[i].kind}; replace(b,id); b->owner=&source; b->initial_issuance=false;
    }
    if(creation.object==&source) { creation_seal.reset(); creation={}; }
    check();
}
Identity Ledger::identity(SmFace* face) const {
    auto* b=const_cast<Ledger*>(this)->binding(face,false);
    require(b && b->alive && !b->retired && complete(b->current),"face has no live complete lineage");
    check(); return b->current;
}
void Ledger::verify_inventory(SmBrep& solid) {
    check();
    if(!attached || closed) { fail(Failure::ObservationGap); check(); }
    if(observer->previous || context->GetSysNotifyCallback() || context->GetAttributeCallbacks()) {
        fail(Failure::UntrustedCallback); check();
    }
    if(solid.GetContext()!=context || solid.GetNumFaces()>limits.nodes) { fail(Failure::InvalidInventory); check(); }
    if(!solid.GetNumFaces() && !semantically_empty_brep(&solid)) { fail(Failure::UnknownHistory); check(); }
    SmTArray<SmFace*> live; solid.GetFaces(live);
    if(live.GetSize()!=solid.GetNumFaces()) { fail(Failure::InvalidInventory); check(); }
    for(ULONG i=0;i<live.GetSize();++i) {
        auto* b=binding(live[i],false);
        if(!b || !b->alive || b->retired || b->removed || b->owner!=&solid || !complete(b->current) || live[i]->GetBrep()!=&solid)
            fail(Failure::UnknownHistory);
        for(ULONG j=0;j<i;++j) if(live[j]==live[i]) fail(Failure::DuplicateInventory);
    }
    check();
}
void Ledger::verify_copy(const SmBrep& source,SmBrep& target,const SmCopyBrepMap& forward,const SmCopyBrepMap& reverse) {
    verify_inventory(target);
    if(source.GetNumFaces()!=target.GetNumFaces()) { fail(Failure::InvalidInventory); check(); }
    SmTArray<SmFace*> from,to; source.GetFaces(from); target.GetFaces(to);
    for(auto* f:from) {
        auto* mapped=reverse.GetAt(f);
        uint32_t hits=0; SmFace* actual=nullptr;
        for(auto* t:to) if(t==mapped) { ++hits; actual=t; }
        if(hits!=1 || forward.GetAt(mapped)!=f || !descends_from(identity(actual),identity(f)))
            fail(Failure::UnreportedCopy);
    }
    check();
}
void Ledger::protect(SmBrep* source) {
    if(!source) return;
    verify_inventory(*source);
}
bool Ledger::descends_from(Identity id,Identity ancestor) {
    check(); require(node(id) && node(ancestor),"foreign/stale lineage query identity");
    // Parents always precede children. Descending index traversal needs no
    // recursion and visits each node at most once, including shared DAGs.
    std::fill(visited.begin(),visited.begin()+node_count,0);
    visited[id.sequence-1]=1;
    for(uint64_t i=id.sequence;i;--i) if(visited[i-1]) {
        if(i==ancestor.sequence) return true;
        for(auto parent:nodes[i-1].parent) if(parent.sequence) visited[parent.sequence-1]=1;
    }
    return false;
}
uint32_t Ledger::roots(Identity id,Root* output,uint32_t capacity) {
    check(); require(complete(id) && output,"complete lineage and bounded output storage required");
    std::fill(visited.begin(),visited.begin()+node_count,0); visited[id.sequence-1]=1;
    uint32_t count=0;
    for(uint64_t i=id.sequence;i;--i) if(visited[i-1]) {
        const auto& n=nodes[i-1];
        if(n.root!=UINT32_MAX) {
            if(count==capacity) throw SweepFailure{IFCLITE_SMLIB_RESOURCE_LIMIT,"lineage root query output exhausted"};
            output[count++]=root_records[n.root];
        }
        for(auto parent:n.parent) if(parent.sequence) visited[parent.sequence-1]=1;
    }
    return count;
}
const Event& Ledger::event(uint32_t index) const {
    require(index<event_count,"lineage event index out of bounds"); return events[index];
}
}
