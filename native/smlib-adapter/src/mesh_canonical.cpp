// SPDX-License-Identifier: MPL-2.0
// Canonical adapter meshes: the SDK's enumeration order is not reproducible.
#include "mesh_canonical.hpp"
#include "mesh.hpp"
#include <algorithm>
#include <array>
#include <iterator>
#include <cmath>
#include <cstdint>
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
// Sort keys are coordinates on the canonical grid (see canonical_grid), so
// that the SDK's run-to-run value noise of about one ULP does not reorder
// vertices or flip a near-tie. Values themselves are never rounded.
using QKey=std::array<int64_t,3>;
// Nearest grid point, not floor: exact model values (0, integers, multiples
// of the power-of-two step) then sit mid-cell, and the boundaries are at half
// steps, where a 1-ULP change matters only for values within a ULP of them.
int64_t quantize(double x,double h) { return std::llround(x/h); }
QKey qkey(const Point& p,double h) { return {quantize(p[0],h),quantize(p[1],h),quantize(p[2],h)}; }
// Coincident vertices (equal keys) are told apart by their incident corners:
// (source face, next and previous corner keys), which do not depend on vertex
// numbering; exact coordinates come last.
using Corner=std::tuple<uint32_t,QKey,QKey>;
}

double canonical_grid(const AdapterMesh& mesh) {
    // The SDK's coordinates differ between runs by about one ULP of their own
    // magnitude, so the step must be far above ULP(M) = M * 2^-52 for the
    // largest |coordinate| M: at least 2^16 ULP(M) here, which makes a 1-ULP
    // change cross a grid boundary for about 1 in 2^15 noisy coordinates.
    // Where the offset is small the step is between 2^-30 and 2^-29 of the
    // bounding-box extent (sub-nanometre for building parts), so ties only
    // join points that are practically coincident; with a large
    // georeferenced offset it is between 2^-36 M and 2^-35 M (2^-14 m, about
    // 61 um, at 2.6e6 m). A power of two keeps the step itself stable under
    // the same noise, except when the base value lies within noise of a power
    // of two, where ilogb can flip it (and with it every key).
    double low[3]={0,0,0},high[3]={0,0,0},largest=0;
    for (size_t i=0;i<mesh.positions.size();i+=3) for (unsigned axis=0;axis<3;++axis) {
        const double x=mesh.positions[i+axis];
        if (i==0 || x<low[axis]) low[axis]=x;
        if (i==0 || x>high[axis]) high[axis]=x;
        largest=std::max(largest,std::abs(x));
    }
    const double extent=std::max({high[0]-low[0],high[1]-low[1],high[2]-low[2]});
    const double base=std::max(std::ldexp(extent,-30),std::ldexp(largest,-36));
    return base>0 && std::isfinite(base) ? std::ldexp(1.,std::ilogb(base)+1) : 1.;
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
    const double h=canonical_grid(mesh);
    std::vector<QKey> keys(vertices);
    for (uint32_t v=0;v<vertices;++v) keys[v]=qkey(point(mesh,v),h);
    std::vector<uint32_t> order(vertices);
    std::iota(order.begin(),order.end(),0u);
    std::stable_sort(order.begin(),order.end(),[&](uint32_t a,uint32_t b) { return keys[a]<keys[b]; });
    std::vector<std::vector<Corner>> corners; // built once, only if two keys tie
    for (size_t begin=0;begin<order.size();) {
        size_t end=begin+1;
        while (end<order.size() && keys[order[end]]==keys[order[begin]]) ++end;
        if (end-begin>1) {
            if (corners.empty()) {
                corners.resize(vertices);
                for (size_t t=0;t<triangles;++t) for (unsigned k=0;k<3;++k)
                    corners[mesh.indices[3*t+k]].emplace_back(mesh.faces[t],
                        keys[mesh.indices[3*t+(k+1)%3]],keys[mesh.indices[3*t+(k+2)%3]]);
                for (auto& c:corners) std::sort(c.begin(),c.end());
            }
            std::stable_sort(order.begin()+begin,order.begin()+end,[&](uint32_t a,uint32_t b) {
                if (corners[a]!=corners[b]) return corners[a]<corners[b];
                return less(point(mesh,a),point(mesh,b));
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
// Distance below which a vertex counts as on a diagonal: 2^-8 of the grid
// step, so at least 2^8 ULP of the largest |coordinate|. That is far above the
// SDK's noise of about one ULP, which is what the rule is for, and far below
// the width of any real face (a thin face of width w is still split by its
// best diagonal while w > this threshold, and by the last resort below it).
// Tying it to the step itself instead rejected both diagonals of every face
// thinner than one step and left such faces to the SDK's split.
double near_threshold(double h) { return std::ldexp(h,-8); }
// A vertex within near_threshold of the open segment a-b (3D). A diagonal that
// passes this close to a vertex is not taken while another valid one exists:
// whether it would pass inside or outside a nearly collinear vertex is
// decided by the SDK's last bits. This only ranks candidates; every accepted
// one is still validated exactly.
bool near(const Point& a,const Point& b,const Point& c,double h) {
    const double limit=near_threshold(h);
    const Point ab{b[0]-a[0],b[1]-a[1],b[2]-a[2]},ac{c[0]-a[0],c[1]-a[1],c[2]-a[2]};
    const double length=dot(ab,ab);
    if (!(length>0)) return true;
    const double t=dot(ac,ab)/length;
    if (!(t>0 && t<1)) return false;
    const Point d{ac[0]-t*ab[0],ac[1]-t*ab[1],ac[2]-t*ab[2]};
    return dot(d,d)<=limit*limit;
}
// Diagonal length on the canonical grid: equal lengths (a rectangle's
// diagonals) stay equal under the SDK's ULP noise and fall to the vertex IDs.
int64_t grid_length(const Point& a,const Point& b,double h) {
    const double x=a[0]-b[0],y=a[1]-b[1],z=a[2]-b[2]; return quantize(std::sqrt(x*x+y*y+z*z),h);
}
// The face's projection from its directed boundary (Newell normal).
bool projection(const AdapterMesh& mesh,const std::vector<std::pair<uint32_t,uint32_t>>& boundary,Plane2& plane,Point& n) {
    n={};
    for (const auto& [a,b]:boundary) {
        const auto p=point(mesh,a),q=point(mesh,b);
        n[0]+=(p[1]-q[1])*(p[2]+q[2]); n[1]+=(p[2]-q[2])*(p[0]+q[0]); n[2]+=(p[0]-q[0])*(p[1]+q[1]);
    }
    // Largest component on a grid of 2^-30 of the largest, so a 45-degree
    // face keeps its axis under ULP noise (ties go to the lower axis).
    const double largest=std::max({std::abs(n[0]),std::abs(n[1]),std::abs(n[2])});
    if (!(largest>0) || !std::isfinite(largest)) return false;
    const double step=std::ldexp(1.,std::ilogb(largest)-29);
    unsigned axis=0;
    for (unsigned k=1;k<3;++k) if (quantize(std::abs(n[k]),step)>quantize(std::abs(n[axis]),step)) axis=k;
    if (!(std::abs(n[axis])>0)) return false;
    plane=Plane2{(axis+1)%3,(axis+2)%3,n[axis]>0 ? 1 : -1};
    return true;
}
// A two-triangle face in closed form: the diagonal first in (grid length,
// lower, upper) order among those that are not foreign, leave both triangles
// strictly positive (exact orientation) and pass no vertex within
// near_threshold; if near-rejection leaves none, the first such diagonal
// regardless of nearness whose two flat normals follow the face. Empty when neither diagonal is valid (the SDK's
// split stays). This is the greedy's ranking, not the same rule in closed
// form: requad skips retriangulate's area, normal and edge-use checks, so for
// a near-collinear quad at a large offset it can return a split where
// retriangulate would decline. Its own result depends only on exact
// orientations and grid keys, whereas retriangulate's 1e-9 relative area
// check on such a sliver can itself flip with the SDK's noise.
std::vector<Triangle> requad(const AdapterMesh& mesh,const Triangle& a,const Triangle& b,
    const std::vector<Edge>& foreign,double h) {
    for (unsigned i=0;i<3;++i) for (unsigned j=0;j<3;++j) {
        if (!(b[j]==a[(i+1)%3] && b[(j+1)%3]==a[i])) continue;
        const uint32_t u=a[i],v=a[(i+1)%3],p=a[(i+2)%3],q=b[(j+2)%3];
        if (p==q) return {};
        Plane2 plane; Point n;
        if (!projection(mesh,{{u,q},{q,v},{v,p},{p,u}},plane,n)) return {};
        auto rank=[&](uint32_t x,uint32_t y) { return std::make_tuple(grid_length(point(mesh,x),point(mesh,y),h),std::min(x,y),std::max(x,y)); };
        const auto U=point(mesh,u),V=point(mesh,v),P=point(mesh,p),Q=point(mesh,q);
        const bool kept=plane.orient(mesh,u,v,p)>0 && plane.orient(mesh,v,u,q)>0 &&
            !std::binary_search(foreign.begin(),foreign.end(),edge(u,v));
        const bool flipped=plane.orient(mesh,p,u,q)>0 && plane.orient(mesh,q,v,p)>0 &&
            !std::binary_search(foreign.begin(),foreign.end(),edge(p,q));
        const bool kept_clear=kept && !near(U,V,P,h) && !near(U,V,Q,h);
        const bool flipped_clear=flipped && !near(P,Q,U,h) && !near(P,Q,V,h);
        // Prefer diagonals clear of every vertex. The last resort ignores
        // nearness, but its triangles can be slivers: it also needs both flat
        // normals along the face's, or order_mesh would refuse a degenerate
        // triangle (or emit an inverted one).
        auto sound=[&](const Triangle& x,const Triangle& y) {
            Point unit;
            for (const auto& t:{x,y})
                if (!flat_normal(point(mesh,t[0]),point(mesh,t[1]),point(mesh,t[2]),unit) || !(dot(unit,n)>0)) return false;
            return true;
        };
        const bool clear=kept_clear || flipped_clear;
        const bool use_kept=clear ? kept_clear : kept && sound(a,b);
        const bool use_flipped=clear ? flipped_clear : flipped && sound({p,u,q},{q,v,p});
        if (use_flipped && (!use_kept || rank(p,q)<rank(u,v))) return {Triangle{p,u,q},Triangle{q,v,p}};
        if (use_kept) return {a,b};
        return {};
    }
    return {};
}
// Greedy constrained triangulation of one planar face from its vertex set and
// boundary alone. Empty on any doubt; the caller then keeps the SDK's split.
// `foreign` holds edges this face must not create (other faces' edges). With
// `avoid_near`, diagonals passing within near_threshold of a vertex are
// skipped; retriangulate retries without that rule as a last resort.
std::vector<Triangle> greedy(const AdapterMesh& mesh,const std::vector<Triangle>& face,
    const std::vector<Edge>& foreign,double h,bool avoid_near) {
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
    Plane2 plane; Point n;
    if (!projection(mesh,boundary,plane,n)) return {};
    // Two vertices with one projected point (a non-planar face tagged planar)
    // would make the angular order below not a strict weak order: decline.
    {
        std::vector<P2> projected;
        for (uint32_t v:vertices) projected.push_back(plane.at(mesh,v));
        std::sort(projected.begin(),projected.end());
        if (std::adjacent_find(projected.begin(),projected.end())!=projected.end()) return {};
    }
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
    std::vector<std::tuple<int64_t,uint32_t,uint32_t>> candidates;
    for (size_t i=0;i<vertices.size();++i) for (size_t j=i+1;j<vertices.size();++j) {
        const Edge e{vertices[i],vertices[j]};
        if (edges.count(e) || std::binary_search(foreign.begin(),foreign.end(),e)) continue;
        candidates.emplace_back(grid_length(point(mesh,e.first),point(mesh,e.second),h),e.first,e.second);
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
        const auto A=point(mesh,a),B=point(mesh,b);
        for (uint32_t c:vertices) {
            if (c==a || c==b) continue;
            const auto r=plane.at(mesh,c);
            if ((orient2(p,q,r)==0 && within(p,q,r)) || (avoid_near && near(A,B,point(mesh,c),h))) { ok=false; break; }
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
// The greedy, and if nearness left it without a valid triangulation, the
// greedy without the near rule (exact predicates and grid ranking only).
std::vector<Triangle> retriangulate(const AdapterMesh& mesh,const std::vector<Triangle>& face,
    const std::vector<Edge>& foreign,double h) {
    auto result=greedy(mesh,face,foreign,h,true);
    if (result.empty()) result=greedy(mesh,face,foreign,h,false);
    return result;
}
}

void canonical_planar_faces(AdapterMesh& mesh,const std::vector<bool>& planar_faces) {
    const size_t triangles=mesh.indices.size()/3;
    const double h=canonical_grid(mesh);
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
    // Every triangle edge use, minus both uses of each eligible face's
    // interior edges; sorted, so lookups are binary searches.
    std::vector<Edge> uses, interior;
    uses.reserve(3*triangles);
    for (size_t t=0;t<triangles;++t) for (unsigned k=0;k<3;++k)
        uses.push_back(edge(mesh.indices[3*t+k],mesh.indices[3*t+(k+1)%3]));
    std::vector<Edge> own;
    for (const auto& span:spans) if (span.eligible) {
        own.assign(uses.begin()+3*span.begin,uses.begin()+3*span.end);
        std::sort(own.begin(),own.end());
        for (size_t k=0;k+1<own.size();++k)
            if (own[k]==own[k+1] && (k+2>=own.size() || own[k+2]!=own[k]) && (k==0 || own[k-1]!=own[k])) {
                interior.push_back(own[k]); interior.push_back(own[k]);
            }
    }
    std::sort(uses.begin(),uses.end()); std::sort(interior.begin(),interior.end());
    std::vector<Edge> foreign;
    std::set_difference(uses.begin(),uses.end(),interior.begin(),interior.end(),std::back_inserter(foreign));
    foreign.erase(std::unique(foreign.begin(),foreign.end()),foreign.end());
    for (size_t i=0;i<spans.size();++i) {
        const auto& s=spans[i];
        if (!s.eligible) continue;
        std::vector<Triangle> face;
        for (size_t t=s.begin;t<s.end;++t) face.push_back(triangle(mesh,t));
        // This face's own boundary edges are in `foreign` too; they are never
        // candidates, so only other faces' edges can block a diagonal.
        const auto result=face.size()==2 ? requad(mesh,face[0],face[1],foreign,h) : retriangulate(mesh,face,foreign,h);
        if (!result.empty())
            for (size_t t=s.begin;t<s.end;++t) for (unsigned k=0;k<3;++k) mesh.indices[3*t+k]=result[t-s.begin][k];
    }
}
