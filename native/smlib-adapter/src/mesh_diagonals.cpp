// SPDX-License-Identifier: MPL-2.0
#include "mesh_diagonals.hpp"
#include "mesh.hpp"
#include <SmPoly.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <map>
#include <set>

namespace {
using Edge=std::pair<uint32_t,uint32_t>;
using Triangle=std::array<uint32_t,3>;
Edge edge(uint32_t a,uint32_t b) { return std::minmax(a,b); }
Triangle triangle(const AdapterMesh& mesh,uint32_t id) {
    return {mesh.indices[3*id],mesh.indices[3*id+1],mesh.indices[3*id+2]};
}
SmPoint3d point(const AdapterMesh& mesh,uint32_t id) {
    return {mesh.positions[3*id],mesh.positions[3*id+1],mesh.positions[3*id+2]};
}
SmVector3d normal(const AdapterMesh& mesh,const Triangle& t) {
    return (point(mesh,t[1])-point(mesh,t[0]))*(point(mesh,t[2])-point(mesh,t[0]));
}
void replace(AdapterMesh& mesh,uint32_t id,const Triangle& t) {
    const auto n=normal(mesh,t); const double length=std::hypot(n.x,n.y,n.z);
    if (!(length>0) || !std::isfinite(length))
        throw AdapterMeshFailure{"diagonal normalization produced degenerate triangle"};
    for (unsigned i=0;i<3;++i) {
        mesh.indices[3*id+i]=t[i];
        mesh.normals[9*id+3*i]=n.x/length;
        mesh.normals[9*id+3*i+1]=n.y/length;
        mesh.normals[9*id+3*i+2]=n.z/length;
    }
}
}

void normalize_mesh_diagonals(AdapterMesh& mesh) {
    // #7955: the SDK triangulates surface polygons before SmApiTessellate
    // returns. Its aspect-ratio ties can choose different diagonals for a
    // warped quad on native/WASM. A strictly shorter interior diagonal gives
    // both targets the same choice for that ambiguity. No frame or tolerance
    // is introduced; all positions and source-face IDs remain untouched.
    std::map<Edge,std::set<uint32_t>> adjacent;
    std::set<Edge> pending;
    const auto count=uint32_t(mesh.indices.size()/3);
    auto insert=[&](uint32_t id) {
        const auto t=triangle(mesh,id);
        for (unsigned i=0;i<3;++i) {
            const auto key=edge(t[i],t[(i+1)%3]);
            adjacent[key].insert(id); pending.insert(key);
        }
    };
    auto erase=[&](uint32_t id) {
        const auto t=triangle(mesh,id);
        for (unsigned i=0;i<3;++i) {
            const auto key=edge(t[i],t[(i+1)%3]);
            auto found=adjacent.find(key);
            found->second.erase(id);
            if (found->second.empty()) adjacent.erase(found);
        }
    };
    for (uint32_t i=0;i<count;++i) insert(i);
    // Every flip strictly decreases the sum of squared edge lengths. Bound
    // work as well: file-supplied topology must not create an unbounded walk.
    size_t budget=size_t(count)*24;
    while (!pending.empty()) {
        if (!budget--) throw AdapterMeshFailure{"diagonal normalization work budget exceeded"};
        const auto key=*pending.begin(); pending.erase(pending.begin());
        auto found=adjacent.find(key);
        if (found==adjacent.end() || found->second.size()!=2) continue;
        auto it=found->second.begin(); const uint32_t first=*it++,second=*it;
        if (mesh.faces[first]!=mesh.faces[second]) continue;
        auto a=triangle(mesh,first),b=triangle(mesh,second);
        unsigned i=0;
        while (i<3 && edge(a[i],a[(i+1)%3])!=key) ++i;
        const uint32_t u=a[i],v=a[(i+1)%3],p=a[(i+2)%3];
        unsigned j=0;
        while (j<3 && !(b[j]==v && b[(j+1)%3]==u)) ++j;
        if (j==3) continue; // inconsistent winding is not repaired here
        const uint32_t q=b[(j+2)%3];
        if (p==q || adjacent.count(edge(p,q))) continue;
        const auto U=point(mesh,u),V=point(mesh,v),P=point(mesh,p),Q=point(mesh,q);
        const double old_length=U.DistanceBetweenSquared(V),new_length=P.DistanceBetweenSquared(Q);
        if (!std::isfinite(new_length) || !(new_length>0 && new_length<old_length)) continue;
        const auto n=normal(mesh,a)+normal(mesh,b);
        // A coplanar pair has identical volume for either diagonal. Preserve
        // it. For warped pairs require all four boundary turns to agree with
        // the area normal: both diagonals are interior to the convex quad.
        // Cross/dot products use the SDK's object-space vectors, not a frame.
        if (((V-U)*(P-U)).Dot(Q-U)==0) continue;
        const std::array<SmPoint3d,4> loop{U,Q,V,P};
        bool convex=true;
        for (unsigned k=0;k<4;++k)
            convex &= ((loop[(k+1)%4]-loop[k])*(loop[(k+2)%4]-loop[(k+1)%4])).Dot(n)>0;
        const Triangle left{p,q,v},right{q,p,u};
        if (!convex || !(normal(mesh,left).Dot(n)>0 && normal(mesh,right).Dot(n)>0)) continue;
        erase(first); erase(second);
        replace(mesh,first,left); replace(mesh,second,right);
        insert(first); insert(second);
    }
}
