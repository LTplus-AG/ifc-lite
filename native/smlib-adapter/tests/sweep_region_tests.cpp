// SPDX-License-Identifier: MPL-2.0
// Independent actual-SDK witnesses for retained ordered circular regions.
#include "sweep.hpp"
#include "ifclite_smlib.h"
#include <SmApiIntersectors.h>
#include <SmApiQueries.h>
#include <SmFace.h>
#include <SmSurface.h>
#include <SmCurve.h>
#include <SmCylinder.h>
#include <SmSurfOfExtrusion.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <vector>
namespace {
constexpr double pi=3.14159265358979323846;
struct Curve { uint32_t kind; std::array<double,12> v; };
using Loop=std::vector<Curve>;
void check(bool value,const char* label) {
    if(!value) { std::fprintf(stderr,"region witness failed: %s\n",label); std::abort(); }
}
void sdk(SmApiStatus status) { check(status==SM_SUCCESS,"SDK query"); }
void near(double a,double b) { check(std::abs(a-b)<1e-5,"independent analytic value"); }
Curve line(double x,double y,double xx,double yy) { return {1,{x,y,0,xx,yy,0,0,0,0,0,0,0}}; }
Curve arc(double x,double y,double radius,double start,double sweep,bool full=false,double normal=1) {
    return {full?2u:3u,{x,y,0,0,0,normal,1,0,0,radius,start,sweep}};
}
Loop rectangle(double x,double y,double w,double h,bool inner=false) {
    if(inner) return {line(x,y,x,y+h),line(x,y+h,x+w,y+h),line(x+w,y+h,x+w,y),line(x+w,y,x,y)};
    return {line(x,y,x+w,y),line(x+w,y,x+w,y+h),line(x+w,y+h,x,y+h),line(x,y+h,x,y)};
}
void u32(std::vector<uint8_t>& b,uint32_t v) { for(unsigned i=0;i<4;++i)b.push_back(uint8_t(v>>(8*i))); }
void f64(std::vector<uint8_t>& b,double v) {
    uint64_t bits;std::memcpy(&bits,&v,8);for(unsigned i=0;i<8;++i)b.push_back(uint8_t(bits>>(8*i)));
}
std::vector<uint8_t> recipe(const std::vector<Loop>& loops,bool oblique=false) {
    uint32_t count=0;for(const auto& loop:loops)count+=loop.size();
    std::vector<uint8_t> b;for(uint32_t v:{1u,uint32_t(loops.size()),count,0u})u32(b,v);
    for(double v:{oblique?0.6:0.,0.,oblique?0.8:1.,3.})f64(b,v);
    for(unsigned i=0;i<loops.size();++i) {
        u32(b,i==0?0:1);u32(b,loops[i].size());
        for(const auto& c:loops[i]) { u32(b,c.kind);u32(b,0);for(double v:c.v)f64(b,v); }
    }
    return b;
}
void witness(const char* name,const std::vector<Loop>& loops,double area,double perimeter,
    std::array<double,4> xy,unsigned planar,unsigned curved,bool oblique=false) {
    uint32_t count=0;for(const auto& loop:loops)count+=loop.size();
    auto bytes=recipe(loops,oblique);
    auto solid=create_authored_sweep(bytes,loops.size(),count);
    double volume=0;sdk(SmApiBrepComputeVolume(solid.get(),1e-8,volume));
    near(volume,area*(oblique?2.4:3));
    SmPoint3d min,max;sdk(SmApiBrepBoundingBox(solid.get(),TRUE,min,max));
    near(min.x,xy[0]);near(min.y,xy[1]);near(min.z,0);
    near(max.x,xy[2]+(oblique?1.8:0));near(max.y,xy[3]);near(max.z,oblique?2.4:3);
    SmTArray<SmFace*> faces;solid->GetFaces(faces);
    unsigned actual_planar=0,actual_curved=0,cylinders=0,extrusions=0,expected_cylinders=0;
    for(const auto& loop:loops)for(const auto& c:loop)if(c.kind==2)++expected_cylinders;
    for(ULONG i=0;i<faces.GetSize();++i) {
        if(faces[i]->GetSurface()->IsPlanar(1e-8))++actual_planar;
        else ++actual_curved;
        if(faces[i]->GetSurface()->IsKindOf(SmCylinder_TYPE))++cylinders;
        if(faces[i]->GetSurface()->IsKindOf(SmSurfOfExtrusion_TYPE))++extrusions;
    }
    check(actual_planar==planar && actual_curved==curved,"actual planar/curved surface counts");
    check(cylinders==expected_cylinders,"full circles retain actual SDK cylinder surfaces");
    SmTArray<SmCurve*> section;
    const auto status=SmApiIntersectBrepWithPlane(solid.get(),SmVector3d(0,0,oblique?1.2:1.5),
        SmVector3d(0,0,1),section);
    // Own even partial outputs before testing the status.
    std::vector<std::unique_ptr<SmCurve>> owned;
    for(ULONG i=0;i<section.GetSize();++i)owned.emplace_back(section[i]);
    sdk(status);check(!owned.empty(),"nonempty mid-plane section");
    auto on_boundary=[&](double x,double y) {
        for(const auto& loop:loops)for(const auto& c:loop) {
            const auto& v=c.v;
            if(c.kind==1) {
                const double dx=v[3]-v[0],dy=v[4]-v[1],length2=dx*dx+dy*dy;
                const double t=((x-v[0])*dx+(y-v[1])*dy)/length2;
                if(t>=-1e-7 && t<=1+1e-7 && std::hypot(x-v[0]-t*dx,y-v[1]-t*dy)<1e-6)return true;
            } else if(std::abs(std::hypot(x-v[0],y-v[1])-v[9])<1e-6) {
                if(c.kind==2)return true;
                const double angle=std::atan2(v[5]*(y-v[1]),x-v[0]);
                const double t=(angle-v[10])/v[11];
                for(int winding=-1;winding<=1;++winding) {
                    const double shifted=t+2*pi*winding/v[11];
                    if(shifted>=-1e-7 && shifted<=1+1e-7)return true;
                }
            }
        }
        return false;
    };
    double length=0;
    for(const auto& curve:owned) {
        double part=0;sdk(curve->Length(curve->GetNaturalInterval(),1e-8,part));length+=part;
        for(double t:{0.,0.25,0.5,0.75,1.}) {
            SmPoint3d p;sdk(curve->EvaluatePoint(curve->GetNaturalInterval().Evaluate(t),p));
            near(p.z,oblique?1.2:1.5);
            check(on_boundary(p.x-(oblique?0.9:0),p.y),"section samples on independent analytic boundary");
        }
    }
    near(length,perimeter);
    // Also traverse the actual bounded C ABI upload/session/handle path.
    uint64_t session=0,token=0;check(ifclite_smlib_session_create(&session)==0,"session");
    check(ifclite_smlib_sweep_begin(session,1,bytes.size(),loops.size(),count,&token)==0,"region begin");
    for(uint32_t offset=0;offset<bytes.size();) {
        const uint32_t size=std::min(3840u,uint32_t(bytes.size()-offset));
        check(ifclite_smlib_sweep_chunk(session,token,offset,bytes.data()+offset,size)==0,"region chunk");offset+=size;
    }
    ifclite_smlib_handle handle{};check(ifclite_smlib_sweep_commit(session,token,&handle)==0,"region commit");
    check(ifclite_smlib_volume(session,handle,1e-8,&volume)==0,"region volume");near(volume,area*(oblique?2.4:3));
    check(ifclite_smlib_session_destroy(session)==0,"session cleanup");
    std::printf("region witness PASS %s volume=%.12g planes=%u curved=%u cylinders=%u extrusions=%u section=%.12g\n",
        name,volume,actual_planar,actual_curved,cylinders,extrusions,length);
}
}
void run_sweep_region_tests() {
    witness("rectangle",{rectangle(0,0,2,4)},8,12,{0,0,2,4},6,0);
    witness("circle",{{arc(0,0,2,0,2*pi,true)}},4*pi,4*pi,{-2,-2,2,2},2,1);
    witness("clockwise-circle",{{arc(0,0,2,0,-2*pi,true)}},4*pi,4*pi,{-2,-2,2,2},2,1);
    witness("arc-line",{{arc(0,0,2,0,pi),line(-2,0,2,0)}},2*pi,2*pi+4,{-2,0,2,2},3,1);
    witness("reversed-arc-line",{{arc(0,0,2,pi,-pi),line(2,0,-2,0)}},2*pi,2*pi+4,{-2,0,2,2},3,1);
    witness("negative-normal",{{arc(0,0,2,0,-pi,false,-1),line(-2,0,2,0)}},2*pi,2*pi+4,{-2,0,2,2},3,1);
    witness("rectangular-hole",{rectangle(0,0,10,10),rectangle(2,2,2,2,true)},96,48,{0,0,10,10},10,0);
    witness("circular-hole",{rectangle(0,0,10,10),{arc(5,5,2,0,-2*pi,true)}},100-4*pi,40+4*pi,{0,0,10,10},6,1);
    witness("multiple-holes",{rectangle(0,0,10,10),rectangle(2,2,2,2,true),{arc(7,7,1,0,-2*pi,true)}},
        96-pi,48+2*pi,{0,0,10,10},10,1);
    witness("oblique",{rectangle(0,0,2,4)},8,12,{0,0,2,4},6,0,true);
}
