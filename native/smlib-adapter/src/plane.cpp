// SPDX-License-Identifier: MPL-2.0
#include "plane.hpp"
#include "plane_domain.hpp"
#include "copy.hpp"
#include "empty.hpp"
#include "context_metadata.hpp"
#include <SmApiBrep.h>
#include <SmFace.h>
#include <SmPlane.h>
#include <algorithm>
#include <array>
#include <cstdio>
namespace {
using namespace plane_numeric;
using Solid=std::unique_ptr<SmBrep>;
SmAxis2Placement frame_for(const double* p,int kept) {
    require(p,"null plane",IFCLITE_SMLIB_INVALID_ARGUMENT);
    for(unsigned i=0;i<6;++i) require(std::isfinite(p[i]),"nonfinite plane",IFCLITE_SMLIB_INVALID_ARGUMENT);
    const double scale=std::max({std::abs(p[3]),std::abs(p[4]),std::abs(p[5])});
    require(scale>0,"zero plane normal",IFCLITE_SMLIB_INVALID_ARGUMENT);
    const double length=std::hypot(p[3]/scale,p[4]/scale,p[5]/scale);
    SmVector3d n(kept*((p[3]/scale)/length),kept*((p[4]/scale)/length),kept*((p[5]/scale)/length));
    // Choose the least-aligned coordinate axis; no tiny cross product.
    unsigned k=0; for(unsigned j=1;j<3;++j) if(std::abs(n[j])<std::abs(n[k])) k=j;
    SmVector3d axis(0,0,0); axis[k]=1;
    SmVector3d x=axis*n; checked(x.Unitize());
    SmVector3d y=n*x; checked(y.Unitize());
    SmAxis2Placement frame; checked(frame.SetCanonical(SmPoint3d(p[0],p[1],p[2]),x,y));
    const auto actual=frame.GetZAxis();
    for(unsigned d=0;d<3;++d) require(std::isfinite(actual[d]) &&
        std::abs(actual[d]-n[d])<=64*std::numeric_limits<double>::epsilon(),
        "effective plane basis residual",IFCLITE_SMLIB_KERNEL_ERROR);
    return frame;
}
Bounds projected(const Bounds& world,const SmAxis2Placement& frame) {
    const auto origin=frame.GetOrigin();
    const SmVector3d axes[]={frame.GetXAxis(),frame.GetYAxis(),frame.GetZAxis()};
    Bounds result{};
    // Inverse of the effective basis, rather than assuming the rounded
    // orthonormal basis is an exactly orthogonal real matrix.
    const double a=axes[0].Dot(axes[1]*axes[2]);
    require(std::isfinite(a) && a>0,"singular plane basis");
    // Cross products/determinants themselves are rounded. Interval versions
    // below enclose the real inverse of these stored binary64 basis vectors.
    auto cross=[&](unsigned i,unsigned j,unsigned d) {
        return exact(axes[i][(d+1)%3])*exact(axes[j][(d+2)%3])-
            exact(axes[i][(d+2)%3])*exact(axes[j][(d+1)%3]);
    };
    Interval determinant=exact(0);
    for(unsigned d=0;d<3;++d) determinant=determinant+exact(axes[0][d])*cross(1,2,d);
    require(determinant.lo>0 && std::isfinite(determinant.hi),"uncertifiable plane determinant");
    const Interval reciprocal{down(1/determinant.hi),up(1/determinant.lo)};
    for(unsigned i=0;i<3;++i) {
        result[i]=exact(0);
        for(unsigned d=0;d<3;++d) result[i]=result[i]+
            ((world[d]-exact(origin[d]))*cross((i+1)%3,(i+2)%3,d))*reciprocal;
        require(std::isfinite(result[i].lo) && std::isfinite(result[i].hi),"plane projected domain overflow");
    }
    return result;
}
SmFace* face(SmBrep* brep,const SmPoint3d& origin,const SmVector3d& x,const SmVector3d& y,
    double u0,double v0,double u1,double v1) {
    SmAxis2Placement frame; checked(frame.SetCanonical(origin,x,y));
    SmPlane* surface=nullptr;
    checked(SmPlane::CreateCanonical(*brep->GetContext(),frame,surface));
    require(surface,"null derived cutter plane",IFCLITE_SMLIB_KERNEL_ERROR);
    SmExtent2d uv(u0,v0,u1,v1); checked(surface->AdjustSTEPUVDomain(uv));
    SmFace* output=nullptr; checked(brep->CreateFaceFromSurface(surface,uv,output));
    require(output,"null derived cutter face",IFCLITE_SMLIB_KERNEL_ERROR);
    return output;
}
bool same(const SmVector3d& a,const SmVector3d& b) {
    return a.x==b.x && a.y==b.y && a.z==b.z;
}
void enclosing_wall(SmFace* f,const Bounds& domain,const SmVector3d& inward,double tolerance) {
    require(f && f->GetSurface() && f->GetSurface()->GetType()==SmPlane_TYPE,
        "derived cutter lost planar face",IFCLITE_SMLIB_KERNEL_ERROR);
    const auto& p=static_cast<SmPlane*>(f->GetSurface())->GetPosition();
    const auto x=p.GetXAxis(),y=p.GetYAxis(),origin=p.GetOrigin();
    const double sign=(x*y).Dot(inward)>0?1.:-1.;
    Interval distance=exact(0);
    for(unsigned d=0;d<3;++d) {
        auto normal=(exact(x[(d+1)%3])*exact(y[(d+2)%3])-
            exact(x[(d+2)%3])*exact(y[(d+1)%3]))*exact(sign);
        distance=distance+(domain[d]-exact(origin[d]))*normal;
    }
    // ||cross(X,Y)|| < 2 for the checked effective unit basis. Account for
    // both source and actual cutter face tolerance, without moving the cut.
    const double gap=up(2*up(tolerance+f->GetTolerance()));
    require(std::isfinite(gap) && gap>0 && distance.lo>gap,
        "actual derived sidewall/back does not strictly enclose finite input domain");
}
Solid cutter_for(SmBrep* source,const SmAxis2Placement& frame,const Bounds& b,const PlaneDomain& domain,const double* requested_plane) {
    Solid result=raw_context::construct_brep(source->GetContext());
    try {
        result->m_bEditingEnabled=TRUE;
        const auto p=frame.GetOrigin();
        const auto x=frame.GetXAxis(),y=frame.GetYAxis(),z=frame.GetZAxis();
        // This face is anchored to the ORIGINAL point. Clearance never moves
        // the requested plane. Negative UV extents keep its original origin.
        auto* base=face(result.get(),p,x,y,b[0].lo,b[1].lo,b[0].hi,b[1].hi);
        auto* back=face(result.get(),p+z*b[2].hi,x,y,b[0].lo,b[1].lo,b[0].hi,b[1].hi);
        auto* left=face(result.get(),p+x*b[0].lo,y,z,b[1].lo,0,b[1].hi,b[2].hi);
        auto* right=face(result.get(),p+x*b[0].hi,y,z,b[1].lo,0,b[1].hi,b[2].hi);
        auto* front=face(result.get(),p+y*b[1].lo,x,z,b[0].lo,0,b[0].hi,b[2].hi);
        auto* rear=face(result.get(),p+y*b[1].hi,x,z,b[0].lo,0,b[0].hi,b[2].hi);
        checked(result->StitchAndOrient()); result->m_bEditingEnabled=FALSE;
        validate_plane_solid(result.get(),"derived cutter");
        SmTArray<SmFace*> live; result->GetFaces(live);
        require(live.GetSize()==6,"derived cutter changed its face set",IFCLITE_SMLIB_KERNEL_ERROR);
        for(auto* expected:{base,back,left,right,front,rear}) {
            bool present=false; for(auto* current:live) present|=current==expected;
            require(present,"derived cutter replaced an owned face",IFCLITE_SMLIB_KERNEL_ERROR);
        }
        require(base->GetSurface()->GetType()==SmPlane_TYPE,"derived base plane lost");
        const auto& actual=static_cast<SmPlane*>(base->GetSurface())->GetPosition();
        const bool unchanged=same(actual.GetOrigin(),p) &&
            ((same(actual.GetXAxis(),x) && same(actual.GetYAxis(),y)) ||
             (same(actual.GetXAxis(),y) && same(actual.GetYAxis(),x)));
        if(!unchanged) {
            // Diagnostic only: read stored analytic coefficients; no evaluation,
            // mutation, changed predicate, tolerance or publication authority.
            const auto ax=actual.GetXAxis(),ay=actual.GetYAxis();
            const auto ao=actual.GetOrigin(); const auto az=ax*ay;
            const auto scale=static_cast<SmPlane*>(base->GetSurface())->GetUVScale();
            std::fprintf(stderr,"plane cutter rejection stage=after-StitchAndOrient basis/origin\n");
            std::fprintf(stderr,"plane requested raw point=(%.17g %.17g %.17g) normal=(%.17g %.17g %.17g)\n",
                requested_plane[0],requested_plane[1],requested_plane[2],
                requested_plane[3],requested_plane[4],requested_plane[5]);
            std::fprintf(stderr,"plane constructed origin=(%.17g %.17g %.17g) X=(%.17g %.17g %.17g) Y=(%.17g %.17g %.17g) Z=(%.17g %.17g %.17g)\n",
                p.x,p.y,p.z,x.x,x.y,x.z,y.x,y.y,y.z,z.x,z.y,z.z);
            std::fprintf(stderr,"plane effective origin=(%.17g %.17g %.17g) X=(%.17g %.17g %.17g) Y=(%.17g %.17g %.17g) crossXY=(%.17g %.17g %.17g) UVscale=(%.17g %.17g)\n",
                ao.x,ao.y,ao.z,ax.x,ax.y,ax.z,ay.x,ay.y,ay.z,az.x,az.y,az.z,scale.x,scale.y);
        }
        require(unchanged,"SDK changed the requested clipping plane basis/origin");
        enclosing_wall(back,domain.bounds,z*-1,domain.tolerance);
        enclosing_wall(left,domain.bounds,x,domain.tolerance);
        enclosing_wall(right,domain.bounds,x*-1,domain.tolerance);
        enclosing_wall(front,domain.bounds,y,domain.tolerance);
        enclosing_wall(rear,domain.bounds,y*-1,domain.tolerance);
        return result;
    } catch(...) {
        result.release(); // includes potentially unlinked planes/topology
        rethrow_tainted_kernel_domain("derived plane cutter construction");
    }
}
}
std::unique_ptr<SmBrep> clip_finite_plane(SmBrep* source,const double* plane,
    int32_t side,uint32_t mode,ifclite_smlib_plane_certificate& certificate) {
    using namespace plane_numeric;
    require(source && source->GetContext(),"plane source lacks context",IFCLITE_SMLIB_INVALID_ARGUMENT);
    raw_context::Restore preserve_context(source->GetContext());
    require(side==1 || side==-1,"plane side must be +/-1",IFCLITE_SMLIB_INVALID_ARGUMENT);
    require(mode==IFCLITE_SMLIB_INTERSECTION || mode==IFCLITE_SMLIB_DIFFERENCE,
        "only finite host Intersection/Difference clipping is supported",IFCLITE_SMLIB_UNSUPPORTED);
    auto frame=frame_for(plane,mode==IFCLITE_SMLIB_DIFFERENCE?-side:side);
    auto domain=certify_plane_domain(source);
    ifclite_smlib_plane_certificate c{}; c.version=1; c.method=domain.methods; c.frame=1; c.side=side; c.mode=mode;
    std::copy(plane,plane+6,c.plane); c.faces=domain.faces; c.edges=domain.edges; c.coefficients=domain.coefficients;
    c.cylinder_count=domain.cylinder_count;
    std::copy(domain.cylinders.begin(),domain.cylinders.end(),c.cylinders);
    const SmVector3d axes[]={frame.GetXAxis(),frame.GetYAxis(),frame.GetZAxis()};
    for(unsigned i=0;i<3;++i) for(unsigned j=0;j<3;++j) c.basis[3*i+j]=axes[i][j];
    for(unsigned d=0;d<3;++d) { c.domain[d]=domain.bounds[d].lo; c.domain[3+d]=domain.bounds[d].hi; }
    if(domain.empty) { auto output=checked_brep_copy(source); c.empty=1; certificate=c; return output; }
    auto b=projected(domain.bounds,frame);
    // Existing SDK topology tolerances + arithmetic enclosure. No model-size
    // heuristic or giant box; only sidewalls and the back face are expanded.
    c.clearance=up(16*domain.tolerance);
    require(std::isfinite(c.clearance) && c.clearance>0,"uncertifiable cutter clearance");
    for(unsigned d=0;d<2;++d) b[d]=b[d]+Interval{-c.clearance,c.clearance};
    b[2].hi=up(std::max(0.,b[2].hi)+c.clearance); b[2].lo=0;
    for(unsigned d=0;d<3;++d) {
        require(std::isfinite(b[d].lo) && std::isfinite(b[d].hi) && b[d].lo<b[d].hi,
            "derived cutter extent overflow/collapse");
        c.cutter[d]=b[d].lo; c.cutter[3+d]=b[d].hi;
    }
    Solid a,bounded;
    try {
        a=checked_brep_copy(source);
        // Full SDK validators may evaluate/build trim data. Run them only on
        // the owned copy after source representation admission, never source.
        validate_plane_solid(a.get(),"copied host before Boolean");
        bounded=cutter_for(source,frame,b,domain,plane);
        SmBrep* raw=nullptr;
        const auto status=SmApiBoolean(a.get(),bounded.get(),SM_BO_INTERSECTION,raw);
        // SDK may mutate/delete operands before reporting failure. Never run
        // their destructors or publish a partially completed numerical object.
        checked(status); bounded.release();
        require(raw==a.get(),"unexpected clipping result ownership",IFCLITE_SMLIB_KERNEL_ERROR);
        validate_plane_solid(a.get(),"Boolean output");
        c.empty=semantically_empty_brep(a.get())?1u:0u;
        certificate=c; return a;
    } catch(...) {
        a.release(); bounded.release();
        rethrow_tainted_kernel_domain("finite plane Boolean");
    }
}
