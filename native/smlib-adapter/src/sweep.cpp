// SPDX-License-Identifier: MPL-2.0
#include "sweep.hpp"
#include "ifclite_smlib.h"
#include <SmApiBrep.h>
#include <SmApiCurves.h>
#include <SmApiQueries.h>
#include <SmBSplineCurve.h>
#include <SmLine.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>

namespace {
constexpr double pi=3.14159265358979323846;
using Point=std::array<double,2>;
void require(bool valid, const char* message, int32_t status=IFCLITE_SMLIB_INVALID_ARGUMENT) {
    if (!valid) throw SweepFailure{status,message};
}
void checked(SmApiStatus status) {
    require(status==SM_SUCCESS,"authored sweep SDK operation failed",IFCLITE_SMLIB_KERNEL_ERROR);
}
struct Reader {
    const std::vector<uint8_t>& bytes;
    size_t offset=0;
    uint32_t u32() {
        require(offset<=bytes.size() && bytes.size()-offset>=4,"short sweep recipe");
        uint32_t value=0;
        for(unsigned i=0;i<4;++i) value|=uint32_t(bytes[offset++])<<(8*i);
        return value;
    }
    double f64() {
        const uint64_t lo=u32(), bits=lo|(uint64_t(u32())<<32);
        double value; std::memcpy(&value,&bits,8);
        require(std::isfinite(value) && std::abs(value)<=1e9,"sweep coefficient outside local numerical domain");
        return value;
    }
};
struct Segment {
    std::unique_ptr<SmCurve> curve;
    Point start,end;
    double twice_area;
};
Segment read_segment(Reader& reader) {
    const uint32_t kind=reader.u32();
    require(reader.u32()==0,"nonzero reserved curve field");
    double v[12]; for(double& value:v) value=reader.f64();
    Segment segment;
    if(kind==1) {
        require(v[2]==0 && v[5]==0,"profile must be XY planar");
        for(unsigned j=6;j<12;++j) require(v[j]==0,"nonzero line padding");
        require(std::hypot(v[3]-v[0],v[4]-v[1])>1e-12,"collapsed sweep line");
        segment.start={v[0],v[1]}; segment.end={v[3],v[4]};
        segment.twice_area=v[0]*v[4]-v[3]*v[1];
        SmLine* raw=nullptr;
        const auto status=SmApiCreateLineSegment(SmPoint3d(v[0],v[1],0),SmPoint3d(v[3],v[4],0),raw);
        segment.curve.reset(raw); checked(status);
    } else if(kind==2 || kind==3) {
        require(v[2]==0 && v[3]==0 && v[4]==0 && std::abs(v[5])==1 && v[8]==0 &&
            std::abs(std::hypot(v[6],v[7])-1)<1e-12 && v[9]>1e-12,
            "invalid XY circular basis");
        const double sweep=v[11];
        require(kind==2 ? std::abs(std::abs(sweep)-2*pi)<1e-12 :
            (std::abs(sweep)>1e-12 && std::abs(sweep)<2*pi-1e-12),"invalid circular interval");
        require(v[0]+v[9]>v[0] && v[1]+v[9]>v[1],"collapsed circle extent");
        // IFC angle conventions have already been resolved by the source owner.
        // Convert derived radians exactly once at the SDK's degree boundary.
        const double start=std::remainder(v[10],2*pi), end=start+sweep;
        SmBSplineCurve* raw=nullptr;
        const auto status=SmApiCreateArc(SmPoint3d(0,0,0),v[9],
            std::min(start,end)*180/pi,std::max(start,end)*180/pi,raw);
        segment.curve.reset(raw); checked(status);
        require(segment.curve!=nullptr,"null authored arc");
        if(sweep<0) {
            SmExtent1d reversed;
            checked(segment.curve->ReverseParameterization(segment.curve->GetNaturalInterval(),reversed));
        }
        // Preserve the authored circular frame, including normal/traversal.
        const double yx=-v[5]*v[7], yy=v[5]*v[6];
        SmAxis2Placement frame;
        frame.SetCanonical(SmPoint3d(v[0],v[1],0),SmVector3d(v[6],v[7],0),SmVector3d(yx,yy,0));
        checked(segment.curve->Transform(frame));
        auto point=[&](double angle) -> Point {
            return {v[0]+v[9]*(v[6]*std::cos(angle)+yx*std::sin(angle)),
                v[1]+v[9]*(v[7]*std::cos(angle)+yy*std::sin(angle))};
        };
        segment.start=point(start); segment.end=point(end);
        segment.twice_area=v[0]*(segment.end[1]-segment.start[1])-
            v[1]*(segment.end[0]-segment.start[0])+v[5]*v[9]*v[9]*sweep;
    } else require(false,"unsupported authored curve",IFCLITE_SMLIB_UNSUPPORTED);
    require(segment.curve!=nullptr,"null authored curve");
    return segment;
}
bool connected(Point a,Point b) { return std::hypot(a[0]-b[0],a[1]-b[1])<=1e-10; }
}
std::unique_ptr<SmBrep> create_authored_sweep(const std::vector<uint8_t>& bytes,
    uint32_t loops,uint32_t segments) {
    Reader reader{bytes};
    require(reader.u32()==1 && reader.u32()==loops && reader.u32()==segments &&
        reader.u32()==0,"sweep declaration mismatch");
    require(loops>0 && loops<=128 && loops<=segments && segments<=8192,"invalid sweep region");
    const double dx=reader.f64(),dy=reader.f64(),dz=reader.f64(),depth=reader.f64();
    require(std::abs(std::hypot(std::hypot(dx,dy),dz)-1)<1e-12 && dz!=0 && depth>0,
        "invalid sweep direction/depth");
    std::vector<std::unique_ptr<SmCurve>> owned;
    owned.reserve(segments);
    SmTArray<SmCurve*> curves; // Non-owning; API copies inputs before consuming.
    double twice_area=0;
    uint32_t consumed=0;
    for(uint32_t loop=0;loop<loops;++loop) {
        require(reader.u32()==(loop==0?0u:1u),"expected outer loop followed by inner loops");
        const uint32_t count=reader.u32();
        require(count>0 && count<=segments-consumed,"invalid loop segment count");
        Point first{},previous{}; double loop_area=0;
        for(uint32_t i=0;i<count;++i) {
            auto segment=read_segment(reader);
            if(i==0) first=segment.start;
            else require(connected(previous,segment.start),"disconnected sweep loop");
            previous=segment.end; loop_area+=segment.twice_area;
            require(curves.Add(segment.curve.get())==consumed++,"curve array allocation failed",IFCLITE_SMLIB_RESOURCE_LIMIT);
            owned.push_back(std::move(segment.curve));
        }
        require(connected(previous,first),"open sweep loop");
        // Legacy single-loop format1 accepted either orientation. Multiple-loop
        // regions have explicit outer CCW / hole CW winding, never inferred.
        require(std::abs(loop_area)>1e-18 && (loops==1 || (loop==0 ? loop_area>0 : loop_area<0)),
            "zero-area or inconsistent loop winding");
        twice_area+=loop_area;
    }
    require(consumed==segments && reader.offset==bytes.size(),"sweep count/trailing bytes mismatch");
    const double expected=std::abs(twice_area)*0.5*depth*std::abs(dz);
    require(twice_area!=0 && (loops==1 || twice_area>0) && std::isfinite(expected) &&
        expected>0 && depth*std::abs(dz)>1e-12,"collapsed projected sweep extent");
    SmBrep* raw=nullptr;
    const auto status=SmApiCreateLinearSweep(curves,SmVector3d(dx,dy,dz),depth,TRUE,raw);
    std::unique_ptr<SmBrep> solid(raw); checked(status);
    require(solid!=nullptr,"null authored solid");
    SmTArray<SmFace*> faces; solid->GetFaces(faces);
    require(faces.GetSize()>0,"empty authored solid faces");
    SmBoolean manifold=FALSE; checked(SmApiBrepIsManifoldSolid(solid.get(),manifold));
    double volume=0; checked(SmApiBrepComputeVolume(solid.get(),1e-8,volume));
    require(manifold && std::isfinite(volume) && volume>0 && std::abs(volume-expected)<=expected*1e-5,
        "authored sweep failed manifold/volume invariant",IFCLITE_SMLIB_KERNEL_ERROR);
    return solid;
}
