// SPDX-License-Identifier: MPL-2.0
// Canonical adapter meshes: the SDK's enumeration order is not reproducible.
#include "mesh_canonical.hpp"
#include "mesh.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <numeric>
#include <set>
#include <tuple>

namespace {
using Point=std::array<double,3>;
using Triangle=std::array<uint32_t,3>;
// A total order on finite coordinates: -0 sorts before +0.
bool less(double a,double b) {
    if (a<b) return true;
    if (b<a) return false;
    return std::signbit(a) && !std::signbit(b);
}
bool less(const Point& a,const Point& b) {
    for (unsigned i=0;i<3;++i) {
        if (less(a[i],b[i])) return true;
        if (less(b[i],a[i])) return false;
    }
    return false;
}
Point point(const AdapterMesh& mesh,uint32_t id) {
    return {mesh.positions[3*id],mesh.positions[3*id+1],mesh.positions[3*id+2]};
}
Triangle triangle(const AdapterMesh& mesh,size_t id) {
    return {mesh.indices[3*id],mesh.indices[3*id+1],mesh.indices[3*id+2]};
}
Point cross(const AdapterMesh& mesh,const Triangle& t) {
    const auto a=point(mesh,t[0]),b=point(mesh,t[1]),c=point(mesh,t[2]);
    const double ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2];
    const double vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2];
    return {uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx};
}
double dot(const Point& a,const Point& b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
using Edge=std::pair<uint32_t,uint32_t>;
Edge edge(uint32_t a,uint32_t b) { return std::minmax(a,b); }
Triangle rotated(Triangle t) {
    std::rotate(t.begin(),std::min_element(t.begin(),t.end()),t.end());
    return t;
}
// Coincident vertices tie on coordinates; tell them apart by their incident
// corners (source face, next and previous corner positions), which do not
// depend on vertex numbering.
using Corner=std::tuple<uint32_t,Point,Point>;
bool less(const Corner& a,const Corner& b) {
    if (std::get<0>(a)!=std::get<0>(b)) return std::get<0>(a)<std::get<0>(b);
    if (less(std::get<1>(a),std::get<1>(b))) return true;
    if (less(std::get<1>(b),std::get<1>(a))) return false;
    return less(std::get<2>(a),std::get<2>(b));
}
}

bool flat_normal(const std::array<double,3>& a,const std::array<double,3>& b,const std::array<double,3>& c,
    std::array<double,3>& out) {
    // Each corner's cross product is the same vector in exact arithmetic; in
    // doubles a sliver's can round to zero or flip. The longest is the most
    // accurate, and the choice does not depend on which corner comes first
    // unless two lengths tie exactly (then the earliest corner wins).
    const std::array<std::array<double,3>,3> corners{{a,b,c}};
    double best=0; Point n{};
    for (unsigned k=0;k<3;++k) {
        const auto& p=corners[k]; const auto& q=corners[(k+1)%3]; const auto& r=corners[(k+2)%3];
        const double ux=q[0]-p[0],uy=q[1]-p[1],uz=q[2]-p[2];
        const double vx=r[0]-p[0],vy=r[1]-p[1],vz=r[2]-p[2];
        const Point m{uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx};
        const double length=std::hypot(m[0],m[1],m[2]);
        if (std::isfinite(length) && length>best) { best=length; n=m; }
    }
    if (!(best>0)) return false;
    for (unsigned axis=0;axis<3;++axis) out[axis]=n[axis]/best;
    return true;
}

void order_mesh(AdapterMesh& mesh) {
    const auto vertices=uint32_t(mesh.positions.size()/3);
    const size_t triangles=mesh.indices.size()/3;
    std::vector<uint32_t> order(vertices);
    std::iota(order.begin(),order.end(),0u);
    std::stable_sort(order.begin(),order.end(),[&](uint32_t a,uint32_t b) {
        return less(point(mesh,a),point(mesh,b));
    });
    std::vector<std::vector<Corner>> corners; // built once, only if two vertices coincide
    for (size_t begin=0;begin<order.size();) {
        size_t end=begin+1;
        const auto p=point(mesh,order[begin]);
        while (end<order.size() && !less(p,point(mesh,order[end]))) ++end;
        if (end-begin>1) {
            if (corners.empty()) {
                corners.resize(vertices);
                for (size_t t=0;t<triangles;++t) for (unsigned k=0;k<3;++k)
                    corners[mesh.indices[3*t+k]].emplace_back(mesh.faces[t],
                        point(mesh,mesh.indices[3*t+(k+1)%3]),point(mesh,mesh.indices[3*t+(k+2)%3]));
                for (auto& c:corners)
                    std::sort(c.begin(),c.end(),[](const Corner& a,const Corner& b) { return less(a,b); });
            }
            std::stable_sort(order.begin()+begin,order.begin()+end,[&](uint32_t a,uint32_t b) {
                return std::lexicographical_compare(corners[a].begin(),corners[a].end(),
                    corners[b].begin(),corners[b].end(),[](const Corner& x,const Corner& y) { return less(x,y); });
            });
        }
        begin=end;
    }
    std::vector<uint32_t> rank(vertices);
    std::vector<double> positions(mesh.positions.size());
    for (uint32_t i=0;i<vertices;++i) {
        rank[order[i]]=i;
        for (unsigned axis=0;axis<3;++axis) positions[3*i+axis]=mesh.positions[3*order[i]+axis];
    }
    std::vector<std::pair<uint32_t,Triangle>> sorted(triangles);
    for (size_t t=0;t<triangles;++t) {
        const auto old=triangle(mesh,t);
        sorted[t]={mesh.faces[t],rotated({rank[old[0]],rank[old[1]],rank[old[2]]})};
    }
    std::sort(sorted.begin(),sorted.end());
    mesh.positions=std::move(positions);
    for (size_t t=0;t<triangles;++t) {
        mesh.faces[t]=sorted[t].first;
        for (unsigned k=0;k<3;++k) mesh.indices[3*t+k]=sorted[t].second[k];
        const auto& c=sorted[t].second;
        Point n;
        if (!flat_normal(point(mesh,c[0]),point(mesh,c[1]),point(mesh,c[2]),n))
            throw AdapterMeshFailure{"degenerate tessellation triangle"};
        for (unsigned k=0;k<3;++k) for (unsigned axis=0;axis<3;++axis)
            mesh.normals[9*t+3*k+axis]=n[axis];
    }
}

void canonical_planar_quads(AdapterMesh& mesh,const std::vector<bool>& planar_faces) {
    const size_t triangles=mesh.indices.size()/3;
    // A new diagonal must not duplicate an edge the mesh already has (as in
    // normalize_mesh_diagonals); that would make the mesh non-manifold.
    std::set<Edge> edges;
    for (size_t t=0;t<triangles;++t) for (unsigned k=0;k<3;++k)
        edges.insert(edge(mesh.indices[3*t+k],mesh.indices[3*t+(k+1)%3]));
    // order_mesh made each source face's triangles contiguous.
    for (size_t first=0;first<triangles;) {
        size_t end=first+1;
        while (end<triangles && mesh.faces[end]==mesh.faces[first]) ++end;
        const auto source=mesh.faces[first];
        const size_t count=end-first;
        const size_t second=first+1;
        first=end;
        if (count!=2 || source>=planar_faces.size() || !planar_faces[source]) continue;
        const auto a=triangle(mesh,second-1),b=triangle(mesh,second);
        // a=(u,v,p) and b=(v,u,q) share the directed edge u->v / v->u.
        unsigned i=0,j=0;
        for (;i<3;++i) {
            for (j=0;j<3;++j) if (b[j]==a[(i+1)%3] && b[(j+1)%3]==a[i]) break;
            if (j<3) break;
        }
        if (i==3) continue; // not one quad with consistent winding
        const uint32_t u=a[i],v=a[(i+1)%3],p=a[(i+2)%3],q=b[(j+2)%3];
        if (p==q || std::min({u,v,p,q})==std::min(u,v)) continue; // already through the lowest vertex
        if (edges.count(edge(p,q))) continue;
        const Triangle left{p,u,q},right{q,v,p};
        auto n=cross(mesh,a); const auto nb=cross(mesh,b);
        for (unsigned k=0;k<3;++k) n[k]+=nb[k];
        // Strictly convex quad (boundary u,q,v,p) and both new triangles face
        // the pair's own area normal: the new split stays inside the face.
        const std::array<uint32_t,4> loop{u,q,v,p};
        bool convex=true;
        for (unsigned k=0;k<4;++k)
            convex &= dot(cross(mesh,{loop[k],loop[(k+1)%4],loop[(k+2)%4]}),n)>0;
        if (!convex || !(dot(cross(mesh,left),n)>0) || !(dot(cross(mesh,right),n)>0)) continue;
        for (unsigned k=0;k<3;++k) {
            mesh.indices[3*(second-1)+k]=left[k];
            mesh.indices[3*second+k]=right[k];
        }
        edges.erase(edge(u,v)); edges.insert(edge(p,q));
    }
}
