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
// Exact 2D orientation for double inputs, after Shewchuk's orient2d: a
// floating-point filter with a proven error bound, and an exact expansion
// (Dekker products, Knuth sums; no FMA needed) when the filter cannot decide.
// Every predicate below uses it, so they can never disagree about a vertex
// being collinear, inside or crossing, however near-degenerate the face.
void two_sum(double a,double b,double& x,double& y) {
    x=a+b; const double bv=x-a, av=x-bv; y=(a-av)+(b-bv);
}
void split(double a,double& hi,double& lo) {
    const double c=134217729.0*a, big=c-a; hi=c-big; lo=a-hi;
}
void two_product(double a,double b,double& x,double& y) {
    x=a*b; double ah,al,bh,bl; split(a,ah,al); split(b,bh,bl);
    y=al*bl-(((x-ah*bh)-al*bh)-ah*bl);
}
int exact_orient(double ax,double ay,double bx,double by,double cx,double cy) {
    const double detleft=(ax-cx)*(by-cy), detright=(ay-cy)*(bx-cx), det=detleft-detright;
    const double bound=(3.0+16.0*0x1p-53)*0x1p-53*(std::abs(detleft)+std::abs(detright));
    if (det>bound) return 1;
    if (-det>bound) return -1;
    // ax*by - ax*cy - ay*bx + ay*cx + bx*cy - by*cx, summed exactly.
    const std::array<std::array<double,2>,6> terms{{{ax,by},{-ax,cy},{-ay,bx},{ay,cx},{bx,cy},{-by,cx}}};
    // Grow-Expansion (Shewchuk): e stays a nonoverlapping expansion in
    // increasing magnitude, so its sign is that of its last nonzero term.
    std::array<double,12> e{}; size_t size=0;
    for (const auto& t:terms) {
        double products[2]; two_product(t[0],t[1],products[0],products[1]);
        for (double q:products) {
            for (size_t i=0;i<size;++i) { double sum,err; two_sum(q,e[i],sum,err); e[i]=err; q=sum; }
            e[size++]=q;
        }
    }
    for (size_t i=size;i-->0;) if (e[i]!=0) return e[i]>0 ? 1 : -1;
    return 0;
}
using P2=std::array<double,2>;
int orient2(const P2& a,const P2& b,const P2& c) { return exact_orient(a[0],a[1],b[0],b[1],c[0],c[1]); }
bool within(const P2& a,const P2& b,const P2& r) {
    return std::min(a[0],b[0])<=r[0] && r[0]<=std::max(a[0],b[0]) && std::min(a[1],b[1])<=r[1] && r[1]<=std::max(a[1],b[1]);
}
// Planar-face retriangulation works in the face's own 2D projection: drop the
// axis of the largest Newell-normal component and keep the other two in cyclic
// order; sign makes orient() > 0 follow the face's outward winding.
struct Plane2 {
    unsigned u=0, v=1; int sign=1;
    P2 at(const AdapterMesh& mesh,uint32_t id) const { return {mesh.positions[3*id+u],mesh.positions[3*id+v]}; }
    int orient(const AdapterMesh& mesh,uint32_t a,uint32_t b,uint32_t c) const {
        return sign*orient2(at(mesh,a),at(mesh,b),at(mesh,c));
    }
};
double squared(const Point& a,const Point& b) {
    const double x=a[0]-b[0],y=a[1]-b[1],z=a[2]-b[2]; return x*x+y*y+z*z;
}
// Greedy constrained triangulation of one planar face from its vertex set and
// boundary alone. Empty on any doubt; the caller then keeps the SDK's split.
// `foreign` holds edges this face must not create (other faces' edges).
std::vector<Triangle> retriangulate(const AdapterMesh& mesh,const std::vector<Triangle>& face,
    const std::map<Edge,unsigned>& foreign) {
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
    const Plane2 plane{(axis+1)%3,(axis+2)%3,n[axis]>0 ? 1 : -1};
    // Exact angular order around a vertex: half-plane, then orientation.
    auto ccw=[&](uint32_t a) {
        const auto o=plane.at(mesh,a);
        auto upper=[&,o](uint32_t b) {
            const auto p=plane.at(mesh,b);
            return plane.sign>0 ? (p[1]>o[1] || (p[1]==o[1] && p[0]>o[0])) : (p[1]<o[1] || (p[1]==o[1] && p[0]>o[0]));
        };
        return [&,a,upper](uint32_t x,uint32_t y) {
            const bool ux=upper(x),uy=upper(y);
            if (ux!=uy) return ux;
            const int turn=plane.orient(mesh,a,x,y);
            return turn>0 || (turn==0 && x<y);
        };
    };
    const std::set<std::pair<uint32_t,uint32_t>> outline(boundary.begin(),boundary.end());
    // The face lies left of every directed boundary edge, so going
    // counterclockwise around a vertex it starts after an outgoing boundary
    // edge and ends at the next incoming one. A direction is inside iff the
    // boundary neighbour before it is an outgoing one: exact, pinches included.
    std::map<uint32_t,std::vector<uint32_t>> rim;
    for (const auto& [a,b]:boundary) { rim[a].push_back(b); rim[b].push_back(a); }
    for (auto& [a,next]:rim) std::sort(next.begin(),next.end(),ccw(a));
    auto inward=[&](uint32_t a,uint32_t b) {
        const auto found=rim.find(a);
        if (found==rim.end()) return true; // a is an interior vertex
        const auto& next=found->second;
        const auto before=ccw(a);
        for (uint32_t r:next)
            if (plane.orient(mesh,a,r,b)==0 && !before(r,b) && !before(b,r)) return false; // along the rim
        // Last rim neighbour strictly before b (cyclically).
        uint32_t previous=next.back();
        for (uint32_t r:next) if (before(r,b)) previous=r;
        return outline.count({a,previous})>0;
    };
    std::set<Edge> edges;
    for (const auto& [a,b]:boundary) edges.insert(edge(a,b));
    std::vector<std::tuple<double,uint32_t,uint32_t>> candidates;
    for (size_t i=0;i<vertices.size();++i) for (size_t j=i+1;j<vertices.size();++j) {
        const Edge e{vertices[i],vertices[j]};
        if (edges.count(e) || foreign.count(e)) continue;
        candidates.emplace_back(squared(point(mesh,e.first),point(mesh,e.second)),e.first,e.second);
    }
    std::sort(candidates.begin(),candidates.end());
    // A triangulation of this face has exactly (3T + B) / 2 edges (Euler), so
    // once the greedy set is that large every remaining candidate would cross.
    const size_t complete=(3*face.size()+boundary.size())/2;
    for (const auto& [length,a,b]:candidates) {
        if (edges.size()>=complete) break;
        if (!inward(a,b) || !inward(b,a)) continue;
        bool ok=true;
        const auto p=plane.at(mesh,a),q=plane.at(mesh,b);
        for (uint32_t c:vertices) {
            if (c==a || c==b) continue;
            const auto r=plane.at(mesh,c);
            if (orient2(p,q,r)==0 && within(p,q,r)) { ok=false; break; }
        }
        for (auto it=edges.begin();ok && it!=edges.end();++it) {
            const auto [c,d]=*it;
            if (c==a || c==b || d==a || d==b) continue;
            const int o1=plane.orient(mesh,a,b,c),o2=plane.orient(mesh,a,b,d);
            const int o3=plane.orient(mesh,c,d,a),o4=plane.orient(mesh,c,d,b);
            if (o1*o2<0 && o3*o4<0) ok=false;
        }
        if (!ok) continue;
        edges.insert({a,b});
    }
    // Faces of the edge graph: consecutive neighbours around each vertex, in
    // exact angular order (half-plane, then orientation).
    std::map<uint32_t,std::vector<uint32_t>> around;
    for (const auto& [a,b]:edges) { around[a].push_back(b); around[b].push_back(a); }
    std::set<Triangle> found;
    for (auto& [a,next]:around) {
        std::sort(next.begin(),next.end(),ccw(a));
        for (size_t k=0;k<next.size();++k) {
            const uint32_t b=next[k],c=next[(k+1)%next.size()];
            // From an incoming boundary edge to an outgoing one is outside.
            if (b==c || !edges.count(edge(b,c)) || plane.orient(mesh,a,b,c)<=0 ||
                (outline.count({b,a}) && outline.count({a,c}))) continue;
            found.insert(rotated({a,b,c}));
        }
    }
    if (found.size()!=face.size()) return {};
    // Each boundary edge once, in its original direction; each interior edge
    // once in each direction. Same area and outward normals.
    std::map<std::pair<uint32_t,uint32_t>,unsigned> after;
    double before_area=0,after_area=0;
    for (const auto& t:face) { const auto c=cross(mesh,t); before_area+=std::hypot(c[0],c[1],c[2]); }
    for (const auto& t:found) {
        Point unit;
        if (!flat_normal(point(mesh,t[0]),point(mesh,t[1]),point(mesh,t[2]),unit) || !(dot(unit,n)>0)) return {};
        const auto c=cross(mesh,t); after_area+=std::hypot(c[0],c[1],c[2]);
        for (unsigned k=0;k<3;++k) ++after[{t[k],t[(k+1)%3]}];
    }
    for (const auto& [d,count]:after) {
        const bool outer=outline.count(d), reverse=after.count({d.second,d.first});
        if (count!=1 || (outer ? reverse : !reverse) || outline.count({d.second,d.first})) return {};
    }
    for (const auto& d:outline) if (!after.count(d)) return {};
    if (!(std::abs(after_area-before_area)<=1e-9*before_area)) return {};
    return {found.begin(),found.end()};
}
}

void canonical_planar_faces(AdapterMesh& mesh,const std::vector<bool>& planar_faces) {
    const size_t triangles=mesh.indices.size()/3;
    struct Span { size_t begin, end; bool eligible; };
    std::vector<Span> spans;
    // order_mesh made each source face's triangles contiguous.
    for (size_t first=0;first<triangles;) {
        size_t end=first+1;
        while (end<triangles && mesh.faces[end]==mesh.faces[first]) ++end;
        const auto source=mesh.faces[first];
        spans.push_back({first,end,end-first>=2 && source<planar_faces.size() && planar_faces[source]});
        first=end;
    }
    // Edges a retriangulated face must not create (they would make the mesh
    // non-manifold): every edge of a face that is not retriangulated, and
    // every face's boundary edges. Interior diagonals of retriangulated faces
    // are left out on purpose: they are the SDK's split, about to be replaced,
    // and two faces' diagonals can only coincide when the faces overlap
    // (degenerate geometry), where both then get the same canonical split. So
    // the set depends on no face's split and on no visiting order.
    std::map<Edge,unsigned> foreign;
    auto interior=[&](const Span& s) {
        std::map<Edge,unsigned> uses;
        for (size_t t=s.begin;t<s.end;++t) for (unsigned k=0;k<3;++k)
            ++uses[edge(mesh.indices[3*t+k],mesh.indices[3*t+(k+1)%3])];
        std::vector<Edge> result;
        for (const auto& [e,count]:uses) if (count==2) result.push_back(e);
        return result;
    };
    std::vector<std::vector<Edge>> pending(spans.size());
    // (A declined face keeps its SDK diagonals; leaving them out too keeps the
    // set independent of which faces decline.)
    for (size_t t=0;t<triangles;++t) for (unsigned k=0;k<3;++k)
        ++foreign[edge(mesh.indices[3*t+k],mesh.indices[3*t+(k+1)%3])];
    for (size_t i=0;i<spans.size();++i) if (spans[i].eligible) {
        pending[i]=interior(spans[i]);
        for (const auto& e:pending[i]) { auto it=foreign.find(e); if (!(it->second-=2)) foreign.erase(it); }
    }
    for (size_t i=0;i<spans.size();++i) {
        const auto& s=spans[i];
        if (!s.eligible) continue;
        std::vector<Triangle> face;
        for (size_t t=s.begin;t<s.end;++t) face.push_back(triangle(mesh,t));
        // This face's own boundary edges are in `foreign` too; they are never
        // candidates, so only other faces' edges can block a diagonal.
        const auto result=retriangulate(mesh,face,foreign);
        if (!result.empty())
            for (size_t t=s.begin;t<s.end;++t) for (unsigned k=0;k<3;++k) mesh.indices[3*t+k]=result[t-s.begin][k];
    }
}
