// SPDX-License-Identifier: MPL-2.0
#include "copy.hpp"
#include "sweep.hpp"
#include "ifclite_smlib.h"
#include <SmContext.h>
#include <SmEdge.h>
#include <SmFace.h>
#include <exception>
namespace {
bool tainted=false;
void require(bool valid,int32_t status,const char* message) {
    if(!valid) throw SweepFailure{status,message};
}
struct Metadata { double size,ratio; SmZoneTol3d zone; };
// Pin-specific legal protected-member access; no base-to-derived cast and no
// source write. Public SmTol getters chase DEFAULT sentinels, so using those
// would change the copy constructor's raw tolerance metadata contract.
// These types are never instantiated; the member pointers apply to Base.
template<class Base> struct MetadataAccess: Base {
    static Metadata get(const Base& value) {
        return {value.*(&MetadataAccess::m_dThisModelSizeEstimate),
            value.*(&MetadataAccess::m_dThisLargeSmallSizeRatio),
            value.*(&MetadataAccess::m_sThisZoneTol3d)};
    }
    static void set(Base& value,const Metadata& m) {
        value.*(&MetadataAccess::m_dThisModelSizeEstimate)=m.size;
        value.*(&MetadataAccess::m_dThisLargeSmallSizeRatio)=m.ratio;
        value.*(&MetadataAccess::m_sThisZoneTol3d)=m.zone;
    }
};
struct RestoreContext {
    SmContext& context;
    Metadata metadata;
    explicit RestoreContext(const SmContext* c):context(*const_cast<SmContext*>(c)),
        metadata(MetadataAccess<SmContext>::get(context)) {}
    ~RestoreContext() { MetadataAccess<SmContext>::set(context,metadata); }
};
}
std::unique_ptr<SmBrep> checked_brep_copy(const SmBrep* source) {
    require(source && source->GetContext(),IFCLITE_SMLIB_INVALID_ARGUMENT,"copy source lacks context");
    SmTArray<SmFace*> faces; source->GetFaces(faces);
    SmTArray<SmEdge*> edges; source->GetEdges(edges);
    require(faces.GetSize()<=100000 && edges.GetSize()<=100000,
        IFCLITE_SMLIB_RESOURCE_LIMIT,"copy topology budget");
    for(auto* f:faces) require(f && f->GetType()==SmFace_TYPE,
        IFCLITE_SMLIB_UNSUPPORTED,"SDK MergeBrep cannot copy composite/specialized faces");
    for(auto* e:edges) require(e && e->GetType()==SmEdge_TYPE,
        IFCLITE_SMLIB_UNSUPPORTED,"SDK MergeBrep cannot copy composite/specialized edges");
    RestoreContext context(source->GetContext());
    std::unique_ptr<SmBrep> result;
    try {
    result.reset(new (*source->GetContext()) SmBrep());
    MetadataAccess<SmBrep>::set(*result,MetadataAccess<SmBrep>::get(*source));
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
    catch(const SweepFailure& e) { throw KernelDomainTainted{std::string(stage)+": "+e.message}; }
    catch(const std::exception& e) { throw KernelDomainTainted{std::string(stage)+": "+e.what()}; }
    catch(...) { throw KernelDomainTainted{std::string(stage)+": unknown SDK failure"}; }
}
