// SPDX-License-Identifier: MPL-2.0
// #7955: diagnostic fallback, NOT a positive affine ancestry qualification.
// Exercise the real production numerical path under continuous observation.
#include "affine.hpp"
#include "owned_lineage_access.hpp"
#include "representation_seal.hpp"
#include "copy.hpp"
#include "failure.hpp"
#include <SmApiGeneral.h>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <stdexcept>
#include <string>
namespace {
using namespace face_lineage;
using Matrix=std::array<double,16>;
constexpr Matrix identity{1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};
void require(bool ok,const char* why) { if(!ok) throw std::runtime_error(why); }
SmBrep& body(const OwnedBoundary& owner) { return const_cast<SmBrep&>(OwnedBoundaryTestAccess::solid(owner)); }
Ledger& history(const OwnedBoundary& owner) { return const_cast<Ledger&>(OwnedBoundaryTestAccess::ledger(owner)); }
Matrix matrix(const char* name) {
    if(std::strcmp(name,"affine-identity")==0) return identity;
    if(std::strcmp(name,"affine-rigid")==0) return {0,1,0,0,-1,0,0,0,0,0,1,0,7,-4,2,1};
    if(std::strcmp(name,"affine-scale")==0) return {2,0,0,0,0,3,0,0,0,0,4,0,7,-4,2,1};
    if(std::strcmp(name,"affine-shear")==0) return {2,0,0,0,.4,3,0,0,.2,.3,4,0,7,-4,2,1};
    if(std::strcmp(name,"affine-reflect")==0) return {-2,0,0,0,.4,3,0,0,.2,.3,4,0,7,-4,2,1};
    throw std::runtime_error("unknown affine diagnostic selector");
}
void callback_replacement() {
    auto source=OwnedBoundary::box(2,3,4); auto sibling=source.copy();
    auto& ledger=history(source); const auto events=ledger.event_size();
    SmApiGetOrCreateContext()->SetUserNotifyCallback(nullptr);
    ifclite_smlib_affine_certificate certificate{}; bool rejected=false;
    try { auto result=copy_affine_rational(&body(source),identity.data(),certificate,&ledger); }
    catch(const KernelDomainTainted&) { rejected=true; }
    require(rejected && !certificate.version && kernel_domain_is_tainted() &&
        ledger.failed()==Failure::CallbackReplaced && ledger.event_size()==events,
        "affine callback replacement refuses before copy or publication");
    bool sibling_refused=false;
    try { (void)sibling.faces(); } catch(const KernelDomainTainted&) { sibling_refused=true; }
    require(sibling_refused,"callback replacement retires sibling owners too");
}
void invalid_inputs() {
    auto source=OwnedBoundary::box(2,3,4); auto sibling=source.copy();
    auto& ledger=history(source);
    RepresentationSeal source_seal(ledger,body(source)),sibling_seal(ledger,body(sibling));
    const auto roots=source.faces(),siblings=sibling.faces();
    const auto events=ledger.event_size();
    auto invalid=[&](const double* value) {
        ifclite_smlib_affine_certificate certificate{}; bool rejected=false;
        try { auto result=copy_affine_rational(&body(source),value,certificate,&ledger); }
        catch(const AdapterFailure& e) { rejected=e.status==IFCLITE_SMLIB_INVALID_ARGUMENT; }
        require(rejected && !certificate.version && !kernel_domain_is_tainted(),
            "invalid affine matrix refuses before any owned SDK mutation");
        require(ledger.event_size()==events && ledger.failed()==Failure::None,
            "invalid affine preflight emits no SDK events");
        source_seal.verify(); sibling_seal.verify();
        require(source.faces()==roots && sibling.faces()==siblings,"invalid affine preserves source and sibling identity");
    };
    invalid(nullptr);
    Matrix m=identity; m[10]=0; invalid(m.data());
    m=identity; m[0]=std::numeric_limits<double>::quiet_NaN(); invalid(m.data());
    m=identity; m[7]=1; invalid(m.data());
}
}
void run_affine_lineage_diagnostic(const char* name) {
    if(std::strcmp(name,"affine-callback")==0) { callback_replacement(); return; }
    if(std::strcmp(name,"affine-invalid")==0) { invalid_inputs(); return; }
    const auto transform=matrix(name);
    auto source=OwnedBoundary::box(2,3,4); auto sibling=source.copy();
    auto& ledger=history(source);
    const auto roots=source.faces(),siblings=sibling.faces();
    require(roots.size()==6 && siblings.size()==6,"diagnostic has two actual six-face SDK operands");
    RepresentationSeal source_seal(ledger,body(source)),sibling_seal(ledger,body(sibling));
    const auto before=ledger.event_size();
    // Missing semantic transition must stay closed, not be made green by an
    // event whitelist or fresh-root issuance. No SDK reads after terminal latch.
    ifclite_smlib_affine_certificate certificate{};
    std::unique_ptr<SmBrep> unexpected;
    bool rejected=false; std::string stage;
    try { unexpected=copy_affine_rational(&body(source),transform.data(),certificate,&ledger); }
    catch(const KernelDomainTainted& error) { rejected=true; stage=error.message; }
    require(rejected && !unexpected && !certificate.version && kernel_domain_is_tainted(),
        "unaudited affine cannot publish a result or certificate");
    const auto origin=ledger.failure_origin();
    require(origin.failure==Failure::UnsupportedGeometryChange && origin.event>before && origin.caller_type!=0,
        "actual affine conversion exposes missing numerical ancestry transition");
    require(stage.find("affine rational conversion")!=std::string::npos,
        "affine stops at conversion before either placement executes");
    std::fprintf(stderr,"affine diagnostic case=%s failure=%u event=%u operation=%ld caller_type=%ld frame=%u nodes=%u\n",
        name,unsigned(origin.failure),origin.event,long(origin.operation),origin.caller_type,origin.frame,origin.nodes);
    const auto events=ledger.event_size(),nodes=ledger.node_size();
    auto terminal=[&](auto action) {
        bool refused=false;
        try { action(); } catch(const KernelDomainTainted&) { refused=true; }
        require(refused,"failed affine retires source and sibling in the whole domain");
    };
    terminal([&] { (void)source.faces(); });
    terminal([&] { (void)sibling.copy(); });
    terminal([&] { (void)sibling.tessellate(.01,15); });
    terminal([&] { (void)source.affine(identity.data()); });
    terminal([&] { (void)copy_affine_rational(&body(source),identity.data(),certificate,&ledger); });
    require(ledger.event_size()==events && ledger.node_size()==nodes,
        "terminal affine retry refuses before SDK activity");
}
