// SPDX-License-Identifier: MPL-2.0
#pragma once
#include <SmContext.h>
#include <array>
#include <cstdint>
#include <memory>
#include <vector>
class SmBrep;
class SmFace;
class SmObject;
class SmCopyBrepMap;
class SmSurface;
namespace face_lineage {
// Private adapter evidence only. Runtime sealing under the actual incarnation
// and original issued source/operation remains mandatory; no wire authority.
struct Identity {
    uint64_t domain=0,sequence=0;
    bool operator==(Identity other) const { return domain==other.domain && sequence==other.sequence; }
    bool operator!=(Identity other) const { return !(*this==other); }
};
struct ObjectRevision {
    uint64_t incarnation=0,session=0;
    uint32_t slot=0,generation=0;
    uint64_t revision=0,operation=0;
};
enum class RootKind { SourceBoundary,GeneratedInterface,DerivedAuxiliary };
struct Seed { SmFace* face=nullptr; RootKind kind=RootKind::SourceBoundary; };
struct Root {
    Identity identity;
    ObjectRevision object;
    RootKind kind=RootKind::SourceBoundary;
};
struct Limits { uint32_t nodes=8192,events=32768,roots=1024,callback_depth=16; };
enum class Failure {
    None,NodeLimit,EventLimit,RootLimit,UnknownHistory,DuplicateInventory,
    InvalidInventory,InvalidEvent,ForeignStatus,ForeignException,CallbackReplaced,
    ReentrantCallback,CallbackDepthLimit,ReadOnlyMutation,UnreportedCopy,UnsupportedGeometryChange,ObservationGap,RepresentationChanged,UntrustedCallback
};
// Scalar diagnostic evidence only; never an ancestry or operation credential.
struct FailureOrigin {
    Failure failure=Failure::None;
    SmNotifyOperation operation=SM_NO_UNKNOWN;
    long caller_type=0;
    uint32_t event=0,frame=0,nodes=0;
};
enum class Change { Construct,Admit,Copy,Split,Merge,Remove,Add,Destroy,Edit,AuditBoundary };
enum class Phase { Mutation,InitialConstruction };
struct Event {
    SmNotifyOperation operation=SM_NO_UNKNOWN;
    Identity before[2]{},after[2]{};
};
class Scope;
class Ledger {
    struct Creation {
        SmBrep* object=nullptr;
        SmSurface* surface=nullptr;
        SmFace* face=nullptr;
        Identity generation{},operation{};
        ObjectRevision revision{};
        uint32_t frame=0,transitions=0,owner_limit=11;
        bool active=false;
    } creation;
    std::unique_ptr<class RepresentationSeal> creation_seal;
    struct Node {
        Identity parent[2]{};
        uint32_t root=UINT32_MAX;
        Change change=Change::Construct;
        bool complete=false;
    };
    struct Binding {
        uintptr_t address=0;
        Identity current{};
        SmBrep* owner=nullptr;
        uint32_t birth_frame=0;
        bool alive=false,retired=false,removed=false,newborn=false,initial_issuance=false,numerical_initialized=false;
    };
    Limits limits;
    uint64_t domain;
    SmContext* context=nullptr;
    Failure failure=Failure::None;
    SmNotifyOperation current_operation=SM_NO_UNKNOWN,failed_operation=SM_NO_UNKNOWN;
    long current_type=0,failed_type=0;
    uint32_t current_event=0,failed_event=0,failed_frame=0,failed_nodes=0;
    mutable bool failure_reported=false;
    uint32_t node_count=0,event_count=0,root_count=0;
    bool attached=false,closed=false;
    Scope* observer=nullptr;
    std::array<Scope*,64> frames{};
    std::array<SmBrep*,64> protected_sources{};
    uint32_t frame_count=0;
    std::vector<Node> nodes;
    std::vector<Binding> bindings;
    std::vector<Root> root_records;
    std::vector<Event> events;
    std::vector<uint32_t> visited;
    Binding* binding(SmObject*,bool create) noexcept;
    Identity append(Change,Identity={},Identity={},uint32_t root=UINT32_MAX) noexcept;
    const Node* node(Identity) const noexcept;
    bool complete(Identity) const noexcept;
    bool face(SmObject*) const;
    bool readonly(SmBrep*) const noexcept;
    void observe(SmNotifyOperation,SmObject*,SmObject*,SmObject*,SmObject*) noexcept;
    void transition(Event&,SmNotifyOperation,SmObject*,SmObject*,SmObject*,SmObject*);
    void guard_numerical(SmNotifyOperation,SmObject*,SmObject*,SmObject*,SmObject*);
    void affect_numerical_owner(SmObject*,bool initialization);
    void affect_numerical_face(SmFace*,bool initialization);
    void replace(Binding*,Identity) noexcept;
    void fail(Failure value) noexcept {
        if(failure==Failure::None) { failure=value; failed_operation=current_operation; failed_type=current_type; failed_event=current_event?current_event:event_count; failed_frame=frame_count; failed_nodes=node_count; }
    }
    bool creation_owner(SmObject*,SmObject*,SmObject*) noexcept;
    void protect(SmBrep*);
    friend class Scope;
    friend class RepresentationSeal;
    friend class GeneratedPlane;
public:
    explicit Ledger(Limits={});
    ~Ledger();
    Ledger(const Ledger&)=delete;
    Ledger& operator=(const Ledger&)=delete;
    // Under continuous Scope observation, only at explicit source/cutter issuance,
    // with complete
    // live inventory and independently issued revision binding. Never use this
    // to relabel a prior Boolean/copy whose ancestry has already been lost.
    void admit_roots(SmBrep&,const ObjectRevision&,const Seed*,uint32_t count);
    void check() const;
    Failure failed() const noexcept { return failure; }
    FailureOrigin failure_origin() const noexcept {
        return {failure,failed_operation,failed_type,failed_event,failed_frame,failed_nodes};
    }
    void verify_inventory(SmBrep&);
    void verify_copy(const SmBrep&,SmBrep&,const SmCopyBrepMap&,const SmCopyBrepMap&);
    Identity identity(SmFace*) const;
    // Queries use bounded preallocated scratch; no concurrent use of a ledger.
    bool descends_from(Identity,Identity);
    uint32_t roots(Identity,Root* output,uint32_t capacity);
    const Event& event(uint32_t index) const;
    uint32_t event_size() const noexcept { return event_count; }
    uint32_t node_size() const noexcept { return node_count; }
};
// The outer Scope observes the ENTIRE lifetime of rooted objects. Inner SDK
// phases borrow it, with bounded per-frame source protection. Closing the outer
// observer with live rooted faces invalidates history; it cannot be reattached.
// Owns only the nestable user slot. The SDK system slot is never changed.
// All callback errors latch; check() after each SDK phase before acceptance.
class Scope final:public SmNotifyCallback {
    Ledger& ledger;
    SmContext& context;
    SmNotifyCallback* previous;
    bool installed=false,owns_callback=false;
    uint32_t frame=0;
    uint32_t depth=0;
    Phase phase;
    friend class Ledger;
    friend class GeneratedPlane;
public:
    Scope(Ledger&,SmContext&,SmBrep* readonly_source=nullptr,Phase=Phase::Mutation);
    Scope(const Scope&)=delete;
    Scope& operator=(const Scope&)=delete;
    ~Scope();
    void finish() noexcept;
    SmStatus Execute(SmNotifyOperation,SmObject*,SmObject*,SmObject*,SmObject*) noexcept override;
};
}
