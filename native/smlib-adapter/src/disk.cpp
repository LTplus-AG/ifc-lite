// SPDX-License-Identifier: MPL-2.0
#include "sweep.hpp"
#include "ifclite_smlib.h"
#include <SmApiBrep.h>
#include <SmApiGeneral.h>
#include <SmApiQueries.h>
#include <SmBSplineCurve.h>
#include <SmCircle.h>
#include <SmPrimitiveCreation.h>
#include <cmath>
#include <cstring>
namespace {
void require(bool valid,const char* message,int32_t status=IFCLITE_SMLIB_INVALID_ARGUMENT) {
    if(!valid) throw SweepFailure{status,message};
}
void checked(SmStatus status) {
    require(status==SM_SUCCESS,"swept disk SDK operation failed",IFCLITE_SMLIB_KERNEL_ERROR);
}
struct Reader {
    const std::vector<uint8_t>& bytes; size_t offset=0;
    uint32_t u32() {
        require(offset<=bytes.size() && bytes.size()-offset>=4,"short disk recipe");
        uint32_t value=0; for(unsigned j=0;j<4;++j)value|=uint32_t(bytes[offset++])<<(8*j);
        return value;
    }
    double f64() {
        const uint64_t lo=u32(),bits=lo|(uint64_t(u32())<<32); double v;std::memcpy(&v,&bits,8);
        require(std::isfinite(v) && std::abs(v)<=1e9,"disk coefficient outside numerical domain");return v;
    }
};
template<class T> void add(SmTArray<T>& a,const T& value) {
    const auto size=a.GetSize();
    require(a.Add(value)==size,"disk coefficient allocation failed",IFCLITE_SMLIB_RESOURCE_LIMIT);
}
}
std::unique_ptr<SmBrep> create_authored_disk(const std::vector<uint8_t>& bytes) {
    Reader r{bytes};
    require(r.u32()==2 && r.u32()==1 && r.u32()==1 && r.u32()==0,"disk declaration mismatch");
    const double radius=r.f64(),inner=r.f64();
    require(radius>1e-12,"invalid disk radius");
    require(inner==0,"hollow swept disks unsupported",IFCLITE_SMLIB_UNSUPPORTED);
    require(r.u32()==4 && r.u32()==0,"expected rational path record");
    const uint32_t degree=r.u32(),n=r.u32(),k=r.u32(),flags=r.u32();
    require(degree>=1 && degree<=32 && n>degree && n<=8192 && k>=2 && k<=8192 && flags==0,
        "invalid rational path counts/flags");
    require(bytes.size()==72ull+32ull*n+16ull*k,"rational path length mismatch");
    const double start=r.f64(),end=r.f64();
    require(end>start,"invalid rational trim interval");
    SmTArray<SmPoint3d> points; SmTArray<double> weights,knots; SmTArray<ULONG> multiplicities;
    for(uint32_t i=0;i<n;++i) {
        const double x=r.f64(),y=r.f64(),z=r.f64(),w=r.f64();
        require(w>0,"rational weights must be positive");
        add(points,SmPoint3d(x,y,z));add(weights,w);
    }
    uint64_t sum=0; double first=0,previous=0;
    for(uint32_t i=0;i<k;++i) {
        const double knot=r.f64();const uint32_t mult=r.u32();
        require(r.u32()==0 && (i==0 || knot>previous),"invalid unique knot sequence");
        require((i==0 || i+1==k)?mult==degree+1:(mult>0 && mult<=degree),"invalid knot multiplicity");
        if(i==0)first=knot;previous=knot;sum+=mult;
        add(knots,knot);add(multiplicities,ULONG(mult));
    }
    require(sum==uint64_t(n)+degree+1 && start>=first && end<=previous && r.offset==bytes.size(),
        "invalid clamped rational domain");
    SmExtent1d trim(start,end); SmBSplineCurve* raw_path=nullptr;
    const auto status=SmBSplineCurve::CreateCanonical(*SmApiGetOrCreateContext(),3,degree,points,
        SM_CF_UNSPECIFIED,multiplicities,knots,SM_KT_UNSPECIFIED,&weights,&trim,raw_path);
    std::unique_ptr<SmBSplineCurve> path(raw_path);checked(status);
    require(path!=nullptr,"null rational path",IFCLITE_SMLIB_KERNEL_ERROR);
    SmPoint3d a,b;checked(path->EvaluatePoint(start,a));checked(path->EvaluatePoint(end,b));
    require((b-a).Length()>1e-10,"closed/collapsed disk paths unsupported",IFCLITE_SMLIB_UNSUPPORTED);
    // The pinned convenience pipe helper leaves its temporary profile circle
    // unowned. Own that profile here and use the identical borrowed-input
    // primitive route, including its path-size-based tolerance and options.
    SmCircle* raw_circle=nullptr;SmAxis2Placement placement;SmExtent1d domain(0.,360.);
    const auto circle_status=SmCircle::CreateCanonical(*SmApiGetOrCreateContext(),placement,radius,raw_circle,&domain);
    std::unique_ptr<SmCircle> circle(raw_circle);checked(circle_status);
    require(circle!=nullptr,"null pipe profile",IFCLITE_SMLIB_KERNEL_ERROR);
    SmTArray<SmCurve*> profile;add(profile,static_cast<SmCurve*>(circle.get()));
    SmExtent3d bounds;checked(path->CalculateBoundingBox(path->GetNaturalInterval(),&bounds));
    const double tolerance=bounds.GetSize().Length()*0.5*SM_ZONE_TOL_3D*100.;
    require(std::isfinite(tolerance) && tolerance>0,"invalid pipe path tolerance");
    SmSweepOptions options;options.bCapEndsArg=TRUE;options.bTranslationalSweep=FALSE;
    options.bMoveProfileCenterToPath=TRUE;options.bOrientProfilePerpendicularToPath=TRUE;
    options.bMoveToProfile=FALSE;
    std::unique_ptr<SmBrep> solid(new (*SmApiGetOrCreateContext()) SmBrep());
    SmPrimitiveCreation creation(solid->GetInfiniteRegion(),0,true);
    SmTArray<SmFace*> start_faces,side_faces,end_faces;
    checked(creation.CreateCurveSweep(profile,path.get(),nullptr,nullptr,tolerance,&options,
        start_faces,side_faces,end_faces));
    require(solid!=nullptr,"null swept disk",IFCLITE_SMLIB_KERNEL_ERROR);
    SmBoolean manifold=FALSE;double volume=0;
    checked(SmApiBrepIsManifoldSolid(solid.get(),manifold));
    checked(SmApiBrepComputeVolume(solid.get(),1e-8,volume));
    require(manifold && std::isfinite(volume) && volume>0,"disk is not a positive manifold solid",
        IFCLITE_SMLIB_KERNEL_ERROR);
    return solid;
}
