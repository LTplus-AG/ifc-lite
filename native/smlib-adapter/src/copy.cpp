// SPDX-License-Identifier: MPL-2.0
#include "copy.hpp"
#include "failure.hpp"
#include "ifclite_smlib.h"
#include "context_metadata.hpp"
#include <SmCopyBrepMap.h>
#include <SmEdge.h>
#include <SmFace.h>
#include <exception>
namespace {
bool tainted=false;
void require(bool valid,int32_t status,const char* message) {
    if(!valid) throw AdapterFailure{status,message};
}
}
std::unique_ptr<SmBrep> checked_brep_copy(const SmBrep* source) {
    if(kernel_domain_is_tainted()) throw KernelDomainTainted{"BRep copy refused after terminal isolation failure"};
    require(source && source->GetContext(),IFCLITE_SMLIB_INVALID_ARGUMENT,"copy source lacks context");
    SmTArray<SmFace*> faces; source->GetFaces(faces);
    SmTArray<SmEdge*> edges; source->GetEdges(edges);
    for(auto* f:faces) require(f && f->GetType()==SmFace_TYPE,
        IFCLITE_SMLIB_UNSUPPORTED,"SDK MergeBrep cannot copy composite/specialized faces");
    for(auto* e:edges) require(e && e->GetType()==SmEdge_TYPE,
        IFCLITE_SMLIB_UNSUPPORTED,"SDK MergeBrep cannot copy composite/specialized edges");
    raw_context::Restore context(source->GetContext());
    std::unique_ptr<SmBrep> result;
    try {
    result=raw_context::construct_brep(source->GetContext());
    raw_context::Access<SmBrep>::set(*result,raw_context::Access<SmBrep>::get(*source));
    result->m_bEditingEnabled=source->m_bEditingEnabled;
    result->m_bValidateOnly=source->m_bValidateOnly;
    // SmApiBrepCopy's copy constructor discards this status with SE(...).
    // Never permit a failed/partial topology copy to become a live handle.
    require(result->MergeBrep(*source,nullptr,nullptr,FALSE)==SM_SUCCESS,
        IFCLITE_SMLIB_KERNEL_ERROR,"SDK topology copy failed before publication");
    SmTArray<SmTopology*> before,after;
    source->GetTopology(before); result->GetTopology(after);
    require(before.GetSize()==after.GetSize(),IFCLITE_SMLIB_KERNEL_ERROR,"SDK topology copy changed object count");
    return result;
    } catch(...) {
        // MergeBrep can allocate topology before inserting it into result.
        // Neither result destruction nor SmContext destruction proves cleanup.
        // Keep all partial data untouched until the isolation boundary exits.
        result.release();
        rethrow_tainted_kernel_domain("BRep copy");
    }
}
bool kernel_domain_is_tainted() { return tainted; }
[[noreturn]] void rethrow_tainted_kernel_domain(const char* stage) {
    tainted=true;
    try { throw; }
    catch(const KernelDomainTainted&) { throw; }
    catch(const AdapterFailure& e) { throw KernelDomainTainted{std::string(stage)+": "+e.message}; }
    catch(const std::exception& e) { throw KernelDomainTainted{std::string(stage)+": "+e.what()}; }
    catch(...) { throw KernelDomainTainted{std::string(stage)+": unknown SDK failure"}; }
}
