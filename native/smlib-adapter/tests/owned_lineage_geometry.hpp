// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "owned_lineage_access.hpp"
#include <SmFace.h>
#include <SmVertex.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <stdexcept>
// #7955 J5-STATIC-03: identity keyed by actual source face vertices BEFORE
// tessellation/copy. Neither face-array order nor mesh attribution is an oracle.
namespace owned_geometry {
using namespace face_lineage;
struct FaceBox { Identity root; std::array<double,3> lo,hi; };
inline void require(bool ok,const char* why) { if(!ok) throw std::runtime_error(why); }
inline std::vector<FaceBox> source_faces(const OwnedBoundary& owner) {
    SmTArray<SmFace*> faces; OwnedBoundaryTestAccess::solid(owner).GetFaces(faces);
    std::vector<FaceBox> result;
    for(auto* face:faces) {
        SmTArray<SmVertex*> vertices; face->GetVertices(vertices);
        require(vertices.GetSize()==4,"asymmetric box face has four source corners");
        FaceBox record{OwnedBoundaryTestAccess::ledger(owner).identity(face),
            {INFINITY,INFINITY,INFINITY},{-INFINITY,-INFINITY,-INFINITY}};
        for(auto* vertex:vertices) {
            const auto p=vertex->GetPoint(); const double xyz[]={p.x,p.y,p.z};
            for(unsigned axis=0;axis<3;++axis) {
                require(std::isfinite(xyz[axis]),"finite source face geometry");
                record.lo[axis]=std::min(record.lo[axis],xyz[axis]);
                record.hi[axis]=std::max(record.hi[axis],xyz[axis]);
            }
        }
        unsigned fixed=0; const double spans[]={2,3,4};
        for(unsigned axis=0;axis<3;++axis) {
            const auto span=record.hi[axis]-record.lo[axis];
            if(std::abs(span)<=1e-8) ++fixed;
            else require(std::abs(span-spans[axis])<=1e-8,"source rectangle spans asymmetric constructor dimensions");
        }
        require(fixed==1,"source face has one unique supporting coordinate plane");
        for(const auto& previous:result)
            require(previous.lo!=record.lo || previous.hi!=record.hi,"source face geometry uniquely identifies six physical sides");
        result.push_back(record);
    }
    require(result.size()==6,"six independently measured source sides");
    return result;
}
inline void check_triangle(const AdapterMesh& mesh,size_t triangle,const OwnedBoundary& owner,
                           const std::vector<FaceBox>& source) {
    const auto roots=owner.ancestors(mesh.provenance.triangles.at(triangle));
    require(roots.size()==1,"triangle has one constructor root");
    const auto found=std::find_if(source.begin(),source.end(),[&](const FaceBox& face) {
        return face.root==roots[0].identity;
    });
    require(found!=source.end(),"triangle root identifies an independently measured source face");
    for(size_t corner=0;corner<3;++corner) {
        const auto vertex=mesh.indices.at(3*triangle+corner);
        for(size_t axis=0;axis<3;++axis) {
            const double value=mesh.positions.at(3*size_t(vertex)+axis);
            require(std::isfinite(value) && value>=found->lo[axis]-1e-8 && value<=found->hi[axis]+1e-8,
                "triangle geometry agrees with claimed source face root");
        }
    }
}
}
