// SPDX-License-Identifier: MPL-2.0
#include "plane_accuracy.hpp"
#include "plane_interval.hpp"
#include <SmApiGeneral.h>
#include <SmMerge.h>
#include <SmTopologyIntersector.h>

SmStatus intersect_plane_with_accuracy(SmBrep* host,SmBrep* cutter,SmBrep*& result) {
    using namespace plane_numeric;
    // The caller has already validated owned, nonempty manifold operands.
    // SmApiBoolean would use the same SmMerge entry point but with precision 0
    // (half the minimum topology tolerance, further limited by edge size).
    // A 1e-5 topology tolerance is not a 1e-6 geometry-accuracy request (#7955).
    // Keep topology/cutter geometry unchanged and make one construction attempt;
    // never retry with a relaxed request or publish a failed approximation.
    result=nullptr;
    auto* context=SmApiGetOrCreateContext();
    require(context && host && cutter,"plane accuracy operands/context missing",IFCLITE_SMLIB_KERNEL_ERROR);
    require(std::isfinite(plane_construction_accuracy) && plane_construction_accuracy>SM_EFF_ZERO &&
        plane_construction_accuracy<plane_boundary_accuracy,"unsupported plane construction precision",
        IFCLITE_SMLIB_UNSUPPORTED);
    SmMerge merge(*context,host,cutter,plane_construction_accuracy);
    require(merge.GetTopologyIntersector().GetThisApproxTol3d()==plane_construction_accuracy,
        "SDK did not retain requested plane construction precision",IFCLITE_SMLIB_KERNEL_ERROR);
    const auto status=merge.ManifoldBoolean(SM_BO_INTERSECTION,result);
    // This is an SDK configuration contract, not a geometric error certificate.
    // Its span tests are sampled. Independent source/volume/mesh oracles remain
    // release gates; neither this check nor the budget proves arbitrary input.
    require(merge.GetTopologyIntersector().GetThisApproxTol3d()==plane_construction_accuracy,
        "SDK changed plane construction precision",IFCLITE_SMLIB_KERNEL_ERROR);
    return status;
}
