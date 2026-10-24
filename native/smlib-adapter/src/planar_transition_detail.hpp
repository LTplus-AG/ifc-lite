// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "planar_transition.hpp"
#include "failure.hpp"
#include "ifclite_smlib.h"
#include <SmEdge.h>
#include <SmFaceuse.h>
#include <SmLoop.h>
#include <SmVertexuse.h>
#include <cmath>
#include <cstring>
#include <algorithm>
#include <limits>
namespace face_lineage::planar_detail {
inline void require(bool ok,const char* why) { if(!ok) throw AdapterFailure{IFCLITE_SMLIB_UNSUPPORTED,why}; }
inline void checked(SmStatus status,const char* why) { if(status!=SM_SUCCESS) throw AdapterFailure{IFCLITE_SMLIB_KERNEL_ERROR,why}; }
inline bool bits(double a,double b) { return std::memcmp(&a,&b,sizeof(a))==0; }
inline bool point(const SmPoint3d& a,const SmPoint3d& b) { return a.x==b.x && a.y==b.y && a.z==b.z; }
// #7955: correspondence between independently computed linear coefficients and
// axis-plane corners is numerical, unlike a retained representation/copy seal.
// Fix an eight-epsilon budget before execution: a short dot product plus endpoint
// arithmetic can round several times. This is a narrow acceptance policy, not
// a universal error bound for arbitrary evaluators. Scale by the EXPECTED
// component only, with a unit floor for cancellation near zero. No model/SDK
// tolerance, observed residual, other component or candidate sets this budget.
inline double coefficient_bound(double expected) {
    return 8*std::numeric_limits<double>::epsilon()*std::max(1.,std::abs(expected));
}
inline bool coefficient(double actual,double expected) {
    return std::isfinite(actual) && std::isfinite(expected) &&
        std::abs(actual-expected)<=coefficient_bound(expected); // planar-coefficient-bound
}
inline bool coefficient_point(const SmPoint3d& a,const SmPoint3d& b) {
    return coefficient(a.x,b.x) && coefficient(a.y,b.y) && coefficient(a.z,b.z);
}
inline void correspondence(const SmPoint3d& actual,const SmPoint3d& expected) {
    require(coefficient_point(actual,expected),"transition bounded coefficient correspondence");
}
inline bool axis(const SmVector3d& p) {
    return (p.x==0 || std::abs(p.x)==1) && (p.y==0 || std::abs(p.y)==1) &&
        (p.z==0 || std::abs(p.z)==1) && p.Dot(p)==1;
}
inline SmEdgeuse* owner(SmEdgeuse* use,SmFace* face,SmBrep& body,SmBSplineCurve* curve) {
    auto* mate=use?use->GetMate():nullptr;
    require(mate && mate!=use && mate->GetMate()==use && use->GetFace()==face && mate->GetFace()==face &&
        use->GetBrep()==&body && mate->GetBrep()==&body && use->GetEdge()==mate->GetEdge(),"transition UV reciprocal ownership");
    auto* expected=use->GetOrientation()==SM_OT_SAME?use:mate;
    require(expected->GetOrientation()==SM_OT_SAME && expected->GetMate()->GetOrientation()==SM_OT_OPPOSITE,
        "transition UV parameter orientation");
    if(curve) {
        SmEdgeuse* reported=nullptr;
        require(use->GetUVTrimCurve(&reported)==curve && reported==expected && expected->GetUVTrimCurvePointer()==curve &&
            expected->GetMate()->GetUVTrimCurvePointer()==nullptr && curve->GetOwner()==expected,
            "transition exact canonical raw trim slot/backlink");
    }
    return expected;
}
inline std::array<SmPoint3d,2> linear(SmBSplineCurve& c,unsigned dimension) {
    require(c.GetGwNurbPointer() && !c.IsNurbBorrowed() && !c.HasAttributes() && c.GetDim()==dimension &&
        c.GetDegree()==1 && !c.IsRational(),"transition requires materialized nonrational linear geometry");
    ULONG count=0; double* p=nullptr; checked(c.GetControlPointsPointer(count,p),"transition control getter");
    require(count==2 && p && c.GetNumberNaturalKnots()==4,"transition exact linear control support");
    double k[4]{}; checked(c.GetKnotsExpert(0,3,k),"transition knot getter");
    const auto d=c.GetNaturalInterval();
    require(k[0]==d.GetMin() && k[1]==d.GetMin() && k[2]==d.GetMax() && k[3]==d.GetMax() && k[0]<k[3],
        "transition clamped linear parameter domain");
    return {SmPoint3d(p[0],p[1],dimension==3?p[2]:0),SmPoint3d(p[4],p[5],dimension==3?p[6]:0)};
}
}
