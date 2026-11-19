// SPDX-License-Identifier: MPL-2.0
// The SDK enumerates the same solid differently between runs (heap-address
// order). Every enumeration of one mesh must canonicalize to the same bytes.
#include "mesh_canonical.hpp"
#include "mesh.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <map>
#include <numeric>
#include <random>
#include <set>
#include <vector>

namespace {
using Point=std::array<double,3>;
void require(bool value,const char* message) {
    if (!value) { std::fprintf(stderr,"mesh canonical FAIL: %s\n",message); std::exit(1); }
}
struct Quad { uint32_t face; std::array<uint32_t,4> loop; };
void canonicalize(AdapterMesh& mesh,const std::vector<bool>& planar) {
    order_mesh(mesh); canonical_planar_quads(mesh,planar); order_mesh(mesh);
}
// Build `quads` with a shuffled vertex numbering, quad order, loop start and
// diagonal. Same geometry and source faces each time.
AdapterMesh enumerate(const std::vector<Point>& points,const std::vector<Quad>& quads,std::mt19937& random) {
    std::vector<uint32_t> ids(points.size()); std::iota(ids.begin(),ids.end(),0u);
    std::shuffle(ids.begin(),ids.end(),random);
    AdapterMesh mesh; mesh.positions.resize(points.size()*3);
    for (size_t i=0;i<points.size();++i)
        for (unsigned axis=0;axis<3;++axis) mesh.positions[3*ids[i]+axis]=points[i][axis];
    std::vector<std::array<uint32_t,4>> triangles; // face, a, b, c
    for (const auto& quad:quads) {
        auto loop=quad.loop; std::rotate(loop.begin(),loop.begin()+random()%4,loop.end());
        triangles.push_back({quad.face,ids[loop[0]],ids[loop[1]],ids[loop[2]]});
        triangles.push_back({quad.face,ids[loop[0]],ids[loop[2]],ids[loop[3]]});
    }
    std::shuffle(triangles.begin(),triangles.end(),random);
    for (auto& t:triangles) {
        std::array<uint32_t,3> corners{t[1],t[2],t[3]};
        std::rotate(corners.begin(),corners.begin()+random()%3,corners.end());
        mesh.indices.insert(mesh.indices.end(),corners.begin(),corners.end());
        mesh.faces.push_back(t[0]);
    }
    mesh.normals.assign(mesh.indices.size()*3,0.);
    return mesh;
}
std::multiset<Point> vertex_set(const AdapterMesh& mesh) {
    std::multiset<Point> result;
    for (size_t i=0;i<mesh.positions.size();i+=3)
        result.insert({mesh.positions[i],mesh.positions[i+1],mesh.positions[i+2]});
    return result;
}
std::map<uint32_t,double> face_areas(const AdapterMesh& mesh) {
    std::map<uint32_t,double> result;
    for (size_t t=0;t<mesh.faces.size();++t) {
        Point p[3];
        for (unsigned k=0;k<3;++k) for (unsigned axis=0;axis<3;++axis)
            p[k][axis]=mesh.positions[3*mesh.indices[3*t+k]+axis];
        const double ux=p[1][0]-p[0][0],uy=p[1][1]-p[0][1],uz=p[1][2]-p[0][2];
        const double vx=p[2][0]-p[0][0],vy=p[2][1]-p[0][1],vz=p[2][2]-p[0][2];
        result[mesh.faces[t]]+=std::hypot(uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx)/2;
    }
    return result;
}
bool has_edge(const AdapterMesh& mesh,const Point& a,const Point& b) {
    auto at=[&](uint32_t v) { return Point{mesh.positions[3*v],mesh.positions[3*v+1],mesh.positions[3*v+2]}; };
    for (size_t i=0;i<mesh.indices.size();i+=3) for (unsigned k=0;k<3;++k) {
        const auto x=at(mesh.indices[i+k]),y=at(mesh.indices[i+(k+1)%3]);
        if ((x==a && y==b) || (x==b && y==a)) return true;
    }
    return false;
}
void same_bytes(const AdapterMesh& a,const AdapterMesh& b,const char* message) {
    require(a.positions==b.positions && a.indices==b.indices && a.faces==b.faces && a.normals==b.normals,message);
}
}

void run_mesh_canonical_tests() {
    std::mt19937 random(7955);
    // Unit cube with outward loops; every face planar.
    std::vector<Point> cube;
    for (unsigned i=0;i<8;++i) cube.push_back({double(i&1),double(i>>1&1),double(i>>2&1)});
    const std::vector<Quad> faces{{0,{0,2,3,1}},{1,{4,5,7,6}},{2,{0,1,5,4}},
        {3,{2,6,7,3}},{4,{0,4,6,2}},{5,{1,3,7,5}}};
    const std::vector<bool> planar(6,true);
    AdapterMesh reference=enumerate(cube,faces,random); canonicalize(reference,planar);
    const auto areas=face_areas(reference);
    for (const auto& area:areas) require(std::abs(area.second-1)<1e-15,"each cube face keeps unit area");
    for (unsigned run=0;run<64;++run) {
        AdapterMesh mesh=enumerate(cube,faces,random);
        const auto vertices=vertex_set(mesh); auto histogram=mesh.faces; std::sort(histogram.begin(),histogram.end());
        canonicalize(mesh,planar);
        same_bytes(mesh,reference,"every enumeration of one cube has one canonical form");
        require(vertex_set(mesh)==vertices,"vertex multiset unchanged");
        require(mesh.faces==histogram,"triangles per source face unchanged, grouped by face");
        require(face_areas(mesh)==areas,"per-face area unchanged");
        for (size_t t=0;t<mesh.faces.size();++t) {
            require(mesh.indices[3*t]<mesh.indices[3*t+1] && mesh.indices[3*t]<mesh.indices[3*t+2],
                "triangle starts at its smallest vertex");
            require(t==0 || std::make_pair(mesh.faces[t-1],std::array<uint32_t,3>{mesh.indices[3*t-3],mesh.indices[3*t-2],mesh.indices[3*t-1]})
                < std::make_pair(mesh.faces[t],std::array<uint32_t,3>{mesh.indices[3*t],mesh.indices[3*t+1],mesh.indices[3*t+2]}),
                "triangles sorted by (face, v0, v1, v2)");
        }
        AdapterMesh again=mesh; canonicalize(again,planar); same_bytes(again,mesh,"canonicalization idempotent");
    }
    // Documented diagonal: through each face's lowest vertex in (x, y, z) order.
    require(has_edge(reference,{0,0,0},{1,1,0}) && has_edge(reference,{0,0,0},{0,1,1}) &&
        has_edge(reference,{0,0,0},{1,0,1}) && has_edge(reference,{0,0,1},{1,1,1}) &&
        has_edge(reference,{0,1,0},{1,1,1}) && has_edge(reference,{1,0,0},{1,1,1}),
        "planar quad split through its lowest vertex");
    for (size_t i=0;i<reference.positions.size();i+=3) {
        const Point p{reference.positions[i],reference.positions[i+1],reference.positions[i+2]};
        require(i==0 || Point{reference.positions[i-3],reference.positions[i-2],reference.positions[i-1]}<p,
            "vertices in (x, y, z) order");
    }
    // Non-planar faces keep whichever diagonal the SDK chose.
    {
        AdapterMesh mesh=enumerate(cube,faces,random);
        AdapterMesh flipped=mesh; const std::vector<bool> curved(6,false);
        canonicalize(flipped,curved); auto original=mesh; order_mesh(original);
        same_bytes(flipped,original,"no diagonal change on non-planar source faces");
    }
    // Concave planar quad (dent at (2,1)): only the diagonal through the dent
    // is inside it, even though the lowest vertex is (0,0).
    {
        const std::vector<Point> dart{{0,0,0},{2,1,0},{4,0,0},{2,3,0}};
        AdapterMesh mesh; for (const auto& p:dart) mesh.positions.insert(mesh.positions.end(),p.begin(),p.end());
        mesh.indices={1,2,3,1,3,0}; mesh.faces={0,0}; mesh.normals.assign(18,0.);
        canonicalize(mesh,{true});
        require(has_edge(mesh,{2,1,0},{2,3,0}) && !has_edge(mesh,{0,0,0},{4,0,0}),"concave quad keeps its valid diagonal");
        require(face_areas(mesh).at(0)==4,"concave quad area unchanged");
    }
    // Coincident vertices: tie broken by their incident corners, not numbering.
    {
        const std::vector<Point> points{{0,0,0},{1,0,0},{0,1,0},{0,0,0},{0,0,1},{1,0,1}};
        AdapterMesh first; for (const auto& p:points) first.positions.insert(first.positions.end(),p.begin(),p.end());
        first.indices={0,1,2,3,4,5}; first.faces={0,1}; first.normals.assign(18,0.);
        AdapterMesh second=first; // swap the coincident vertices 0 and 3
        second.indices={3,1,2,0,4,5};
        canonicalize(first,{true,true}); canonicalize(second,{true,true});
        same_bytes(first,second,"coincident vertices ordered by their incident corners");
    }
    // -0 sorts before +0, so signed zeros never tie.
    {
        AdapterMesh a; a.positions={0.,0,0,1,0,0,0,1,0,-0.,0,1,1,0,1,0,1,1};
        a.indices={0,1,2,3,4,5}; a.faces={0,1}; a.normals.assign(18,0.);
        order_mesh(a); require(std::signbit(a.positions[0]) && a.positions[2]==1,"-0 sorts before +0");
    }
}
