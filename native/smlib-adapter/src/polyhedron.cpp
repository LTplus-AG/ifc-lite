// SPDX-License-Identifier: MPL-2.0
// A closed polyhedral solid from authored triangles (wire format 3, #8291):
// one planar face per triangle, stitched. Open or non-manifold shells refuse.
#include "sweep.hpp"
#include "copy.hpp"
#include "ifclite_smlib.h"
#include <SmApiBrep.h>
#include <SmApiCurves.h>
#include <SmApiQueries.h>
#include <SmApiTrimmedSurfaces.h>
#include <SmLine.h>
#include <array>
#include <cmath>
#include <cstring>
namespace {
using Point=std::array<double,3>;
void require(bool valid,const char* message,int32_t status=IFCLITE_SMLIB_INVALID_ARGUMENT) {
    if(!valid) throw AdapterFailure{status,message};
}
void checked(SmApiStatus status,const char* message) {
    require(status==SM_SUCCESS,message,IFCLITE_SMLIB_KERNEL_ERROR);
}
struct Reader {
    const std::vector<uint8_t>& bytes; size_t offset=0;
    uint32_t u32() {
        require(offset<=bytes.size() && bytes.size()-offset>=4,"short polyhedron recipe");
        uint32_t value=0; for(unsigned j=0;j<4;++j) value|=uint32_t(bytes[offset++])<<(8*j);
        return value;
    }
    double f64() {
        const uint64_t lo=u32(),bits=lo|(uint64_t(u32())<<32); double value; std::memcpy(&value,&bits,8);
        require(std::isfinite(value) && std::abs(value)<=1e9,"polyhedron coordinate outside numerical domain");
        return value;
    }
};
std::unique_ptr<SmBrep> triangle_face(const Point& a,const Point& b,const Point& c) {
    std::array<std::unique_ptr<SmLine>,3> lines;
    const std::array<Point,4> ring{a,b,c,a};
    SmTArray<SmCurve*> curves;
    for(unsigned i=0;i<3;++i) {
        SmLine* raw=nullptr;
        const auto status=SmApiCreateLineSegment(SmPoint3d(ring[i][0],ring[i][1],ring[i][2]),
            SmPoint3d(ring[i+1][0],ring[i+1][1],ring[i+1][2]),raw);
        lines[i].reset(raw); checked(status,"polyhedron edge SDK operation failed");
        require(curves.Add(raw)==i,"curve array allocation failed",IFCLITE_SMLIB_RESOURCE_LIMIT);
    }
    SmBrep* raw=nullptr;
    const auto status=SmApiCreatePlanarFaces(curves,raw);
    std::unique_ptr<SmBrep> face(raw); checked(status,"polyhedron face SDK operation failed");
    require(face!=nullptr,"null polyhedron face");
    for(auto& line:lines) line.release(); // Consumed by the new face on success.
    return face;
}
}
std::unique_ptr<SmBrep> create_authored_polyhedron(const std::vector<uint8_t>& bytes,uint32_t segments) {
    Reader reader{bytes};
    require(reader.u32()==3,"polyhedron declaration mismatch");
    const uint32_t vertices=reader.u32(),triangles=reader.u32(); (void)reader.u32();
    require(vertices>=4 && triangles>=4 && triangles==segments && triangles<=8192,"invalid polyhedron counts");
    require(bytes.size()==16ull+24ull*vertices+16ull*triangles,"polyhedron length mismatch");
    std::vector<Point> points(vertices);
    for(Point& point:points) for(double& value:point) value=reader.f64();
    std::unique_ptr<SmBrep> solid;
    double six_volume=0;
    for(uint32_t t=0;t<triangles;++t) {
        const uint32_t i=reader.u32(),j=reader.u32(),k=reader.u32();
        require(i<vertices && j<vertices && k<vertices,"polyhedron corner outside its point list");
        const Point& a=points[i],&b=points[j],&c=points[k];
        six_volume+=a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]);
        auto face=triangle_face(a,b,c);
        if(!solid) { solid=std::move(face); continue; }
        // MergeBrep can allocate topology before inserting it: as for a checked copy,
        // nothing proves cleanup after a failure, so keep it untouched and taint the domain.
        try {
            require(solid->MergeBrep(*face,nullptr,nullptr,FALSE)==SM_SUCCESS,
                "polyhedron face merge failed",IFCLITE_SMLIB_KERNEL_ERROR);
        } catch(...) {
            solid.release(); face.release();
            rethrow_tainted_kernel_domain("polyhedron face merge");
        }
    }
    const double expected=std::abs(six_volume)/6;
    require(expected>0,"polyhedron encloses no volume",IFCLITE_SMLIB_UNSUPPORTED);
    SmBoolean closed=FALSE; ULONG stitched=0; double vertex_gap=0,edge_gap=0;
    checked(SmApiStitchIntoSolid(solid.get(),closed,stitched,vertex_gap,edge_gap),"polyhedron stitch failed");
    require(closed,"open or non-manifold shell has no solid",IFCLITE_SMLIB_UNSUPPORTED);
    SmBoolean manifold=FALSE; checked(SmApiBrepIsManifoldSolid(solid.get(),manifold),"polyhedron manifold query failed");
    double volume=0; checked(SmApiBrepComputeVolume(solid.get(),1e-8,volume),"polyhedron volume query failed");
    require(manifold && std::isfinite(volume) && std::abs(std::abs(volume)-expected)<=expected*1e-5,
        "polyhedron failed manifold/volume invariant",IFCLITE_SMLIB_KERNEL_ERROR);
    return solid;
}
