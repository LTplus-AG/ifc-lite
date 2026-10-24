// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "affine_transition.hpp"
#include "failure.hpp"
#include "copy.hpp"
#include <algorithm>
#include <cmath>
#include <limits>
namespace face_lineage::affine_detail {
inline void require(bool ok,const char* why) { if(!ok) throw AdapterFailure{IFCLITE_SMLIB_UNSUPPORTED,why}; }
inline void checked(SmStatus status) { require(status==SM_SUCCESS,"affine prescribed SDK stage failed"); }
inline void near(double actual,double expected,double magnitude) {
    // Fixed binary64 operation bound, independent of tessellation tolerance.
    require(std::isfinite(actual) && std::isfinite(expected) && std::isfinite(magnitude) && magnitude>=0 &&
        std::abs(actual-expected)<=128*std::numeric_limits<double>::epsilon()*std::max(1.,magnitude),
        "affine transformed coordinate disagrees with prescribed operation");
}
inline bool same_roots(const std::vector<Root>& a,const std::vector<Root>& b) {
    if(a.size()!=b.size()) return false;
    for(size_t i=0;i<a.size();++i) {
        const auto& x=a[i]; const auto& y=b[i];
        if(x.identity!=y.identity || x.kind!=y.kind || x.object.incarnation!=y.object.incarnation ||
            x.object.session!=y.object.session || x.object.slot!=y.object.slot || x.object.generation!=y.object.generation ||
            x.object.revision!=y.object.revision || x.object.operation!=y.object.operation) return false;
    }
    return true;
}
inline std::vector<Root> roots(Ledger& ledger,Identity id) {
    std::vector<Root> result(1024); result.resize(ledger.roots(id,result.data(),result.size())); return result;
}
}
