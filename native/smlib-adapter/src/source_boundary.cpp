// SPDX-License-Identifier: MPL-2.0
#include "source_boundary.hpp"
#include "source_construction.hpp"
#include "sweep.hpp"
#include "copy.hpp"
#include "affine.hpp"
#include "representation_seal.hpp"
#include <SmFace.h>
namespace face_lineage {
namespace {
uint32_t live_domains=0;
void require(bool value,const char* why) { if(!value) throw AdapterFailure{IFCLITE_SMLIB_UNSUPPORTED,why}; }
}
SourceBoundary::State::State():context(new SmContext()),inventory(std::make_shared<SourceInventory>()) { ++live_domains; }
SourceBoundary::State::~State() { --live_domains; if(kernel_domain_is_tainted()) context.release(); }
SourceBoundary::SourceBoundary(std::shared_ptr<State> s,std::unique_ptr<SmBrep> b):state(std::move(s)),solid(std::move(b)) {}
SourceBoundary::~SourceBoundary() { if(kernel_domain_is_tainted()) solid.release(); }
void SourceBoundary::live() const {
    if(kernel_domain_is_tainted()) throw KernelDomainTainted{"source boundary domain tainted"};
    require(state && solid,"source boundary owner missing");state->ledger.check();
}
std::unique_ptr<SourceBoundary> SourceBoundary::construct(const std::vector<uint8_t>& bytes,uint32_t loops,uint32_t segments,
    SourceStamp stamp,ifclite_smlib_handle origin,uint64_t operation) {
    require(stamp.incarnation && stamp.revision && stamp.entity && origin.session && origin.generation && operation,
        "source binding requires complete issued source/object identity");
    require(segments && segments<=128 && loops && loops<=segments,"source construction inventory bound");
    if(kernel_domain_is_tainted()) throw KernelDomainTainted{"source constructor domain tainted"};
    require(live_domains<32,"source native lifetime domain budget");
    auto state=std::make_shared<State>();std::unique_ptr<SmBrep> body;
    try {
        SourceConstruction construction(*state->context);
        body=create_authored_sweep(bytes,loops,segments,&construction);
        auto roles=construction.finish(*body);
        // No SDK operation between the constructor observer and the permanent
        // lifetime observer. The role list retains actual birth generations.
        state->observation=std::make_unique<Scope>(state->ledger,*state->context);
        std::vector<Seed> seeds;seeds.reserve(roles.size());
        for(const auto& role:roles) seeds.push_back({role.face,RootKind::SourceBoundary});
        state->ledger.admit_roots(*body,{stamp.incarnation,origin.session,origin.slot,origin.generation,stamp.revision,operation},
            seeds.data(),uint32_t(seeds.size()));
        auto& inventory=*state->inventory;inventory.origin=origin;inventory.source=stamp;inventory.operation=operation;
        for(const auto& role:roles) {
            const auto id=state->ledger.identity(role.face);
            inventory.roots.push_back({id.domain,id.sequence,uint32_t(role.role),role.ordinal});
        }
        return std::unique_ptr<SourceBoundary>(new SourceBoundary(std::move(state),std::move(body)));
    } catch(...) { body.release();rethrow_tainted_kernel_domain("source construction issuance"); }
}
const SourceInventory& SourceBoundary::inventory() const {
    live();state->ledger.verify_inventory(*solid);return *state->inventory;
}
std::unique_ptr<SourceBoundary> SourceBoundary::affine(const double* matrix,ifclite_smlib_affine_certificate& certificate) const {
    live();auto copy=copy_affine_rational(solid.get(),matrix,certificate,&state->ledger);
    return std::unique_ptr<SourceBoundary>(new SourceBoundary(state,std::move(copy)));
}
std::unique_ptr<AdapterMesh> SourceBoundary::tessellate(double chord,double angle) const {
    live();Scope phase(state->ledger,*state->context,solid.get());RepresentationSeal seal(state->ledger,*solid);
    try {
        auto mesh=tessellate_mesh(solid.get(),chord,angle,&state->ledger);
        state->ledger.check();seal.verify();state->ledger.verify_inventory(*solid);phase.finish();state->ledger.check();
        mesh->source_inventory=state->inventory;mesh->source_roots.reserve(mesh->provenance.triangles.size());
        for(const auto& triangle:mesh->provenance.triangles) {
            Root root[2];const auto count=state->ledger.roots(triangle,root,2);
            require(count==1,"construction/copy/affine triangle must have one original source feature");
            const auto& original=state->inventory->origin;const auto& object=root[0].object;
            require(object.incarnation==state->inventory->source.incarnation && object.session==original.session &&
                object.slot==original.slot && object.generation==original.generation &&
                object.revision==state->inventory->source.revision && object.operation==state->inventory->operation &&
                root[0].kind==RootKind::SourceBoundary,"triangle source operation binding changed");
            uint32_t index=0,hits=0,matched=0;
            for(const auto& source:state->inventory->roots) {
                if(source.domain==root[0].identity.domain && source.sequence==root[0].identity.sequence) { ++hits;matched=index; }
                ++index;
            }
            require(hits==1,"triangle ancestor not in complete source inventory");mesh->source_roots.push_back(matched);
        }
        mesh->provenance.owner=state;return mesh;
    } catch(...) { rethrow_tainted_kernel_domain("source-bound tessellation"); }
}
std::vector<uint8_t> source_packet(const SourceInventory& source,ifclite_smlib_handle current) {
    require(source.roots.size()<=130,"bounded source inventory packet");std::vector<uint8_t> bytes;
    auto u32=[&](uint32_t v) { for(unsigned i=0;i<4;++i)bytes.push_back(uint8_t(v>>(8*i))); };
    auto u64=[&](uint64_t v) { u32(uint32_t(v));u32(uint32_t(v>>32)); };
    auto handle=[&](ifclite_smlib_handle h) { u64(h.session);u32(h.slot);u32(h.generation); };
    u32(1);handle(current);handle(source.origin);u64(source.source.incarnation);u64(source.source.epoch);
    u64(source.source.revision);u32(source.source.entity);u64(source.operation);u32(1);u32(uint32_t(source.roots.size()));
    for(const auto& root:source.roots) { u64(root.domain);u64(root.sequence);u32(root.role);u32(root.ordinal); }
    return bytes;
}
}
