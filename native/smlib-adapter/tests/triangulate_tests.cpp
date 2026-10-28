// SPDX-License-Identifier: MPL-2.0
// #7955: actual SDK topology, shared native/Emscripten test executable.
#include "triangulate.hpp"
#include <SmApiPrimitives.h>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <memory>
#include <utility>

namespace {
void require(bool value,const char* message) {
    if (!value) { std::fprintf(stderr,"triangulate FAIL: %s\n",message); std::exit(1); }
}
void verify(const SmContext& context,const std::array<SmPoint3d,4>& points,
    unsigned diagonal_a,unsigned diagonal_b) {
    // Every cyclic start and both orientations must choose the same diagonal.
    for (unsigned start=0; start<4; ++start) for (unsigned direction : {1u,3u}) {
        std::unique_ptr<SmPolyBrep> poly(new (context) SmPolyBrep(1e-8));
        SmTArray<SmPoint3d> loop;
        for (unsigned i=0; i<4; ++i) loop.Add(points[(start+direction*i)%4]);
        SmPolyFace* face=nullptr;
        require(poly->CreateNonPlanarPoly(nullptr,loop,face)==SM_SUCCESS && face,
            "construct real SDK polygon");
        SmTArray<SmPolyFace*> added;
        require(triangulate_polygon(face,added)==SM_SUCCESS,"triangulate real SDK polygon");
        SmTArray<SmPolyFace*> triangles; poly->GetPolyFaces(triangles);
        require(triangles.GetSize()==2 && added.GetSize()==1,"two triangles with complete attribution");
        std::map<std::pair<unsigned,unsigned>,std::pair<int,int>> incidences;
        for (auto* triangle : triangles) {
            require(triangle->IsTriangle(),"no untriangulated remainder");
            SmTArray<SmPolyEdge*> edges;
            require(triangle->GetNonDegeneratePolyEdges(edges)==SM_SUCCESS && edges.GetSize()==3,
                "three nondegenerate edges");
            std::array<unsigned,3> ids{};
            for (unsigned i=0; i<3; ++i) {
                const auto p=edges[i]->GetStartPoint(); unsigned id=0;
                while (id<4 && !(p.x==points[id].x && p.y==points[id].y && p.z==points[id].z)) ++id;
                require(id<4,"coordinates preserved exactly"); ids[i]=id;
            }
            for (unsigned i=0; i<3; ++i) {
                unsigned a=ids[i],b=ids[(i+1)%3]; const int sign=a<b ? 1 : -1;
                if (a>b) std::swap(a,b);
                auto& count=incidences[{a,b}]; ++count.first; count.second+=sign;
            }
        }
        require(incidences.size()==5,"four boundary edges and one diagonal");
        for (const auto& [edge,count] : incidences) {
            const bool diagonal=edge==std::make_pair(diagonal_a,diagonal_b);
            require(count.first==(diagonal ? 2 : 1),"expected internal diagonal only");
            require(diagonal ? count.second==0 : std::abs(count.second)==1,"consistent winding");
        }
    }
}
}

void run_triangulate_tests() {
    SmBrep* raw=nullptr;
    require(SmApiCreateBox(SmVector3d(0,0,0),1,1,1,raw)==SM_SUCCESS && raw,"SDK context");
    std::unique_ptr<SmBrep> box(raw);
    // Hand arithmetic: |A-C|²=6, |B-D|²=5. The shorter B-D is interior.
    verify(*box->GetContext(),{{{0,0,0},{2,0,0},{2,1,1},{0,1,0}}},1,3);
    // Concave A: |A-C|²=9.8², |B-D|²=4. B-D is outside the polygon;
    // the SDK must retain A-C despite its greater length.
    verify(*box->GetContext(),{{{0.2,0,0},{0,-1,0},{10,0,0},{0,1,0}}},0,2);
    // Minimal four-vertex reproducer extracted from f-a-curved #55's r=10.3
    // cap. The two diagonals differ in squared length by about 0.00222;
    // aspect-ratio ranking nevertheless flipped across native and WASM.
    std::array<SmPoint3d,4> cap{{
        {7.283199846221441,7.283199846221437,0},
        {7.365003019077327,7.20046738267606,-8.81802933255916e-16},
        {7.371412502696168,7.193905595369916,3.000000000000009},
        {7.283199846221442,7.283199846221437,3}}};
    verify(*box->GetContext(),cap,1,3);
    cap[2].y=std::nextafter(cap[2].y,8.0);
    verify(*box->GetContext(),cap,1,3);
}
