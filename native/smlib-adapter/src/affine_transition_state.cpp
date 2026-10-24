// SPDX-License-Identifier: MPL-2.0
#include "affine_transition_detail.hpp"
#include <SmBSplineCurve.h>
#include <SmBSplineSurface.h>
#include <SmEdgeuse.h>
#include <SmEdge.h>
#include <SmFaceuse.h>
#include <SmShell.h>
namespace face_lineage {
using namespace affine_detail;
void AffineTransition::capture() {
    objects=seal->pending; require(objects.size()<=8192,"affine exact graph object bound");
    SmTArray<SmTopology*> order; working.GetTopology(order);
    for(auto* item:order) topology_order.push_back(item);
    size_t words=0;
    for(auto* object:objects) {
        if(object->IsKindOf(SmTopology_TYPE)) {
            auto* t=static_cast<SmTopology*>(object); Link link;
            link.owner=link.expected_owner=t->GetOwner(); link.next=link.expected_next=t->GetNext();
            link.last=link.expected_last=t->GetLast();
            if(auto* owning=dynamic_cast<SmOwningTopology*>(t)) {
                link.head=link.expected_head=owning->GetList(); auto* child=owning->GetList();
                require(owning->GetSize()<=8192,"affine owning-list bound");
                for(ULONG i=0;i<owning->GetSize();++i) {
                    require(child && child->GetOwner()==owning && (!i || child!=owning->GetList()),"affine circular list ownership");
                    link.children.push_back(child); child=child->GetNext();
                }
                require(!owning->GetSize() || child==owning->GetList(),"affine circular list closure");
                link.expected_children=link.children;
            }
            if(t->GetType()==SmEdgeuse_TYPE) link.radial=link.expected_radial=static_cast<SmEdgeuse*>(t)->GetRadial();
            if(t->GetType()==SmFace_TYPE) link.rectangular=link.expected_rectangular=static_cast<SmFace*>(t)->GetRectangularTrim();
            if(t->GetType()==SmVertex_TYPE) {
                link.point=link.expected_point=static_cast<SmVertex*>(t)->GetPoint();
                link.magnitude=SmPoint3d(std::abs(link.point.x),std::abs(link.point.y),std::abs(link.point.z));
            }
            links.emplace(t,std::move(link)); continue;
        }
        ULONG n=0; double* data=nullptr; Controls record;
        if(object->IsKindOf(SmCurve_TYPE)) {
            require(object->GetType()==SmBSplineCurve_TYPE || object->GetType()==SmLine_TYPE,"affine canonical curve class");
            auto* curve=static_cast<SmBSplineCurve*>(object); record.dimension=curve->GetDim();
            if(record.dimension==3) require(object->GetType()==SmBSplineCurve_TYPE,"owned affine requires pre-issuance rational normalization");
            checked(curve->GetControlPointsPointer(n,data));
        } else {
            require(object->GetType()==SmBSplineSurface_TYPE,"owned affine requires pre-issuance rational surface normalization");
            ULONG nu=0,nv=0; checked(static_cast<SmBSplineSurface*>(object)->GetControlPointsPointer(nu,nv,data));
            require(nu && nv && nu<=16384/nv,"affine surface control budget"); n=nu*nv;
        }
        require(n && n<=16384 && data && words+4*n<=1048576,"affine total control budget"); words+=4*n;
        record.original.assign(data,data+4*n); record.expected=record.original;
        for(auto value:record.original) record.magnitude.push_back(std::abs(value));
        controls.emplace(object,std::move(record));
    }
}
void AffineTransition::order_topology(SmTArray<SmTopology*>& actual) const {
    require(actual.GetSize()==topology_order.size(),"affine topology inventory changed");
    for(auto* expected:topology_order) {
        unsigned hits=0; for(auto* item:actual) hits+=item==expected;
        require(hits==1,"affine physical topology inventory is not bijective");
    }
    for(size_t i=0;i<topology_order.size();++i) actual[ULONG(i)]=topology_order[i];
}
SmObject* AffineTransition::owner(SmTopology* t) const { return links.at(t).owner; }
SmTopology* AffineTransition::next(SmTopology* t) const { return links.at(t).next; }
SmTopology* AffineTransition::last(SmTopology* t) const { return links.at(t).last; }
SmTopology* AffineTransition::head(SmTopology* t) const { return links.at(t).head; }
SmEdgeuse* AffineTransition::radial(SmEdgeuse* t) const { return links.at(t).radial; }
SmBoolean AffineTransition::rectangular(SmFace* t) const { return links.at(t).rectangular; }
SmPoint3d AffineTransition::vertex(SmVertex* t) const { return links.at(t).point; }
double AffineTransition::control(SmObject* object,size_t i,double actual) const {
    const auto& record=controls.at(object);
    require(i<record.expected.size(),"affine coefficient support changed");
    if(record.dimension!=3 || i%4==3) return actual; // Exact original UVs and weights, never projected.
    near(actual,record.expected[i],record.magnitude[i]); return record.original[i];
}
void AffineTransition::verify_target() {
    ledger.verify_inventory(working);
    for(const auto& pair:links) {
        auto* t=pair.first; const auto& l=pair.second;
        require(t->GetBrep()==&working && t->GetOwner()==l.expected_owner && t->GetNext()==l.expected_next &&
            t->GetLast()==l.expected_last,"affine unexpected topology ownership or ring edit");
        if(auto* owning=dynamic_cast<SmOwningTopology*>(t))
            require(owning->GetList()==l.expected_head && owning->GetSize()==l.expected_children.size(),"affine unexpected owning-list head or size");
        if(t->GetType()==SmEdgeuse_TYPE)
            require(static_cast<SmEdgeuse*>(t)->GetRadial()==l.expected_radial,"affine unexpected reflected radial link");
        if(t->GetType()==SmFace_TYPE)
            require(static_cast<SmFace*>(t)->GetRectangularTrim()==l.expected_rectangular,"affine unexpected face trim flag");
        if(t->GetType()==SmVertex_TYPE) {
            const auto p=static_cast<SmVertex*>(t)->GetPoint();
            for(unsigned k=0;k<3;++k) near(p[k],l.expected_point[k],l.magnitude[k]);
        }
    }
    // This still compares all unprojected knots, weights, UV coefficients,
    // parameter bounds, tolerances, attributes, flags and incidence exactly.
    seal->verify();
}
void AffineTransition::predict(const SmAxis2Placement& placement,const SmVector3d* scale) {
    if(placement.IsIdentity() && (!scale || *scale==SmVector3d(1,1,1))) return;
    const auto x=placement.GetXAxis(),y=placement.GetYAxis(),z=placement.GetZAxis();
    const auto origin=placement.GetOrigin();
    const SmVector3d s=scale?*scale:SmVector3d(1,1,1);
    double a[3][3]{}; for(unsigned r=0;r<3;++r) { a[r][0]=x[r]*s.x; a[r][1]=y[r]*s.y; a[r][2]=z[r]*s.z; }
    auto transform=[&](SmPoint3d p,SmPoint3d magnitude,double weight) {
        SmPoint3d out,bound;
        for(unsigned r=0;r<3;++r) {
            out[r]=origin[r]*weight; bound[r]=std::abs(origin[r]*weight);
            for(unsigned c=0;c<3;++c) { out[r]+=a[r][c]*p[c]; bound[r]+=std::abs(a[r][c])*magnitude[c]; }
        }
        return std::make_pair(out,bound);
    };
    for(auto& pair:links) {
        auto* t=pair.first; auto& link=pair.second;
        if(t->GetType()==SmVertex_TYPE) {
            auto value=transform(link.expected_point,link.magnitude,1.); link.expected_point=value.first; link.magnitude=value.second;
        }
        if(t->GetType()==SmFace_TYPE && link.expected_rectangular!=TRUE) link.expected_rectangular=UNSURE;
    }
    for(auto& pair:controls) {
        auto& c=pair.second; if(c.dimension!=3) continue;
        for(size_t i=0;i<c.expected.size();i+=4) {
            const double weight=c.expected[i+3]==NL_NOW?1.:c.expected[i+3];
            require(std::isfinite(weight) && weight!=0,"affine rational weight must be finite nonzero");
            auto value=transform(SmPoint3d(c.expected[i],c.expected[i+1],c.expected[i+2]),
                SmPoint3d(c.magnitude[i],c.magnitude[i+1],c.magnitude[i+2]),weight);
            for(unsigned k=0;k<3;++k) { c.expected[i+k]=value.first[k]; c.magnitude[i+k]=value.second[k]; }
        }
    }
    if(scale && ((scale->x<0)^(scale->y<0)^(scale->z<0))) reflect();
}
void AffineTransition::materialize_links() {
    for(auto& pair:links) {
        auto* owner=dynamic_cast<SmOwningTopology*>(pair.first); if(!owner) continue;
        auto& l=pair.second; const auto& children=l.expected_children;
        l.expected_head=children.empty()?nullptr:children.front();
        for(size_t i=0;i<children.size();++i) {
            auto& child=links.at(children[i]); child.expected_owner=owner;
            child.expected_next=children[(i+1)%children.size()]; child.expected_last=children[(i+children.size()-1)%children.size()];
        }
    }
    for(auto& pair:links) if(pair.first->GetType()==SmEdgeuse_TYPE) {
        auto* use=static_cast<SmEdgeuse*>(pair.first); auto& l=pair.second;
        auto* first=static_cast<SmEdgeuse*>(links.at(use->GetEdge()).expected_head);
        require(first && use->IsLoopEdgeuse(),"affine reflection requires complete loop edgeuses");
        l.expected_radial=static_cast<SmEdgeuse*>(first->GetOrientation()==use->GetOrientation()?l.expected_last:l.expected_next);
    }
}
void AffineTransition::reflect() {
    // Exact SDK c9c5979 Remove/PostInsert model, including the list head.
    SmTArray<SmEdge*> edges; working.GetEdges(edges);
    for(auto* edge:edges) {
        auto& ring=links.at(edge).expected_children;
        require(!ring.empty() && ring.size()%2==0,"affine reflection requires radial edgeuse pairs");
        for(size_t i=0;i<ring.size();i+=2) std::swap(ring[i],ring[i+1]);
    }
    SmTArray<SmFace*> actual; working.GetFaces(actual);
    for(auto* face:actual) {
        SmFaceuse *first=nullptr,*second=nullptr; face->GetFaceuses(first,second);
        require(first && second,"affine reflection requires reciprocal faceuses");
        auto* a=static_cast<SmShell*>(links.at(first).expected_owner);
        auto* b=static_cast<SmShell*>(links.at(second).expected_owner);
        if(a==b) continue;
        auto remove=[&](SmShell* owner,SmTopology* item) {
            auto& list=links.at(owner).expected_children; auto it=std::find(list.begin(),list.end(),item);
            require(it!=list.end(),"affine reflection missing exact original shell member"); list.erase(it);
        };
        remove(a,first); remove(b,second);
        links.at(a).expected_children.push_back(second); links.at(b).expected_children.push_back(first);
    }
    materialize_links();
}
}
