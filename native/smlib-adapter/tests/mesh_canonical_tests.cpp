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
#include <cstring>
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
    order_mesh(mesh); canonical_planar_faces(mesh,planar); order_mesh(mesh);
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
// Byte comparison: operator== on doubles would accept -0 for +0.
bool bytes(const std::vector<double>& a,const std::vector<double>& b) {
    return a.size()==b.size() && (a.empty() || std::memcmp(a.data(),b.data(),a.size()*sizeof(double))==0);
}
void same_bytes(const AdapterMesh& a,const AdapterMesh& b,const char* message) {
    require(bytes(a.positions,b.positions) && a.indices==b.indices && a.faces==b.faces && bytes(a.normals,b.normals),message);
}
// One planar face (z = 0, face 0) given as a valid triangulation; `flips`
// random convex flips give another valid triangulation of the same region,
// then the vertex numbering, triangle order and corner rotation are shuffled.
using Tri=std::array<uint32_t,3>;
double orient(const std::vector<Point>& p,uint32_t a,uint32_t b,uint32_t c) {
    return (p[b][0]-p[a][0])*(p[c][1]-p[a][1])-(p[b][1]-p[a][1])*(p[c][0]-p[a][0]);
}
AdapterMesh variant(const std::vector<Point>& points,std::vector<Tri> triangles,unsigned flips,std::mt19937& random,
    const std::vector<Point>* flat=nullptr) {
    const auto& plane=flat ? *flat : points;
    for (unsigned f=0;f<flips;++f) {
        const size_t x=random()%triangles.size(),y=random()%triangles.size();
        if (x==y) continue;
        const Tri a=triangles[x],b=triangles[y];
        for (unsigned i=0;i<3;++i) for (unsigned j=0;j<3;++j) {
            if (!(b[j]==a[(i+1)%3] && b[(j+1)%3]==a[i])) continue;
            const uint32_t u=a[i],v=a[(i+1)%3],p=a[(i+2)%3],q=b[(j+2)%3];
            if (orient(plane,p,u,q)>0 && orient(plane,q,v,p)>0) { triangles[x]={p,u,q}; triangles[y]={q,v,p}; }
            i=3; break;
        }
    }
    std::vector<uint32_t> ids(points.size()); std::iota(ids.begin(),ids.end(),0u);
    std::shuffle(ids.begin(),ids.end(),random);
    std::shuffle(triangles.begin(),triangles.end(),random);
    AdapterMesh mesh; mesh.positions.resize(points.size()*3);
    for (size_t i=0;i<points.size();++i) for (unsigned axis=0;axis<3;++axis) mesh.positions[3*ids[i]+axis]=points[i][axis];
    for (const auto& t:triangles) {
        Tri c{ids[t[0]],ids[t[1]],ids[t[2]]}; std::rotate(c.begin(),c.begin()+random()%3,c.end());
        mesh.indices.insert(mesh.indices.end(),c.begin(),c.end()); mesh.faces.push_back(0);
    }
    mesh.normals.assign(mesh.indices.size()*3,0.);
    return mesh;
}
void planar_face_is_canonical(const std::vector<Point>& points,const std::vector<Tri>& triangles,
    std::mt19937& random,const char* name,const std::vector<Point>* flat=nullptr,unsigned runs=48) {
    AdapterMesh reference=variant(points,triangles,0,random,flat);
    const auto vertices=vertex_set(reference); const double area=face_areas(reference).at(0);
    canonicalize(reference,{true});
    require(reference.indices.size()==3*triangles.size() && vertex_set(reference)==vertices,name);
    require(std::abs(face_areas(reference).at(0)-area)<=1e-12*area,name);
    for (unsigned run=0;run<runs;++run) {
        AdapterMesh mesh=variant(points,triangles,run,random,flat);
        canonicalize(mesh,{true});
        same_bytes(mesh,reference,name);
    }
}
// An n x m grid of `spacing` cells, minus `holes`, each cell split along a
// random diagonal, mapped into 3D by `place`. Returns the 3D points, the flat
// grid coordinates (for flips) and the triangles.
template<class Place>
void grid(unsigned n,unsigned m,const std::set<std::pair<unsigned,unsigned>>& holes,Place place,std::mt19937& random,
    std::vector<Point>& points,std::vector<Point>& flat,std::vector<Tri>& triangles) {
    std::vector<int> id((n+1)*(m+1),-1);
    auto vertex=[&](unsigned i,unsigned j) {
        int& v=id[j*(n+1)+i];
        if (v<0) { v=int(points.size()); flat.push_back({double(i),double(j),0}); points.push_back(place(double(i),double(j))); }
        return uint32_t(v);
    };
    for (unsigned j=0;j<m;++j) for (unsigned i=0;i<n;++i) {
        if (holes.count({i,j})) continue;
        const uint32_t a=vertex(i,j),b=vertex(i+1,j),c=vertex(i+1,j+1),d=vertex(i,j+1);
        if (random()%2) { triangles.push_back({a,b,c}); triangles.push_back({a,c,d}); }
        else { triangles.push_back({a,b,d}); triangles.push_back({b,c,d}); }
    }
}
// A face the retriangulation must decline: canonicalized it is exactly the
// SDK's split in canonical order.
void declined(AdapterMesh mesh,const std::vector<bool>& planar,const char* name) {
    AdapterMesh ordered=mesh; order_mesh(ordered); order_mesh(ordered);
    canonicalize(mesh,planar);
    same_bytes(mesh,ordered,name);
}
// The SDK's values differ between runs by about one ULP. Canonical topology
// (indices and source faces after canonicalization) must not.
void nudge(AdapterMesh& mesh,std::mt19937& random) {
    for (double& x:mesh.positions) {
        const unsigned r=random()%3;
        if (r==1) x=std::nextafter(x,INFINITY); else if (r==2) x=std::nextafter(x,-INFINITY);
    }
}
void same_topology(const AdapterMesh& a,const AdapterMesh& b,const char* message) {
    require(a.indices==b.indices && a.faces==b.faces,message);
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
    // A face tagged planar can have warped vertices. Its projected diagonal
    // is valid, but changing the split can change its 3D surface area (#10916).
    {
        AdapterMesh mesh;
        mesh.positions={0,0,0, 1,0,0, .6,1e-8,2.5e-9, 0,1e-8,0, .3,0,-1};
        mesh.indices={0,1,3, 1,2,3, 1,0,4, 2,1,4, 3,2,4, 0,3,4};
        mesh.faces={0,0,1,2,3,4};
        mesh.normals.assign(mesh.indices.size()*3,0.);
        order_mesh(mesh);
        const double area=face_areas(mesh).at(0);
        const auto counts=canonical_planar_faces_or_keep(mesh,{true,false,false,false,false});
        require(counts.boundary==0 && counts.spine==0,"the warped cap remains manifold");
        require(std::abs(face_areas(mesh).at(0)-area)<=1e-9*area,
            "a warped quad tagged planar keeps its original 3D area");
    }
    // Review case (#10916): a 1 um wide quad tagged planar at a 2.6e6 m
    // offset with one corner 0.25 um out of plane. The canonical rule prefers
    // the other diagonal than the SDK's, which would change its area by
    // 1.17%: far above the noise floor, so the SDK's split stays.
    {
        const double x=2.6e6,y=8.6e5,z=3,w=1e-6;
        AdapterMesh mesh;
        mesh.positions={x,y,z, x+1,y,z, x+0.6,y+w,z+0.25e-6, x,y+w,z};
        mesh.indices={0,1,3, 1,2,3};
        mesh.faces={0,0};
        mesh.normals.assign(mesh.indices.size()*3,0.);
        order_mesh(mesh);
        const double area=face_areas(mesh).at(0);
        canonicalize(mesh,{true});
        require(std::abs(face_areas(mesh).at(0)-area)<=1e-9*area,
            "a warped thin quad at a 2.6e6 m offset keeps its 3D area");
    }
    // The area check itself must not react to the SDK's +/-1 ULP noise: a
    // near-collinear quad at a 1e6 m offset (found by fuzzing) whose split
    // changed area by noise alone flipped between runs with a purely
    // relative 1e-9 tolerance.
    {
        AdapterMesh base;
        base.positions={1000000,500000,3, 1000000.01,499999.99073807587,3.0013894433416275,
            1000000.0124370087,500000.00242414844,3.0017280518869596,
            1000000.0075259981,500000.00146692322,3.0010456947939192};
        base.indices={0,2,3, 0,1,2};
        base.faces={0,0};
        base.normals.assign(base.indices.size()*3,0.);
        AdapterMesh reference=base; canonicalize(reference,{true});
        for (unsigned run=0;run<64;++run) {
            AdapterMesh mesh=base; nudge(mesh,random); canonicalize(mesh,{true});
            same_topology(mesh,reference,"near-collinear quad at 1e6 m keeps its split under +/-1 ULP noise");
        }
    }
    // Saddle review case (#10916): lifting two opposite corners of a quad by w
    // changes its 3D area only by about A (w/L)^2, below same_area's 1e-9, but
    // re-splitting it moves A w / 3 of volume and tilts both normals by about
    // w / L. A parallelogram tagged planar, split by the SDK on its long
    // diagonal (the canonical rule prefers the short one), must keep that
    // split. Before the hinge check, the 10 m quad was re-split up to
    // w = 1e-4 m and the 1 m quad up to w = 1e-5 m.
    for (const auto& [length,lift]:std::vector<std::pair<double,double>>{{10,1e-4},{10,1e-6},{1,1e-5},{1,1e-7}}) {
        const double s=length/2;
        AdapterMesh mesh;
        mesh.positions={0,0,0, length,0,lift, length+s,length,0, s,length,lift};
        mesh.indices={0,1,2, 0,2,3}; mesh.faces={0,0}; mesh.normals.assign(18,0.);
        declined(mesh,{true},"a saddle-warped quad tagged planar keeps the SDK's split");
        // The same quad truly planar is re-split onto its short diagonal.
        mesh.positions[5]=mesh.positions[11]=0;
        canonicalize(mesh,{true});
        require(has_edge(mesh,{length,0,0},{s,length,0}),"the planar parallelogram takes its short diagonal");
    }
    // The same on a face of more than two triangles (the greedy path): a 10 x
    // 4 m rectangle with an edge vertex, split by the SDK on a long diagonal,
    // one corner lifted by 10 um.
    {
        AdapterMesh mesh;
        mesh.positions={0,0,0, 5,0,0, 10,0,0, 10,4,1e-5, 0,4,0};
        mesh.indices={0,1,4, 1,2,4, 2,3,4}; mesh.faces={0,0,0}; mesh.normals.assign(27,0.);
        declined(mesh,{true},"a warped face of three triangles tagged planar keeps the SDK's split");
        mesh.positions[11]=0;
        canonicalize(mesh,{true});
        require(!has_edge(mesh,{10,0,0},{0,4,0}),"the planar rectangle with an edge vertex is re-split");
    }
    // A truly planar quad in a general orientation at a 1e6 m offset, under
    // the SDK's +/-1 ULP noise: the hinge check must not decline it, so both
    // SDK splits keep canonicalizing to one topology.
    {
        const Point origin{1e6,-4e5,2.5e5},u{0.48,0.6,0.64},v{0.8,-0.36,-0.48};
        const double corners[4][2]={{0,0},{7,0},{10.5,3},{3.5,3}};
        AdapterMesh base;
        for (const auto& c:corners) for (unsigned axis=0;axis<3;++axis)
            base.positions.push_back(origin[axis]+c[0]*u[axis]+c[1]*v[axis]);
        base.indices={0,1,2, 0,2,3}; base.faces={0,0}; base.normals.assign(18,0.);
        AdapterMesh reference=base; canonicalize(reference,{true});
        for (unsigned run=0;run<64;++run) {
            AdapterMesh mesh=base;
            if (run%2) mesh.indices={1,2,3, 1,3,0};
            nudge(mesh,random); canonicalize(mesh,{true});
            same_topology(mesh,reference,"a planar rotated quad at 1e6 m canonicalizes stably under +/-1 ULP noise");
        }
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
        // -0 and +0 share a grid key; with identical incident corners the
        // exact order breaks the tie: -0 first, whatever the input order.
        for (bool minus_first:{true,false}) {
            AdapterMesh a; a.positions={minus_first ? -0. : 0.,0,0, minus_first ? 0. : -0.,0,0, 1,0,0, 0,1,0};
            a.indices={0,2,3,1,2,3}; a.faces={0,0}; a.normals.assign(18,0.);
            order_mesh(a); require(std::signbit(a.positions[0]) && !std::signbit(a.positions[3]),"-0 sorts before +0 on a full tie");
        }
    }
    // Sliver: in doubles, the cross product from corner a rounds to exactly 0
    // (from b and c it is -4.77e-18, the exact orientation's sign). a is also
    // the lowest vertex, so it becomes the canonical first corner: a normal
    // from the first corner alone would refuse the triangle as degenerate.
    {
        const Point a{0.12926848008708913,0.44750716155345727,0.},b{0.49154698840753275,0.8401951656845025,0.},
            c{0.4859970667001983,0.8341793860335357,0.};
        for (const auto& t:{std::array<Point,3>{a,b,c},std::array<Point,3>{b,c,a},std::array<Point,3>{c,a,b}}) {
            Point n{}; require(flat_normal(t[0],t[1],t[2],n),"sliver is not degenerate from every corner");
            require(n[2]==-1 && n[0]==0 && n[1]==0,"sliver normal follows the exact orientation from any first corner");
        }
        std::vector<AdapterMesh> meshes;
        for (unsigned start=0;start<3;++start) {
            AdapterMesh mesh; for (const auto& p:{a,b,c}) mesh.positions.insert(mesh.positions.end(),p.begin(),p.end());
            mesh.indices={start,(start+1)%3,(start+2)%3}; mesh.faces={0}; mesh.normals.assign(9,0.);
            order_mesh(mesh); meshes.push_back(mesh);
        }
        require(meshes[0].normals[2]==-1,"canonical sliver keeps its exact orientation");
        same_bytes(meshes[1],meshes[0],"sliver canonical from any input corner");
        same_bytes(meshes[2],meshes[0],"sliver canonical from any input corner");
    }
    // A planar quad is not re-split onto a diagonal that is already a mesh edge.
    {
        const std::vector<Point> points{{1,0,0},{1,1,0},{0,1,0},{0,0,0},{.5,.5,1}}; // B C D A E
        auto quad=[&](bool shared) {
            AdapterMesh mesh; for (const auto& p:points) mesh.positions.insert(mesh.positions.end(),p.begin(),p.end());
            mesh.indices={0,1,2,2,3,0}; mesh.faces={0,0}; // split along B-D, not through A
            if (shared) { mesh.indices.insert(mesh.indices.end(),{3,1,4}); mesh.faces.push_back(1); } // uses A-C
            mesh.normals.assign(mesh.indices.size()*3,0.);
            canonicalize(mesh,{true,false});
            return mesh;
        };
        require(has_edge(quad(false),{0,0,0},{1,1,0}),"free quad split through its lowest vertex");
        const auto kept=quad(true);
        require(has_edge(kept,{1,0,0},{0,1,0}) && face_areas(kept).at(0)==1,"existing edge blocks the new diagonal");
    }
    // Planar faces of more than two triangles: every triangulation of one
    // region (holes, reflex corners, interior vertices) has one canonical form.
    {
        // Square with a square hole (a wall with a window).
        const std::vector<Point> ring{{0,0,0},{4,0,0},{4,4,0},{0,4,0},{1,1,0},{3,1,0},{3,3,0},{1,3,0}};
        const std::vector<Tri> around{{0,1,5},{0,5,4},{1,2,6},{1,6,5},{2,3,7},{2,7,6},{3,0,4},{3,4,7}};
        planar_face_is_canonical(ring,around,random,"face with a hole has one canonical triangulation");
        AdapterMesh mesh=variant(ring,around,9,random); canonicalize(mesh,{true});
        for (size_t t=0;t<mesh.faces.size();++t) {
            double x=0,y=0; for (unsigned k=0;k<3;++k) { x+=mesh.positions[3*mesh.indices[3*t+k]]/3; y+=mesh.positions[3*mesh.indices[3*t+k]+1]/3; }
            require(!(x>1 && x<3 && y>1 && y<3),"no triangle covers the hole");
        }
        // Convex hexagon, initially a fan.
        std::vector<Point> hexagon;
        for (unsigned i=0;i<6;++i) hexagon.push_back({std::cos(i*1.0471975511965976),std::sin(i*1.0471975511965976)*0.7,0});
        planar_face_is_canonical(hexagon,{{0,1,2},{0,2,3},{0,3,4},{0,4,5}},random,"hexagon has one canonical triangulation");
        // L shape (one reflex corner), initially a fan from its corner.
        const std::vector<Point> l{{0,0,0},{2,0,0},{2,1,0},{1,1,0},{1,2,0},{0,2,0}};
        planar_face_is_canonical(l,{{0,1,2},{0,2,3},{0,3,4},{0,4,5}},random,"L shape has one canonical triangulation");
        // A square with an interior vertex and a vertex on one edge.
        const std::vector<Point> inner{{0,0,0},{2,0,0},{2,2,0},{0,2,0},{.7,.9,0},{1,0,0}};
        planar_face_is_canonical(inner,{{0,5,4},{5,1,4},{1,2,4},{2,3,4},{3,0,4}},random,"interior and edge vertices canonical");
    }
    // Rotated, offset grids with holes in arbitrary planes: near-collinear
    // vertices once made the double predicates disagree, the face fell back
    // to the SDK split and every enumeration gave different bytes.
    {
        const double c30=std::cos(0.5235987755982988),s30=std::sin(0.5235987755982988);
        std::vector<Point> points,flat; std::vector<Tri> triangles;
        grid(6,6,{{2,2},{2,3},{3,2},{3,3}},[&](double i,double j) {
            return Point{12+0.6*(c30*i-s30*j),12+0.6*(s30*i+c30*j),3}; },random,points,flat,triangles);
        planar_face_is_canonical(points,triangles,random,"rotated offset grid with a hole is canonical",&flat,41);
        // Property: random rotations, offsets up to 3e6 m, spacings and planes.
        std::uniform_real_distribution<double> unit(0,1);
        for (unsigned trial=0;trial<60;++trial) {
            const double angle=1.57*unit(random),offset=std::pow(10.,6.5*unit(random)),spacing=0.01+1.5*unit(random);
            const unsigned n=3+random()%6,m=3+random()%6,plane=random()%4;
            std::set<std::pair<unsigned,unsigned>> holes;
            for (unsigned h=random()%4;h>0;--h) holes.insert({1+random()%(n-2),1+random()%(m-2)});
            const double c=std::cos(angle),s=std::sin(angle);
            std::vector<Point> p3,p2; std::vector<Tri> t;
            grid(n,m,holes,[&](double i,double j) {
                const double u=offset+spacing*(c*i-s*j),v=offset/2+spacing*(s*i+c*j);
                switch (plane) {
                case 0: return Point{u,v,3.};
                case 1: return Point{u,7.,v};
                case 2: return Point{1.5,u,v};
                default: return Point{u,v,0.3*u+0.7*v}; // tilted
                } },random,p3,p2,t);
            planar_face_is_canonical(p3,t,random,"random rotated/offset/tilted grid is canonical",&p2,8);
        }
    }
    // Declined faces keep the SDK's split (in canonical order).
    {
        // More than 256 vertices: a 140-segment curved wall top (282 vertices).
        std::vector<Point> points; std::vector<Tri> triangles;
        for (unsigned i=0;i<=140;++i) for (double r:{5.0,5.3}) points.push_back({r*std::cos(1.2*i/140),r*std::sin(1.2*i/140),3});
        for (uint32_t i=0;i<140;++i) { triangles.push_back({2*i,2*i+2,2*i+3}); triangles.push_back({2*i,2*i+3,2*i+1}); }
        declined(variant(points,triangles,0,random),{true},"face over 256 vertices is left as split");
        // A non-manifold face: three triangles on one edge.
        AdapterMesh book; book.positions={0,0,0,1,0,0,.5,1,0,.5,-1,0,.5,2,0};
        book.indices={0,1,2,1,0,3,0,1,4}; book.faces={0,0,0}; book.normals.assign(27,0.);
        declined(book,{true},"non-manifold face is left as split");
    }
    // A diagonal that another face already has is not created, also on a face
    // of more than two triangles, and the result is still canonical.
    {
        std::vector<Point> hexagon;
        for (unsigned i=0;i<6;++i) hexagon.push_back({std::cos(i*1.0471975511965976),std::sin(i*1.0471975511965976)*0.7,0});
        const std::vector<Tri> fan{{0,1,2},{0,2,3},{0,3,4},{0,4,5}};
        AdapterMesh alone=variant(hexagon,fan,0,random); canonicalize(alone,{true});
        // Pick a diagonal of the canonical result and give it to face 1.
        Point a{},b{};
        for (size_t t=0;t<alone.faces.size() && a==b;++t) for (unsigned k=0;k<3;++k) {
            const uint32_t x=alone.indices[3*t+k],y=alone.indices[3*t+(k+1)%3];
            const bool ring=(std::max(x,y)-std::min(x,y))%6==1 || (std::max(x,y)-std::min(x,y))==5;
            (void)ring;
            Point px{alone.positions[3*x],alone.positions[3*x+1],alone.positions[3*x+2]},py{alone.positions[3*y],alone.positions[3*y+1],alone.positions[3*y+2]};
            bool boundary=false;
            for (unsigned i=0;i<6;++i) if ((px==hexagon[i] && py==hexagon[(i+1)%6]) || (py==hexagon[i] && px==hexagon[(i+1)%6])) boundary=true;
            if (!boundary) { a=px; b=py; break; }
        }
        require(!(a==b),"hexagon has an interior diagonal");
        std::vector<AdapterMesh> results;
        for (unsigned run=0;run<16;++run) {
            AdapterMesh mesh=variant(hexagon,fan,run,random);
            const auto base=uint32_t(mesh.positions.size()/3);
            mesh.positions.insert(mesh.positions.end(),{0,0,1});
            auto find=[&](const Point& p) { for (uint32_t v=0;v<base;++v) if (Point{mesh.positions[3*v],mesh.positions[3*v+1],mesh.positions[3*v+2]}==p) return v; return 0u; };
            mesh.indices.insert(mesh.indices.end(),{find(a),find(b),base}); mesh.faces.push_back(1);
            mesh.normals.assign(mesh.indices.size()*3,0.);
            canonicalize(mesh,{true,false}); results.push_back(mesh);
            for (size_t t=0;t<mesh.faces.size();++t) if (mesh.faces[t]==0) for (unsigned k=0;k<3;++k) {
                const uint32_t x=mesh.indices[3*t+k],y=mesh.indices[3*t+(k+1)%3];
                const Point px{mesh.positions[3*x],mesh.positions[3*x+1],mesh.positions[3*x+2]},py{mesh.positions[3*y],mesh.positions[3*y+1],mesh.positions[3*y+2]};
                require(!((px==a && py==b) || (px==b && py==a)),"face 0 does not reuse face 1's edge");
            }
        }
        for (const auto& mesh:results) same_bytes(mesh,results[0],"foreign-edge exception is canonical");
    }
    // Back-to-back coplanar faces over one region (degenerate geometry): the
    // first face never sees the other's not-yet-replaced split, the second
    // avoids the first's new diagonals, so both are canonical.
    {
        const std::vector<Point> points{{0,0,0},{1,0,0},{2,0,0},{0,1,0},{1,1,0},{2,1,0},{0,2,0},{1,2,0},{2,2,0}};
        auto split=[&](uint32_t a,uint32_t b,uint32_t c,uint32_t d,bool flip,bool reverse,std::vector<Tri>& out) {
            Tri x=flip ? Tri{a,b,c} : Tri{a,b,d}, y=flip ? Tri{a,c,d} : Tri{b,c,d};
            if (reverse) { std::swap(x[1],x[2]); std::swap(y[1],y[2]); }
            out.push_back(x); out.push_back(y);
        };
        std::vector<AdapterMesh> results;
        for (unsigned run=0;run<40;++run) {
            std::vector<Tri> front,back;
            for (uint32_t j=0;j<2;++j) for (uint32_t i=0;i<2;++i) {
                const uint32_t a=3*j+i,b=a+1,c=a+4,d=a+3;
                split(a,b,c,d,random()%2,false,front); split(a,b,c,d,random()%2,true,back);
            }
            std::vector<uint32_t> ids(points.size()); std::iota(ids.begin(),ids.end(),0u); std::shuffle(ids.begin(),ids.end(),random);
            AdapterMesh mesh; mesh.positions.resize(points.size()*3);
            for (size_t v=0;v<points.size();++v) for (unsigned axis=0;axis<3;++axis) mesh.positions[3*ids[v]+axis]=points[v][axis];
            std::vector<std::pair<uint32_t,Tri>> all;
            for (const auto& t:front) all.push_back({0,t});
            for (const auto& t:back) all.push_back({1,t});
            std::shuffle(all.begin(),all.end(),random);
            for (const auto& [face,t]:all) { mesh.indices.insert(mesh.indices.end(),{ids[t[0]],ids[t[1]],ids[t[2]]}); mesh.faces.push_back(face); }
            mesh.normals.assign(mesh.indices.size()*3,0.);
            canonicalize(mesh,{true,true}); results.push_back(mesh);
        }
        for (const auto& mesh:results) same_bytes(mesh,results[0],"back-to-back coplanar faces are canonical");
    }
    // +/-1 ULP noise on every coordinate leaves the canonical topology alone.
    {
        // AC20-FZK-Haus #21966: a slab whose corner came back as 4.195 or as
        // 4.195000000000001 (other vertices share x = 4.195 exactly).
        const std::vector<Point> slab{{-0.3,0,0},{4.195,0,0},{-0.3,0.3,0},{4.195,0.3,0},
            {-0.3,0,2.01},{4.195,0,2.01},{-0.3,0.3,2.01},{4.195,0.3,2.01}};
        const std::vector<Quad> sides{{0,{0,2,3,1}},{1,{4,5,7,6}},{2,{0,1,5,4}},
            {3,{2,6,7,3}},{4,{0,4,6,2}},{5,{1,3,7,5}}};
        AdapterMesh reference=enumerate(slab,sides,random); canonicalize(reference,planar);
        for (double x:{std::nextafter(4.195,INFINITY),std::nextafter(4.195,-INFINITY)}) {
            auto moved=slab; moved[1][0]=x;
            AdapterMesh mesh=enumerate(moved,sides,random); canonicalize(mesh,planar);
            same_topology(mesh,reference,"#21966 corner +/-1 ULP keeps the canonical topology");
        }
        for (unsigned run=0;run<64;++run) {
            AdapterMesh mesh=enumerate(slab,sides,random); nudge(mesh,random); canonicalize(mesh,planar);
            same_topology(mesh,reference,"slab with +/-1 ULP noise keeps the canonical topology");
        }
        // Rectangles: two exactly equal diagonals, axis-aligned and rotated.
        std::uniform_real_distribution<double> unit(0,1);
        for (unsigned trial=0;trial<40;++trial) {
            const double angle=trial%2 ? 6.283185307179586*unit(random) : 0,c=std::cos(angle),s=std::sin(angle);
            const double w=0.1+5*unit(random),d=0.1+5*unit(random),x0=1e4*unit(random),y0=1e4*unit(random);
            std::vector<Point> corners;
            for (const auto& [i,j]:std::array<std::pair<double,double>,4>{{{0,0},{w,0},{w,d},{0,d}}})
                corners.push_back({x0+c*i-s*j,y0+s*i+c*j,3});
            const std::vector<Quad> quad{{0,{0,1,2,3}}};
            AdapterMesh base=enumerate(corners,quad,random); canonicalize(base,{true});
            for (unsigned run=0;run<16;++run) {
                AdapterMesh mesh=enumerate(corners,quad,random); nudge(mesh,random); canonicalize(mesh,{true});
                same_topology(mesh,base,"rectangle with +/-1 ULP noise keeps its diagonal");
            }
        }
        // A rotated, offset grid with a hole (a planar face of many triangles).
        const double c30=std::cos(0.5235987755982988),s30=std::sin(0.5235987755982988);
        std::vector<Point> points,flat; std::vector<Tri> triangles;
        grid(6,6,{{2,2},{2,3},{3,2},{3,3}},[&](double i,double j) {
            return Point{12+0.6*(c30*i-s30*j),12+0.6*(s30*i+c30*j),3}; },random,points,flat,triangles);
        AdapterMesh base=variant(points,triangles,0,random,&flat); canonicalize(base,{true});
        for (unsigned run=0;run<32;++run) {
            AdapterMesh mesh=variant(points,triangles,run,random,&flat); nudge(mesh,random); canonicalize(mesh,{true});
            same_topology(mesh,base,"rotated grid with a hole and +/-1 ULP noise keeps its topology");
        }
    }
    // Thin planar faces: a 10 m x w rectangle, with w from 1e-9 m to 1e-4 m,
    // near the origin and at a 2.6e6 m offset, split by the SDK either way.
    // Every split gives one topology: the near rule's threshold is tied to the
    // noise, not to the grid step (when it was the step, both diagonals of a
    // face thinner than one step were rejected and the SDK split stayed), and
    // a face thinner than the threshold still gets its best valid diagonal.
    // Widths below the threshold (fractions of it) under +/-1 ULP noise: the
    // opposite corner projects within noise of a diagonal's endpoint, so the
    // near test must use the closed segment or one diagonal reads clear and
    // the other near at random.
    {
        for (double offset:{0.,1e3,2.6e6}) {
        AdapterMesh probe; probe.positions={offset,offset,0, offset+10,offset,0, offset,offset+10,5}; probe.indices={0,1,2}; probe.faces={0};
        const double threshold=std::ldexp(canonical_grid(probe),-8);
        for (double w:{1e-9,5e-9,2e-8,1e-6,2e-5,5e-5,1e-4,.05*threshold,.3*threshold,.6*threshold,.9*threshold}) {
            // Face 0 is the thin rectangle; face 1, a triangle, gives the mesh a 10 m extent.
            const std::vector<Point> points{{offset,offset,0},{offset+10,offset,0},{offset+10,offset+w,0},{offset,offset+w,0},
                {offset,offset,5},{offset+10,offset,5},{offset,offset+10,5}};
            std::vector<uint32_t> first;
            for (unsigned run=0;run<32;++run) {
                std::vector<std::pair<uint32_t,Tri>> triangles{{1,{4,5,6}}};
                if (run%2) { triangles.push_back({0,{0,1,2}}); triangles.push_back({0,{0,2,3}}); }
                else { triangles.push_back({0,{0,1,3}}); triangles.push_back({0,{1,2,3}}); }
                std::vector<uint32_t> ids(points.size()); std::iota(ids.begin(),ids.end(),0u); std::shuffle(ids.begin(),ids.end(),random);
                std::shuffle(triangles.begin(),triangles.end(),random);
                AdapterMesh mesh; mesh.positions.resize(3*points.size());
                for (size_t v=0;v<points.size();++v) for (unsigned axis=0;axis<3;++axis) mesh.positions[3*ids[v]+axis]=points[v][axis];
                for (auto [face,t]:triangles) {
                    std::rotate(t.begin(),t.begin()+random()%3,t.end());
                    mesh.indices.insert(mesh.indices.end(),{ids[t[0]],ids[t[1]],ids[t[2]]}); mesh.faces.push_back(face);
                }
                mesh.normals.assign(mesh.indices.size()*3,0.);
                // Noise only where it cannot collapse the input itself (w >= 64 ULP).
                if (w>=64*(std::nextafter(offset+10,INFINITY)-(offset+10))) nudge(mesh,random);
                canonicalize(mesh,{true,false});
                if (run==0) first=mesh.indices;
                require(mesh.indices==first,"thin rectangle has one canonical diagonal whatever the SDK split and noise");
            }
        }
        }
    }
    // The greedy's second pass: a thin pentagon (a 10 x w rectangle with a
    // vertex in the middle of a long side), w a quarter of the near threshold,
    // so every diagonal passes near a vertex. The first pass finds nothing;
    // without the second the face would keep each SDK triangulation.
    {
        for (double offset:{0.,2.6e6}) {
            AdapterMesh probe; probe.positions={offset,offset,0, offset+10,offset,0, offset,offset+10,0}; probe.indices={0,1,2}; probe.faces={0};
            const double w=std::ldexp(canonical_grid(probe),-10);
            const std::vector<Point> points{{offset,offset,0},{offset+5,offset,0},{offset+10,offset,0},{offset+10,offset+w,0},{offset,offset+w,0}};
            const std::vector<std::vector<Tri>> splits{{{0,1,4},{1,3,4},{1,2,3}},{{0,1,3},{0,3,4},{1,2,3}},{{0,1,4},{1,2,4},{2,3,4}}};
            std::vector<uint32_t> first;
            for (unsigned run=0;run<24;++run) {
                AdapterMesh mesh=variant(points,splits[run%3],0,random); nudge(mesh,random); canonicalize(mesh,{true});
                if (run==0) first=mesh.indices;
                require(mesh.indices==first,"thin face where every diagonal is near: one topology from the second pass");
            }
        }
    }
    // The near rule, greedy path: a 1 x 4 rectangle with a T-vertex on a short
    // side, rotated, in a random plane, offset up to 1e6 m, under +/-1 ULP noise.
    // Without the rule the diagonal along the short side (through the T-vertex,
    // off it only by the SDK's last bits) is valid or not run to run.
    {
        std::uniform_real_distribution<double> unit(0,1);
        for (unsigned trial=0;trial<200;++trial) {
            const double t=0.2+0.6*unit(random),angle=6.283185307179586*unit(random),c=std::cos(angle),s=std::sin(angle);
            const double offset=trial%2 ? std::pow(10.,1+5*unit(random)) : 0;
            const unsigned plane=random()%3;
            std::vector<Point> points;
            for (const auto& [x,y]:std::vector<std::pair<double,double>>{{0,0},{t,0},{1,0},{1,4},{0,4}}) {
                const double u=offset+c*x-s*y,v=offset/3+s*x+c*y;
                points.push_back(plane==0 ? Point{u,v,3} : plane==1 ? Point{u,3,v} : Point{3,u,v});
            }
            const std::vector<Tri> triangles{{0,1,4},{1,2,3},{1,3,4}};
            AdapterMesh base=variant(points,triangles,0,random); canonicalize(base,{true});
            for (unsigned run=0;run<24;++run) {
                AdapterMesh mesh=variant(points,triangles,0,random); nudge(mesh,random); canonicalize(mesh,{true});
                same_topology(mesh,base,"T-vertex on a short side with +/-1 ULP noise keeps its topology");
            }
        }
    }
    // The near rule, two-triangle path: a quad (u, q, v, p) whose vertex p is
    // the rounded midpoint of u-v. The diagonal u-v (length 2) outranks p-q
    // (length 3), but whether it passes inside p is the SDK's last bits.
    {
        std::uniform_real_distribution<double> unit(0,1);
        for (unsigned trial=0;trial<200;++trial) {
            const double angle=6.283185307179586*unit(random),c=std::cos(angle),s=std::sin(angle);
            const double offset=trial%2 ? std::pow(10.,1+5*unit(random)) : 0,scale=0.1+3*unit(random);
            const unsigned plane=random()%3;
            auto place=[&](double x,double y) {
                const double u=offset+scale*(c*x-s*y),v=offset/3+scale*(s*x+c*y);
                return plane==0 ? Point{u,v,3} : plane==1 ? Point{u,3,v} : Point{3,u,v};
            };
            const Point U=place(0,0),Q=place(1,-3),V=place(2,0);
            const Point P{(U[0]+V[0])/2,(U[1]+V[1])/2,(U[2]+V[2])/2};
            const std::vector<Point> points{U,Q,V,P};
            // The SDK's split is the valid one, p-q (u-v would leave a sliver).
            const std::vector<Tri> split{{3,0,1},{1,2,3}};
            AdapterMesh base=variant(points,split,0,random); canonicalize(base,{true});
            for (unsigned run=0;run<24;++run) {
                AdapterMesh mesh=variant(points,split,0,random); nudge(mesh,random); canonicalize(mesh,{true});
                same_topology(mesh,base,"quad with a vertex on a diagonal under +/-1 ULP noise keeps its topology");
            }
            require(has_edge(base,P,Q),"the diagonal clear of every vertex is taken");
        }
    }
    // The near rule is about noise only: a vertex 1/16 of a grid step from
    // the shorter diagonal (far above the threshold, 2^-8 of a step) does not
    // block it.
    {
        AdapterMesh probe; probe.positions={0,0,0, 2,0,0, 1,-3,0}; probe.indices={0,2,1}; probe.faces={0};
        const double h=canonical_grid(probe);
        const Point U{0,0,0},Q{1,-3,0},V{2,0,0},P{1,h/16,0};
        AdapterMesh mesh=variant({U,Q,V,P},{{3,0,1},{1,2,3}},0,random); canonicalize(mesh,{true});
        require(has_edge(mesh,U,V),"a vertex well above the near threshold does not block the shorter diagonal");
    }
    // A declined face keeps the SDK's split, so its interior diagonals are
    // foreign to every other face: a 2 x 130 strip (260 vertices, over the
    // 256 cap) and a coplanar quad over its first cell. Whatever the quad's
    // SDK split, it must not take the strip's diagonal of that cell (that
    // edge would get four triangles); it takes the other one.
    {
        std::vector<Point> points; std::vector<Tri> strip;
        for (unsigned i=0;i<130;++i) { points.push_back({double(i),0,0}); points.push_back({double(i),1,0}); }
        for (uint32_t i=0;i+1<130;++i) { strip.push_back({2*i,2*i+2,2*i+3}); strip.push_back({2*i,2*i+3,2*i+1}); }
        const Point a{0,0,0},b{1,0,0},c{1,1,0},d{0,1,0};
        for (bool along_strip:{true,false}) {
            AdapterMesh mesh; for (const auto& p:points) mesh.positions.insert(mesh.positions.end(),p.begin(),p.end());
            for (const auto& t:strip) { mesh.indices.insert(mesh.indices.end(),t.begin(),t.end()); mesh.faces.push_back(0); }
            // The quad (0, 2, 3, 1), split along 0-3 (the strip's) or 2-1.
            if (along_strip) mesh.indices.insert(mesh.indices.end(),{0,2,3, 0,3,1});
            else mesh.indices.insert(mesh.indices.end(),{0,2,1, 2,3,1});
            mesh.faces.insert(mesh.faces.end(),{1,1}); mesh.normals.assign(mesh.indices.size()*3,0.);
            canonicalize(mesh,{true,true});
            unsigned shared=0;
            auto at=[&](uint32_t v) { return Point{mesh.positions[3*v],mesh.positions[3*v+1],mesh.positions[3*v+2]}; };
            for (size_t t=0;t<mesh.faces.size();++t) for (unsigned k=0;k<3;++k) {
                const auto x=at(mesh.indices[3*t+k]),y=at(mesh.indices[3*t+(k+1)%3]);
                if ((x==a && y==c) || (x==c && y==a)) ++shared;
            }
            require(shared==2,"a declined face's diagonal keeps its two triangles");
            for (size_t t=0;t<mesh.faces.size();++t) if (mesh.faces[t]==1) for (unsigned k=0;k<3;++k) {
                const auto x=at(mesh.indices[3*t+k]),y=at(mesh.indices[3*t+(k+1)%3]);
                require(!((x==a && y==c) || (x==c && y==a)),"the overlapping quad avoids the declined face's diagonal");
            }
            require(has_edge(mesh,b,d),"the overlapping quad takes its other diagonal");
        }
    }
    // A zero-thickness part: back-to-back faces over one square share the
    // canonical split, which would give that diagonal four triangles. The
    // planar step then keeps the SDK's split (as before canonicalization), so
    // the part is published as manifold as the SDK made it, not refused, and
    // the result is still a deterministic function of the input.
    {
        const std::vector<Point> square{{0,0,0},{1,0,0},{1,1,0},{0,1,0}};
        AdapterMesh input; for (const auto& p:square) input.positions.insert(input.positions.end(),p.begin(),p.end());
        input.indices={0,1,2, 0,2,3, 0,3,1, 1,3,2}; input.faces={0,0,1,1}; input.normals.assign(36,0.);
        require(edge_counts(input).boundary==0 && edge_counts(input).spine==0,"zero-thickness input is manifold");
        AdapterMesh raw=input; canonicalize(raw,{true,true});
        require(edge_counts(raw).spine>0,"the shared canonical split alone makes a spine edge");
        AdapterMesh ordered=input; order_mesh(ordered); order_mesh(ordered);
        AdapterMesh mesh=input; order_mesh(mesh);
        const auto counts=canonical_planar_faces_or_keep(mesh,{true,true});
        require(counts.boundary==0 && counts.spine==0,"zero-thickness part is not refused");
        same_bytes(mesh,ordered,"zero-thickness part keeps the SDK's planar split in canonical order");
        AdapterMesh again=input; order_mesh(again); canonical_planar_faces_or_keep(again,{true,true});
        same_bytes(again,mesh,"the fallback is deterministic");
        // A part where the retriangulation adds no spine keeps its canonical split.
        AdapterMesh cube; for (unsigned i=0;i<8;++i) cube.positions.insert(cube.positions.end(),{double(i&1),double(i>>1&1),double(i>>2&1)});
        cube.indices={0,2,3, 0,3,1, 4,5,7, 4,7,6, 0,1,5, 0,5,4, 2,6,7, 2,7,3, 0,4,6, 0,6,2, 1,3,7, 1,7,5}; cube.faces={0,0,1,1,2,2,3,3,4,4,5,5};
        cube.normals.assign(cube.indices.size()*3,0.);
        AdapterMesh canonical=cube; canonicalize(canonical,std::vector<bool>(6,true));
        order_mesh(cube); canonical_planar_faces_or_keep(cube,std::vector<bool>(6,true));
        same_bytes(cube,canonical,"a manifold result keeps the canonical split");
    }
    // The exact orientation: on this rotated grid (found by search) the naive
    // double sign of a near-collinear triple is wrong, the greedy then sees a
    // crossing that is not there and declines, and the SDK's split leaks.
    // cos and sin of 2.4909232096394676 rad as literals, so no libm differs.
    {
        const double c=-0x1.97632b8311177p-1,s=0x1.3620d3d3c9c54p-1,spacing=0x1.2c15891c9a2c8p+3;
        std::vector<Point> points,flat; std::vector<Tri> triangles;
        grid(6,6,{},[&](double i,double j) {
            const double x=i*spacing,y=j*spacing; return Point{c*x-s*y,s*x+c*y,1.5}; },random,points,flat,triangles);
        planar_face_is_canonical(points,triangles,random,"rotated grid with near-collinear vertices is canonical",&flat,24);
    }
    // A face tagged planar whose two interior vertices share one projected
    // point (it is folded): the angular order would not be a strict weak
    // order there, so the face is declined.
    {
        AdapterMesh folded; folded.positions={0,0,0, 1,0,0, 1,1,0, 0,1,0, .5,.5,.2, .5,.5,-.2};
        folded.indices={0,1,4, 1,5,4, 1,2,5, 2,3,5, 3,4,5, 3,0,4}; folded.faces.assign(6,0); folded.normals.assign(54,0.);
        declined(folded,{true},"face with two vertices on one projected point is left as split");
    }
}
