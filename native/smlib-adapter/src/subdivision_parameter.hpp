// SPDX-License-Identifier: MPL-2.0
#pragma once
#include <algorithm>
#include <cmath>
#include <limits>
namespace face_lineage {
// #7955: fixed rounding budget for an independently checked Trim's existing-
// knot snap. Eight epsilons accommodates short parameter interpolation chains;
// it is not the SDK's much wider model-dependent snapping tolerance. This
// policy is fixed before execution. The requested component alone sets scale.
inline bool subdivision_parameter_rounding(double requested,double actual) {
    return std::isfinite(requested) && std::isfinite(actual) &&
        std::abs(actual-requested)<=8*std::numeric_limits<double>::epsilon()*std::max(1.,std::abs(requested)); // subdivision-rounding-bound
}
}
