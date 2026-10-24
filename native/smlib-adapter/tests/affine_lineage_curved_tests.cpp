// SPDX-License-Identifier: MPL-2.0
// #7955: rational cylinder side/cap correspondence, analytic gradients and volume.
#include "owned_lineage_access.hpp"
#include "representation_seal.hpp"
#include <SmFace.h>
#include <SmVertex.h>
#include <array>
#include <algorithm>
#include <cmath>
#include <map>
#include <stdexcept>
namespace {
using namespace face_lineage;
using V=std::array<double,3>; using M=std::array<double,16>;
void require(bool ok,const char* why) { if(!ok) throw std::runtime_error(why); }
V cross(V a,V b) { return {a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]}; }
double dot(V a,V b) { return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; }
V sub(V a,V b) { return {a[0]-b[0],a[1]-b[1],a[2]-b[2]}; }
struct Side { Identity root; int cap; }; // -1 is the curved wall; 0/1 are actual bottom/top planes.
std::vector<Side> source_sides(const OwnedBoundary& source) {
    SmTArray<SmFace*> faces; OwnedBoundaryTestAccess::solid(source).GetFaces(faces);
    std::vector<Side> sides;
    for(auto* face:faces) {
        SmTArray<SmVertex*> vertices; face->GetVertices(vertices);
        require(vertices.GetSize()>0,"cylinder source has real seam/cap vertices");
        double lo=1e100,hi=-1e100;
        for(auto* vertex:vertices) { const auto p=vertex->GetPoint(); lo=std::min(lo,p.z); hi=std::max(hi,p.z); }
        int cap=-1;
        if(std::abs(hi-lo)<1e-8) { require(std::abs(lo)<1e-8 || std::abs(lo-3)<1e-8,"source cylinder cap plane"); cap=lo<1?0:1; }
        else require(std::abs(lo)<1e-8 && std::abs(hi-3)<1e-8,"source cylinder lateral extent");
        for(auto side:sides) require(side.cap!=cap,"source physical cylinder faces have unique analytic roles");
        sides.push_back({OwnedBoundaryTestAccess::ledger(source).identity(face),cap});
    }
    require(sides.size()==3,"three original physical cylinder faces"); return sides;
}
void check(const OwnedBoundary& result,const M& m,const std::vector<Side>& sides) {
    const V a{m[0],m[1],m[2]},b{m[4],m[5],m[6]},c{m[8],m[9],m[10]},origin{m[12],m[13],m[14]};
    const auto x=cross(b,c),y=cross(c,a),z=cross(a,b); const auto det=dot(a,x);
    const auto ids=result.faces();
    for(double chord:{.001,.0005}) {
        auto mesh=result.tessellate(chord,5); double volume=0; std::vector<Identity> seen;
        std::map<std::pair<uint32_t,uint32_t>,std::pair<unsigned,int>> incidence;
        for(size_t t=0;t<mesh->provenance.triangles.size();++t) {
            const auto roots=result.ancestors(mesh->provenance.triangles[t]);
            require(roots.size()==1,"curved affine exact original ancestor set");
            auto side=std::find_if(sides.begin(),sides.end(),[&](auto s){return s.root==roots[0].identity;});
            require(side!=sides.end(),"curved affine does not issue new roots");
            if(std::find(seen.begin(),seen.end(),side->root)==seen.end()) seen.push_back(side->root);
            V p[3],normals[3];
            for(unsigned corner=0;corner<3;++corner) {
                const auto id=mesh->indices.at(3*t+corner);
                for(unsigned k=0;k<3;++k) p[corner][k]=mesh->positions.at(3*id+k);
                const auto q=sub(p[corner],origin);
                const V local{dot(q,x)/det,dot(q,y)/det,dot(q,z)/det}; V gradient{};
                if(side->cap<0) {
                    require(std::abs(local[0]*local[0]+local[1]*local[1]-4)<1e-6 && local[2]>=-1e-8 && local[2]<=3+1e-8,
                        "curved affine triangle lies on its original analytic cylinder face");
                    gradient={local[0],local[1],0};
                } else {
                    require(std::abs(local[2]-3*side->cap)<1e-7 && local[0]*local[0]+local[1]*local[1]<=4+1e-6,
                        "curved affine triangle lies on its original analytic cap");
                    gradient={0,0,side->cap?1.:-1.};
                }
                V normal{}; for(unsigned k=0;k<3;++k) normal[k]=(x[k]*gradient[0]+y[k]*gradient[1]+z[k]*gradient[2])/det;
                const auto length=std::sqrt(dot(normal,normal));
                for(unsigned k=0;k<3;++k) {
                    normals[corner][k]=normal[k]/length;
                    require(std::abs(mesh->normals.at(9*t+3*corner+k)-normals[corner][k])<1e-7,
                        "curved affine analytic inverse-transpose corner normal");
                }
                const auto next=mesh->indices.at(3*t+(corner+1)%3); auto& edge=incidence[std::minmax(id,next)];
                ++edge.first; edge.second+=id<next?1:-1;
            }
            const auto winding=cross(sub(p[1],p[0]),sub(p[2],p[0]));
            require(dot(winding,normals[0])>0,"curved affine source winding survives reflection");
            volume+=dot(sub(p[0],origin),cross(sub(p[1],origin),sub(p[2],origin)))/6;
        }
        const double expected=12*std::acos(-1.)*std::abs(det);
        require(std::abs(volume-expected)<expected*1e-3,"curved affine positive analytic signed volume");
        for(auto edge:incidence) require(edge.second.first==2 && edge.second.second==0,"curved affine closed oriented boundary");
        require(seen.size()==3 && result.faces()==ids,"curved affine ancestry survives retessellation");
    }
}
}
void run_affine_lineage_curved() {
    const M identity{1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1};
    for(const M& m:{identity,M{0,1,0,0,-1,0,0,0,0,0,1,0,7,-4,2,1},
        M{2,0,0,0,0,3,0,0,0,0,4,0,7,-4,2,1},
        M{2,0,0,0,.4,3,0,0,.2,.3,4,0,7,-4,2,1},
        M{-2,0,0,0,.4,3,0,0,.2,.3,4,0,7,-4,2,1}}) {
        auto source=OwnedBoundary::cylinder(2,3); auto sibling=source.copy(); const auto sides=source_sides(source);
        auto& ledger=const_cast<Ledger&>(OwnedBoundaryTestAccess::ledger(source));
        RepresentationSeal source_seal(ledger,const_cast<SmBrep&>(OwnedBoundaryTestAccess::solid(source)));
        RepresentationSeal sibling_seal(ledger,const_cast<SmBrep&>(OwnedBoundaryTestAccess::solid(sibling)));
        auto result=source.affine(m.data()); check(result,m,sides);
        auto copied=result.copy(); check(copied,m,sides);
        source_seal.verify(); sibling_seal.verify();
    }
}
