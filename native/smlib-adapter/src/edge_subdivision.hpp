// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "representation_seal.hpp"
#include <SmCurve.h>
#include <SmEdge.h>
#include <SmEdgeuse.h>
#include <SmFace.h>
#include <SmVertex.h>
#include <SmVertexuse.h>
#include <memory>
namespace face_lineage {
// Private receipt for the observed MakeVertexSplitEdge restriction protocol.
// No public entrypoint, callback suppression, or inferred face ancestry.
class EdgeSubdivision {
    Ledger& ledger;
    SmContext scratch_context;
    RepresentationSeal geometry;
    Identity operation{},body_generation{};
    uint64_t serial=0;
    uint32_t frame=0,count=0,step=0,index=0;
    enum Stage { Idle,Faces,EdgeBirth,VertexBirth,CurveBirth,EdgeGeometry,CurveOwner,CurveSplit,
        OldPre,OldPost,NewPre,NewPost,Point,UseBirth,VertexUseBirth,
        UVBirth,UVPre,UVPost,UVNewPre,UVNewPost,TempDeath,AddVertex,Complete } stage=Idle;
    struct Live { SmObject* object=nullptr; Identity generation{}; };
    struct Incident { SmFace* face; SmObject* surface; Identity identity; std::vector<uint64_t> representation; };
    struct Use {
        SmEdgeuse* original=nullptr; Identity generation{};
        SmFace* face=nullptr; SmLoopuse* loop=nullptr; SmVertexuse* vertex=nullptr;
        SmEdgeuse* cw=nullptr; SmEdgeuse* ccw=nullptr; SmOrientType orientation=SM_OT_SAME;
        SmCurve* uv=nullptr; Identity uv_generation{};
        std::unique_ptr<SmCurve> frozen;
        Live child{},child_vertex{},child_uv{};
    };
    SmBrep* body=nullptr;
    SmEdge* edge=nullptr;
    Identity edge_generation{},curve_generation{};
    SmCurve* curve=nullptr;
    Live child{},vertex{},child_curve{};
    SmExtent1d interval,first,second;
    double tolerance=0,cut=0;
    SmPoint3d point;
    std::unique_ptr<SmCurve> frozen;
    std::vector<Incident> faces;
    std::vector<Use> uses;
    struct Link { SmEdgeuse* object; SmEdgeuse* cw; SmEdgeuse* ccw; };
    std::vector<Link> links;
    std::unique_ptr<SmCurve> expected_first,expected_second;
#ifdef IFCLITE_LINEAGE_FAILURE_STACK
    // Diagnostic-only scalars, never consulted by operation authority. Values
    // are captured while objects are live; reporting performs no SDK access.
    const char* checkpoint="issued",*geometry_role="none";
    uintptr_t diagnostic_object=0;
    long diagnostic_type=0;
    unsigned diagnostic_dimension=0;
    bool diagnostic_nurb=false,diagnostic_borrowed=false,diagnostic_attributes=false;
#endif
    void require(bool,const char*);
    void start(SmEdge*);
    void complete();
    Live birth(Event&,SmObject*);
    void live(SmObject*,Identity);
    std::unique_ptr<SmCurve> copy(SmCurve*);
    std::unique_ptr<SmCurve> restricted(SmCurve*,SmExtent1d,SmExtent1d* rounded=nullptr);
    void exact(SmCurve*,SmCurve*);
    std::vector<uint64_t> surface(SmObject*);
    void next_uv();
public:
    EdgeSubdivision(Ledger&,SmBrep&);
    ~EdgeSubdivision();
    bool event(Event&,SmNotifyOperation,SmObject*,SmObject*,SmObject*,SmObject*);
    void finish();
#ifdef IFCLITE_LINEAGE_FAILURE_STACK
    void report_exception() const noexcept;
#endif
};
}
