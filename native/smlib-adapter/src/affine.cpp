// SPDX-License-Identifier: MPL-2.0
// Bounded general affine copy: classify, copy, convert to generic rational
// geometry, then apply only checked proper placements and signed diagonal
// scale. Pinned SDK c9c5979 sources behind each step:
// - SmBrep.cpp:32782 TurnToNURBS copies rational subclasses directly but fits
//   offset surfaces and non-rational edge curves and ignores some
//   approximation statuses: the class whitelist excludes every fitting branch.
// - SmBSplineCurve.cpp:196, SmBSplineSurface.cpp:309, SmNurbsCrv.cpp:386:
//   copy constructors normalize close knots, so such sources refuse.
// - SmBrep.cpp:28618 matrix Transform ignores SVD status and re-recognizes
//   analytics (never used). SmBrep.cpp:28777 proper placement plus signed
//   scale transforms converted generic geometry; negative scale reverses
//   radial edgeuse pairs and swaps faceuse shells.
// - SmAxis2Placement.cpp:768 SetFrom4x4 ignores Z (never used).
// - SmMatrix.cpp:1718 SVDecompose returns U, singular values and V: A=U D Vt.
// Numerical policy, fixed before execution and never widened: entries
// |x|<=1e9, last row exactly [0,0,0,1], nonsingular (status 1); singular
// values in [1e-6,1e6], condition <=1e6 (status 7); orthogonality residual
// <=1e-12 and reconstruction <=128 eps*max|coefficient| (status 4). Tolerance
// rescaling stays disabled (bScaleTol=FALSE), so source tolerances and the
// ambient context are untouched; extreme model scales may still fail later.
#include "affine.hpp"
#include "copy.hpp"
#include "failure.hpp"
#include <SmApiGeneral.h>
#include <SmApiQueries.h>
#include <SmBSplineCurve.h>
#include <SmBSplineSurface.h>
#include <SmMatrix.h>
#include <SmVertex.h>
#include <SmTol.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
namespace {
void require(bool condition, int32_t status, const char* message) {
    if (!condition) throw AdapterFailure{status,message};
}
void checked(SmStatus status) {
    require(status==SM_SUCCESS,IFCLITE_SMLIB_KERNEL_ERROR,"affine SDK operation failed");
}
using M3=std::array<std::array<double,3>,3>;
double det(const M3& a) {
    return a[0][0]*(a[1][1]*a[2][2]-a[1][2]*a[2][1])-
        a[0][1]*(a[1][0]*a[2][2]-a[1][2]*a[2][0])+
        a[0][2]*(a[1][0]*a[2][1]-a[1][1]*a[2][0]);
}
void orthogonal(const M3& a) {
    for(unsigned i=0;i<3;++i) for(unsigned j=0;j<3;++j) {
        double dot=0; for(unsigned k=0;k<3;++k) dot+=a[k][i]*a[k][j];
        require(std::isfinite(dot) && std::abs(dot-(i==j?1.:0.))<=1e-12,
            IFCLITE_SMLIB_KERNEL_ERROR,"affine SVD orthogonality residual");
    }
}
// Reconstruction residual bound: 128 binary64 epsilons of the largest
// absolute linear coefficient, fixed before execution.
void reconstructs(double x, double expected, double norm, const char* message) {
    require(std::isfinite(x) && std::abs(x-expected)<=128*std::numeric_limits<double>::epsilon()*norm,
        IFCLITE_SMLIB_KERNEL_ERROR,message);
}
struct Factors { SmAxis2Placement first, last; SmVector3d scale; };
Factors factor(const double* m) {
    require(m!=nullptr,IFCLITE_SMLIB_INVALID_ARGUMENT,"null affine matrix");
    for(unsigned i=0;i<16;++i) require(std::isfinite(m[i]) && std::abs(m[i])<=1e9,
        IFCLITE_SMLIB_INVALID_ARGUMENT,"affine coefficients must be finite and bounded by 1e9");
    require(m[3]==0 && m[7]==0 && m[11]==0 && m[15]==1,
        IFCLITE_SMLIB_INVALID_ARGUMENT,"expected affine last row [0,0,0,1]");
    SmMatrix u(3,3), v(3,3); double norm=0;
    M3 original{};
    for(unsigned r=0;r<3;++r) for(unsigned c=0;c<3;++c) {
        u[r][c]=original[r][c]=m[4*c+r]; norm=std::max(norm,std::abs(m[4*c+r]));
    }
    require(norm>0 && det(original)!=0,IFCLITE_SMLIB_INVALID_ARGUMENT,"singular affine matrix");
    SmTArray<double> w; checked(u.SVDecompose(w,v));
    M3 left{},right{};
    for(unsigned r=0;r<3;++r) for(unsigned c=0;c<3;++c) {
        left[r][c]=u[r][c]; right[r][c]=v[r][c];
    }
    orthogonal(left); orthogonal(right);
    double lo=std::numeric_limits<double>::infinity(),hi=0;
    for(unsigned i=0;i<3;++i) {
        require(std::isfinite(w[i]) && w[i]>=1e-6 && w[i]<=1e6,
            IFCLITE_SMLIB_UNSUPPORTED,"affine singular value outside [1e-6,1e6]");
        lo=std::min(lo,w[i]); hi=std::max(hi,w[i]);
    }
    require(hi/lo<=1e6,IFCLITE_SMLIB_UNSUPPORTED,"affine condition number exceeds 1e6");
    // A = U D Vt. Flip the last columns to make both placements proper;
    // absorb both signs into D so reflection reaches the signed-scale kernel.
    const double su=det(left)<0?-1.:1., sv=det(right)<0?-1.:1.;
    for(unsigned r=0;r<3;++r) { left[r][2]*=su; right[r][2]*=sv; }
    w[2]*=su*sv;
    for(unsigned r=0;r<3;++r) for(unsigned c=0;c<3;++c) {
        double x=0; for(unsigned k=0;k<3;++k) x+=left[r][k]*w[k]*right[c][k];
        reconstructs(x,m[4*c+r],norm,"affine SVD reconstruction residual");
    }
    Factors f;
    checked(f.first.SetCanonical(SmPoint3d(0,0,0),
        SmVector3d(right[0][0],right[0][1],right[0][2]),
        SmVector3d(right[1][0],right[1][1],right[1][2])));
    checked(f.last.SetCanonical(SmPoint3d(m[12],m[13],m[14]),
        SmVector3d(left[0][0],left[1][0],left[2][0]),
        SmVector3d(left[0][1],left[1][1],left[2][1])));
    // SetCanonical/GetZAxis can normalize basis data. Certify the effective
    // placements too, rather than trusting only the raw SVD factors.
    const SmVector3d first[3]={f.first.GetXAxis(),f.first.GetYAxis(),f.first.GetZAxis()};
    const SmVector3d last[3]={f.last.GetXAxis(),f.last.GetYAxis(),f.last.GetZAxis()};
    for(unsigned r=0;r<3;++r) for(unsigned c=0;c<3;++c) {
        double x=0; for(unsigned k=0;k<3;++k) x+=last[k][r]*w[k]*first[c][k];
        reconstructs(x,m[4*c+r],norm,"affine effective placement reconstruction residual");
    }
    f.scale=SmVector3d(w[0],w[1],w[2]);
    return f;
}
// Reject knots that the SDK copy constructors would merge or spread. This is
// necessary even for already-generic rational geometry; class alone is not a
// coefficient-preservation certificate. Read existing NURBS, never lazy-fit.
void knots(const double* p, ULONG n, double tol) {
    require(p && n && n<=1000000,IFCLITE_SMLIB_UNSUPPORTED,"missing or oversized rational knot vector");
    const double gap=std::max(tol,double(SmTol::GetScaledZero(p[0],p[n-1])));
    for(ULONG i=0;i<n;++i) {
        require(std::isfinite(p[i]),IFCLITE_SMLIB_UNSUPPORTED,"nonfinite rational knot");
        if(i) require(p[i]==p[i-1] || p[i]-p[i-1]>=gap,
            IFCLITE_SMLIB_UNSUPPORTED,"SDK copy would normalize close rational knots");
    }
}
void points(const double* p, size_t n) {
    require(p && n && n<=1000000,IFCLITE_SMLIB_UNSUPPORTED,"missing or oversized rational control net");
    for(size_t i=0;i<n*4;++i) require(std::isfinite(p[i]),
        IFCLITE_SMLIB_UNSUPPORTED,"nonfinite rational coefficient");
}
unsigned curve_class(SM_TYPE type) {
    if(type==SmBSplineCurve_TYPE) return 0;
    if(type==SmLine_TYPE) return 1;
    if(type==SmCircle_TYPE) return 2;
    if(type==SmEllipse_TYPE) return 3;
    if(type==SmParabola_TYPE) return 4;
    if(type==SmHyperbola_TYPE) return 5;
    throw AdapterFailure{IFCLITE_SMLIB_UNSUPPORTED,"affine curve class has no exact rational conversion certificate"};
}
unsigned surface_class(SM_TYPE type) {
    if(type==SmBSplineSurface_TYPE) return 6;
    if(type==SmPlane_TYPE) return 7;
    if(type==SmCylinder_TYPE) return 8;
    if(type==SmCone_TYPE) return 9;
    if(type==SmSphere_TYPE) return 10;
    if(type==SmTorus_TYPE) return 11;
    throw AdapterFailure{IFCLITE_SMLIB_UNSUPPORTED,"affine surface class has no exact rational conversion certificate"};
}
// Read-only. With `generic`, every class must already be BSpline.
void inspect(SmBrep* source, ifclite_smlib_affine_certificate* certificate, bool generic) {
    SmTArray<SmCurve*> curves; source->GetCurves(curves);
    SmTArray<SmSurface*> surfaces; source->GetSurfaces(surfaces);
    SmTArray<SmFace*> faces; source->GetFaces(faces);
    SmTArray<SmEdge*> edges; source->GetEdges(edges);
    // SDK getters omit geometry not owned by that face/edge. Do not certify a
    // subset while a shared or foreign-owned representation bypasses preflight.
    require(curves.GetSize()==edges.GetSize() && surfaces.GetSize()==faces.GetSize(),
        IFCLITE_SMLIB_UNSUPPORTED,"affine shared/foreign-owned geometry requires a separate copy certificate");
    require(curves.GetSize()<=100000 && surfaces.GetSize()<=100000,
        IFCLITE_SMLIB_RESOURCE_LIMIT,"affine source class budget");
    // Classify everything before touching representation data.
    for(auto* c:curves) { const auto k=curve_class(c->GetType());
        require(!generic || k==0,IFCLITE_SMLIB_KERNEL_ERROR,"affine conversion left specialized curve");
        if(certificate) ++certificate->source_classes[k]; }
    for(auto* s:surfaces) { const auto k=surface_class(s->GetType());
        require(!generic || k==6,IFCLITE_SMLIB_KERNEL_ERROR,"affine conversion left specialized surface");
        if(certificate) ++certificate->source_classes[k]; }
    for(auto* c:curves) {
        auto* b=static_cast<SmBSplineCurve*>(c);
        require(b->GetGwNurbPointer(),IFCLITE_SMLIB_UNSUPPORTED,"source curve lacks materialized rational coefficients");
        SmTArray<double> k; checked(b->GetKnotsAll(k)); knots(k.GetDataArray(),k.GetSize(),SM_EFF_ZERO);
        ULONG n=0; double* p=nullptr; checked(b->GetControlPointsPointer(n,p)); points(p,n);
    }
    for(auto* s:surfaces) {
        auto* b=static_cast<SmBSplineSurface*>(s);
        require(b->GetGwNurbPointer(),IFCLITE_SMLIB_UNSUPPORTED,"source surface lacks materialized rational coefficients");
        ULONG nu=0,nv=0; double *ku=nullptr,*kv=nullptr;
        checked(b->GetKnotsPointers(nu,nv,ku,kv)); knots(ku,nu,SM_EFF_ZERO_PARAM); knots(kv,nv,SM_EFF_ZERO_PARAM);
        double* p=nullptr; checked(b->GetControlPointsPointer(nu,nv,p)); points(p,size_t(nu)*nv);
    }
    SmTArray<SmVertex*> vertices; source->GetVertices(vertices);
    for(auto* v:vertices) { auto p=v->GetPoint();
        require(std::isfinite(p.x) && std::isfinite(p.y) && std::isfinite(p.z),
            IFCLITE_SMLIB_KERNEL_ERROR,"affine BRep has nonfinite vertex"); }
}
}
std::unique_ptr<SmBrep> copy_affine_rational(SmBrep* source, const double* matrix,
    ifclite_smlib_affine_certificate& certificate) {
    const auto f=factor(matrix);
    ifclite_smlib_affine_certificate prepared{};
    prepared.version=1; prepared.representation=1;
    inspect(source,&prepared,false); // No copy or conversion before eligibility.
    auto result=checked_brep_copy(source);
    try {
    ifclite_smlib_affine_certificate copied{};
    inspect(result.get(),&copied,false);
    for(unsigned i=0;i<12;++i) require(copied.source_classes[i]==prepared.source_classes[i],
        IFCLITE_SMLIB_KERNEL_ERROR,"affine copy changed source representation classes");
    checked(result->TurnToNURBS());
    inspect(result.get(),nullptr,true);
    // Use only checked proper placements and signed diagonal scale. In
    // particular never call matrix Transform -> Mirror -> analytic recognition.
    checked(result->Transform(f.first,nullptr,FALSE));
    checked(result->Transform(f.last,&f.scale,FALSE));
    inspect(result.get(),nullptr,true);
    certificate=prepared;
    return result;
    } catch(...) {
        // Conversion/transform work has begun on SDK-owned topology; leave it
        // untouched and retire the whole domain at the isolation boundary.
        result.release();
        rethrow_tainted_kernel_domain("affine copy conversion/transform");
    }
}
