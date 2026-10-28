// SPDX-License-Identifier: MPL-2.0
// #7955: hand-derived mesh invariants, in the real SDK native/WASM executable.
#include "mesh_diagonals.hpp"
#include "mesh.hpp"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <map>

namespace {
using Point=std::array<double,3>;
using Edge=std::pair<uint32_t,uint32_t>;
void require(bool value,const char* message) {
    if (!value) { std::fprintf(stderr,"mesh diagonal FAIL: %s\n",message); std::exit(1); }
}
std::map<Edge,int> boundary(const AdapterMesh& mesh) {
    std::map<Edge,int> result;
    for (size_t i=0;i<mesh.indices.size();i+=3) for(unsigned k=0;k<3;++k) {
        const auto a=mesh.indices[i+k],b=mesh.indices[i+(k+1)%3];
        result[std::minmax(a,b)]+=a<b ? 1 : -1;
    }
    for (auto it=result.begin();it!=result.end();)
        if (!it->second) it=result.erase(it); else ++it;
    return result;
}
bool contains(const AdapterMesh& mesh,unsigned a,unsigned b) {
    for (size_t i=0;i<mesh.indices.size();i+=3) for (unsigned k=0;k<3;++k)
        if (std::minmax(mesh.indices[i+k],mesh.indices[i+(k+1)%3])==std::minmax(a,b)) return true;
    return false;
}
void verify(const std::array<Point,4>& points,unsigned expected_a,unsigned expected_b,
    bool both_inputs=true) {
    // Loop start, winding and starting diagonal must not affect this convex
    // pair's answer. Concave inputs test only their valid initial diagonal.
    for (unsigned start=0;start<4;++start) for(unsigned direction:{1u,3u}) {
        for(unsigned diagonal=0;diagonal<(both_inputs?2u:1u);++diagonal) {
            AdapterMesh mesh;
            for (const auto& p:points) mesh.positions.insert(mesh.positions.end(),p.begin(),p.end());
            std::array<uint32_t,4> ids{};
            for(unsigned i=0;i<4;++i) ids[i]=(start+direction*i)%4;
            if (!both_inputs) {
                while(ids[0]!=expected_a && ids[0]!=expected_b) std::rotate(ids.begin(),ids.begin()+1,ids.end());
            } else if(diagonal) std::rotate(ids.begin(),ids.begin()+1,ids.end());
            mesh.indices={ids[0],ids[1],ids[2],ids[0],ids[2],ids[3]};
            mesh.faces={7,7}; mesh.normals.resize(18);
            const auto before=boundary(mesh); const auto positions=mesh.positions;
            normalize_mesh_diagonals(mesh,5);
            require(mesh.positions==positions,"exact vertex coordinates preserved");
            require(mesh.faces==std::vector<uint32_t>({7,7}),"source attribution preserved");
            require(boundary(mesh)==before && before.size()==4,"oriented boundary preserved");
            require(mesh.indices.size()==6,"triangle count preserved");
            require(contains(mesh,expected_a,expected_b),"expected interior diagonal");
            const auto indices=mesh.indices;
            normalize_mesh_diagonals(mesh,5);
            require(mesh.indices==indices,"normalization idempotent");
        }
    }
}
}

void run_mesh_diagonals_tests() {
    // |A-C|²=5.0001, |B-D|²=5; both interior, normal spread below 5°.
    verify({{{0,0,0},{2,0,0},{2,1,0.01},{0,1,0}}},1,3);
    // A is concave. The shorter B-D must not cross the exterior; retain A-C.
    verify({{{0.2,0,0},{0,-1,0},{10,0,0.01},{0,1,0}}},0,2,false);
    // Actual SDK #55 cap, before its removal. Both platform triangulations
    // must normalize to B-D (squared length 9.0135364196 vs 9.0157549360).
    std::array<Point,4> cap{{
        {7.283199846221441,7.283199846221437,0},
        {7.365003019077327,7.20046738267606,-8.81802933255916e-16},
        {7.371412502696168,7.193905595369916,3.000000000000009},
        {7.283199846221442,7.283199846221437,3}}};
    verify(cap,1,3); cap[2][1]=std::nextafter(cap[2][1],8.0); verify(cap,1,3);
    AdapterMesh separate;
    separate.positions={0,0,0,2,0,0,2,1,0.01,0,1,0};
    separate.indices={0,1,2,0,2,3}; separate.faces={1,2}; separate.normals.resize(18);
    const auto indices=separate.indices;
    normalize_mesh_diagonals(separate,5);
    require(separate.indices==indices,"cannot flip across source face boundary");
    separate.faces={1,1}; separate.positions[8]=1;
    normalize_mesh_diagonals(separate,5);
    require(separate.indices==indices,"fold exceeds existing requested surface angle");
    separate.positions[8]=0;
    normalize_mesh_diagonals(separate,5);
    require(separate.indices==indices,"coplanar pair unchanged");
}
