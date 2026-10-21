// SPDX-License-Identifier: MPL-2.0
#pragma once
#include <SmBSplineCurve.h>
#include <SmSurfOfExtrusion.h>
#include <algorithm>
#include <cmath>

// Certify the complete rational extrusion, not just selected surface samples.
// Positive weights make every generator point a convex combination of its
// Cartesian control points. If those points lie in a plane parallel to the
// extrusion vector, the entire swept surface lies in that plane too.
// SmSurface::IsPlanar is unsuitable here: its default bounding-box expansion
// can give a mathematically planar general extrusion nonzero thickness.
inline bool planar_extrusion(const SmSurfOfExtrusion& surface, double tolerance,
    double& control_deviation, double& sample_deviation) {
    control_deviation=sample_deviation=0;
    const auto* curve=surface.GetGenCurve();
    if(!curve)return false;
    SmTArray<SmPoint3d> points;
    SmTArray<double> weights;
    if(curve->GetControlPolygon(points,weights)!=SM_SUCCESS || points.GetSize()<2 ||
        (weights.GetSize()!=0 && weights.GetSize()!=points.GetSize()))return false;
    for(ULONG i=0;i<weights.GetSize();++i)
        if(!std::isfinite(weights[i]) || weights[i]<=0)return false;
    const auto sweep=surface.GetExtrusionVector();
    const auto origin=points[0];
    SmVector3d normal(0,0,0);
    double norm=0;
    for(ULONG i=1;i<points.GetSize();++i) {
        const auto p=points[i];
        const double x=p.x-origin.x,y=p.y-origin.y,z=p.z-origin.z;
        const SmVector3d candidate(y*sweep.z-z*sweep.y,
            z*sweep.x-x*sweep.z,x*sweep.y-y*sweep.x);
        const double length=std::hypot(std::hypot(candidate.x,candidate.y),candidate.z);
        if(length>norm) { normal=candidate;norm=length; }
    }
    if(!std::isfinite(norm) || norm<=0)return false;
    normal=SmVector3d(normal.x/norm,normal.y/norm,normal.z/norm);
    auto deviation=[&](const SmPoint3d& p) {
        return std::abs((p.x-origin.x)*normal.x+(p.y-origin.y)*normal.y+(p.z-origin.z)*normal.z);
    };
    for(ULONG i=0;i<points.GetSize();++i) {
        const double distance=deviation(points[i]);
        if(!std::isfinite(distance))return false;
        control_deviation=std::max(control_deviation,distance);
    }
    if(control_deviation>tolerance)return false;
    const auto domain=surface.GetNaturalUVDomain();
    // Include the whole finite extrusion interval in the bound, including
    // floating-point residual from constructing its perpendicular normal.
    const auto interval=surface.GetSTEPUVDomain().GetVInterval();
    const double sweep_deviation=std::abs(sweep.x*normal.x+sweep.y*normal.y+sweep.z*normal.z)*
        std::max(std::abs(interval.GetMin()),std::abs(interval.GetMax()));
    if(!std::isfinite(sweep_deviation) || control_deviation+sweep_deviation>tolerance)return false;
    for(double u:{0.,0.25,0.5,0.75,1.})for(double v:{0.,0.25,0.5,0.75,1.}) {
        SmPoint3d p;
        if(surface.EvaluatePoint(SmPoint2d(domain.GetUInterval().Evaluate(u),
            domain.GetVInterval().Evaluate(v)),p)!=SM_SUCCESS)return false;
        const double distance=deviation(p);
        if(!std::isfinite(distance))return false;
        sample_deviation=std::max(sample_deviation,distance);
    }
    return sample_deviation<=tolerance;
}
