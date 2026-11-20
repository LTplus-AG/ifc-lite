// SPDX-License-Identifier: MPL-2.0
// Canonical adapter meshes: the SDK's enumeration order is not reproducible.
#include "mesh_canonical.hpp"
#include "mesh.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <map>
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

namespace {
// Planar-face retriangulation works in the face's own 2D projection: drop the
// axis of the largest Newell-normal component, keep the other two in cyclic
// order and orient by that component's sign, so orient() > 0 follows the
// face's outward winding. All inputs are canonical (vertex IDs and boundary
// edges), so these double-precision predicates are deterministic.
struct Plane2 {
    unsigned u=0, v=1; double sign=1;
    std::array<double,2> at(const AdapterMesh& mesh,uint32_t id) const {
        return {mesh.positions[3*id+u],mesh.positions[3*id+v]};
    }
    double orient(const AdapterMesh& mesh,uint32_t a,uint32_t b,uint32_t c) const {
        const auto p=at(mesh,a),q=at(mesh,b),r=at(mesh,c);
        return sign*((q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]));
    }
};
double squared(const Point& a,const Point& b) {
    const double x=a[0]-b[0],y=a[1]-b[1],z=a[2]-b[2]; return x*x+y*y+z*z;
}
// Crossing-number test against the face's directed boundary; false on it.
bool inside(const std::array<double,2>& m,const std::vector<std::array<std::array<double,2>,2>>& boundary) {
    bool in=false;
    for (const auto& e:boundary) {
        const auto& a=e[0]; const auto& b=e[1];
        const double cross=(b[0]-a[0])*(m[1]-a[1])-(b[1]-a[1])*(m[0]-a[0]);
        if (cross==0 && std::min(a[0],b[0])<=m[0] && m[0]<=std::max(a[0],b[0]) &&
            std::min(a[1],b[1])<=m[1] && m[1]<=std::max(a[1],b[1])) return false;
        if ((a[1]>m[1])!=(b[1]>m[1]) && m[0]<a[0]+(m[1]-a[1])*(b[0]-a[0])/(b[1]-a[1])) in=!in;
    }
    return in;
}
// Greedy constrained triangulation of one planar face from its vertex set and
// boundary alone. Empty on any doubt; the caller then keeps the SDK's split.
std::vector<Triangle> retriangulate(const AdapterMesh& mesh,const std::vector<Triangle>& face,
    const std::map<Edge,unsigned>& all) {
    std::set<std::pair<uint32_t,uint32_t>> directed;
    std::map<Edge,unsigned> uses;
    std::vector<uint32_t> vertices;
    for (const auto& t:face) for (unsigned k=0;k<3;++k) {
        if (!directed.emplace(t[k],t[(k+1)%3]).second) return {};
        ++uses[edge(t[k],t[(k+1)%3])]; vertices.push_back(t[k]);
    }
    std::sort(vertices.begin(),vertices.end());
    vertices.erase(std::unique(vertices.begin(),vertices.end()),vertices.end());
    if (vertices.size()>256) return {};
    // An edge another face already uses (all counts this face's own uses too).
    auto foreign=[&](const Edge& e) {
        const auto it=all.find(e); const auto own=uses.find(e);
        return it!=all.end() && it->second>(own==uses.end() ? 0u : own->second);
    };
    std::vector<std::pair<uint32_t,uint32_t>> boundary;
    for (const auto& [a,b]:directed) {
        if (uses[edge(a,b)]>2) return {};
        if (!directed.count({b,a})) boundary.emplace_back(a,b);
    }
    Point n{};
    for (const auto& [a,b]:boundary) {
        const auto p=point(mesh,a),q=point(mesh,b);
        n[0]+=(p[1]-q[1])*(p[2]+q[2]); n[1]+=(p[2]-q[2])*(p[0]+q[0]); n[2]+=(p[0]-q[0])*(p[1]+q[1]);
    }
    unsigned axis=0;
    for (unsigned k=1;k<3;++k) if (std::abs(n[k])>std::abs(n[axis])) axis=k;
    if (!(std::abs(n[axis])>0)) return {};
    Plane2 plane{(axis+1)%3,(axis+2)%3,n[axis]>0 ? 1. : -1.};
    std::vector<std::array<std::array<double,2>,2>> loops;
    for (const auto& [a,b]:boundary) loops.push_back({plane.at(mesh,a),plane.at(mesh,b)});
    std::set<Edge> edges;
    for (const auto& [a,b]:boundary) edges.insert(edge(a,b));
    std::vector<std::tuple<double,uint32_t,uint32_t>> candidates;
    for (size_t i=0;i<vertices.size();++i) for (size_t j=i+1;j<vertices.size();++j) {
        const Edge e{vertices[i],vertices[j]};
        if (edges.count(e) || foreign(e)) continue;
        candidates.emplace_back(squared(point(mesh,e.first),point(mesh,e.second)),e.first,e.second);
    }
    std::sort(candidates.begin(),candidates.end());
    for (const auto& [length,a,b]:candidates) {
        bool ok=true;
        for (uint32_t c:vertices) {
            if (c==a || c==b || plane.orient(mesh,a,b,c)!=0) continue;
            const auto p=plane.at(mesh,a),q=plane.at(mesh,b),r=plane.at(mesh,c);
            if (std::min(p[0],q[0])<=r[0] && r[0]<=std::max(p[0],q[0]) &&
                std::min(p[1],q[1])<=r[1] && r[1]<=std::max(p[1],q[1])) { ok=false; break; }
        }
        for (auto it=edges.begin();ok && it!=edges.end();++it) {
            const auto [c,d]=*it;
            if (c==a || c==b || d==a || d==b) continue;
            const double o1=plane.orient(mesh,a,b,c),o2=plane.orient(mesh,a,b,d);
            const double o3=plane.orient(mesh,c,d,a),o4=plane.orient(mesh,c,d,b);
            if (((o1>0 && o2<0) || (o1<0 && o2>0)) && ((o3>0 && o4<0) || (o3<0 && o4>0))) ok=false;
        }
        if (!ok) continue;
        const auto p=plane.at(mesh,a),q=plane.at(mesh,b);
        if (!inside({(p[0]+q[0])/2,(p[1]+q[1])/2},loops)) continue;
        edges.insert({a,b});
    }
    // Faces of the edge graph: consecutive neighbours around each vertex.
    std::map<uint32_t,std::vector<uint32_t>> around;
    for (const auto& [a,b]:edges) { around[a].push_back(b); around[b].push_back(a); }
    std::set<Triangle> found;
    for (auto& [a,next]:around) {
        const auto origin=plane.at(mesh,a);
        auto angle=[&](uint32_t b) {
            const auto p=plane.at(mesh,b); return std::atan2(plane.sign*(p[1]-origin[1]),p[0]-origin[0]);
        };
        std::sort(next.begin(),next.end(),[&](uint32_t x,uint32_t y) {
            const double ax=angle(x),ay=angle(y); return ax<ay || (ax==ay && x<y);
        });
        for (size_t k=0;k<next.size();++k) {
            const uint32_t b=next[k],c=next[(k+1)%next.size()];
            if (b==c || !edges.count(edge(b,c)) || !(plane.orient(mesh,a,b,c)>0)) continue;
            const auto pb=plane.at(mesh,b),pc=plane.at(mesh,c);
            if (!inside({(origin[0]+pb[0]+pc[0])/3,(origin[1]+pb[1]+pc[1])/3},loops)) continue;
            found.insert(rotated({a,b,c}));
        }
    }
    if (found.size()!=face.size()) return {};
    std::map<Edge,unsigned> after;
    double before_area=0,after_area=0;
    for (const auto& t:face) { const auto c=cross(mesh,t); before_area+=std::hypot(c[0],c[1],c[2]); }
    for (const auto& t:found) {
        Point unit;
        if (!flat_normal(point(mesh,t[0]),point(mesh,t[1]),point(mesh,t[2]),unit) || !(dot(unit,n)>0)) return {};
        const auto c=cross(mesh,t); after_area+=std::hypot(c[0],c[1],c[2]);
        for (unsigned k=0;k<3;++k) ++after[edge(t[k],t[(k+1)%3])];
    }
    for (const auto& [e,count]:after)
        if (count!=(std::count_if(boundary.begin(),boundary.end(),[&](const auto& d) { return edge(d.first,d.second)==e; }) ? 1u : 2u))
            return {};
    if (!(std::abs(after_area-before_area)<=1e-9*before_area)) return {};
    return {found.begin(),found.end()};
}
}

void canonical_planar_faces(AdapterMesh& mesh,const std::vector<bool>& planar_faces) {
    const size_t triangles=mesh.indices.size()/3;
    std::map<Edge,unsigned> all;
    for (size_t t=0;t<triangles;++t) for (unsigned k=0;k<3;++k)
        ++all[edge(mesh.indices[3*t+k],mesh.indices[3*t+(k+1)%3])];
    // order_mesh made each source face's triangles contiguous; faces are
    // visited in source-face order, so edges claimed earlier are canonical.
    for (size_t first=0;first<triangles;) {
        size_t end=first+1;
        while (end<triangles && mesh.faces[end]==mesh.faces[first]) ++end;
        const auto source=mesh.faces[first];
        const size_t begin=first; first=end;
        if (end-begin<2 || source>=planar_faces.size() || !planar_faces[source]) continue;
        std::vector<Triangle> face;
        for (size_t t=begin;t<end;++t) face.push_back(triangle(mesh,t));
        // A new diagonal must not duplicate an edge of another face (as in
        // normalize_mesh_diagonals): that would make the mesh non-manifold.
        const auto result=retriangulate(mesh,face,all);
        if (result.empty()) continue;
        for (const auto& t:face) for (unsigned k=0;k<3;++k) --all[edge(t[k],t[(k+1)%3])];
        for (size_t t=begin;t<end;++t) {
            const auto& r=result[t-begin];
            for (unsigned k=0;k<3;++k) { mesh.indices[3*t+k]=r[k]; ++all[edge(r[k],r[(k+1)%3])]; }
        }
    }
}
