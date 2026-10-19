// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "sweep.hpp"
#include "ifclite_smlib.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#if defined(__FAST_MATH__)
#error Conservative plane arithmetic must not be compiled with fast-math
#endif
namespace plane_numeric {
inline void require(bool value, const char* message, int32_t status=IFCLITE_SMLIB_UNSUPPORTED) {
    if(!value) throw SweepFailure{status,message};
}
inline void checked(SmStatus value) {
    require(value==SM_SUCCESS,"plane SDK operation failed",IFCLITE_SMLIB_KERNEL_ERROR);
}
inline double down(double x) { return std::nextafter(x,-std::numeric_limits<double>::infinity()); }
inline double up(double x) { return std::nextafter(x,std::numeric_limits<double>::infinity()); }
struct Interval { double lo,hi; };
inline Interval exact(double x) { return {x,x}; }
inline Interval operator+(Interval a,Interval b) {
    return {down(a.lo+b.lo),up(a.hi+b.hi)};
}
inline Interval operator-(Interval a,Interval b) {
    return {down(a.lo-b.hi),up(a.hi-b.lo)};
}
inline Interval operator*(Interval a,Interval b) {
    const double p[]={a.lo*b.lo,a.lo*b.hi,a.hi*b.lo,a.hi*b.hi};
    return {down(*std::min_element(p,p+4)),up(*std::max_element(p,p+4))};
}
inline Interval quotient(double x,double w) {
    require(std::isfinite(x) && std::isfinite(w) && w>0,"invalid positive-weight control point");
    if(w==1 || x==0) return exact(x);
    return {down(x/w),up(x/w)};
}
using Bounds=std::array<Interval,3>;
inline Bounds vacant() {
    const double inf=std::numeric_limits<double>::infinity();
    return {{{inf,-inf},{inf,-inf},{inf,-inf}}};
}
inline void include(Bounds& box,const Bounds& p,unsigned dimensions=3) {
    for(unsigned i=0;i<dimensions;++i) {
        require(std::isfinite(p[i].lo) && std::isfinite(p[i].hi) && p[i].lo<=p[i].hi,
            "nonfinite conservative enclosure");
        box[i].lo=std::min(box[i].lo,p[i].lo); box[i].hi=std::max(box[i].hi,p[i].hi);
    }
}
inline Bounds expanded(Bounds box,double tolerance) {
    require(std::isfinite(tolerance) && tolerance>=0,"invalid topology tolerance");
    for(auto& a:box) a=a+Interval{-tolerance,tolerance};
    return box;
}
}
