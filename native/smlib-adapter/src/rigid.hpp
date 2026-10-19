// SPDX-License-Identifier: MPL-2.0
#pragma once
#include <SmAxis2Placement.h>
#include "sweep.hpp"
#include "ifclite_smlib.h"
#include <cmath>
inline SmAxis2Placement numerical_rigid_frame(const double* m) {
    auto require=[](bool valid) { if(!valid) throw SweepFailure{
        IFCLITE_SMLIB_INVALID_ARGUMENT,"expected finite affine positive rigid transform"}; };
    require(m!=nullptr);
    for(unsigned i=0;i<16;++i) require(std::isfinite(m[i]) && std::abs(m[i])<=1e9);
    require(m[3]==0 && m[7]==0 && m[11]==0 && m[15]==1);
    for(unsigned a=0;a<3;++a) for(unsigned b=a;b<3;++b) {
        double dot=0; for(unsigned j=0;j<3;++j) dot+=m[4*a+j]*m[4*b+j];
        require(std::abs(dot-(a==b?1.:0.))<=1e-12);
    }
    for(unsigned j=0;j<3;++j) require(std::abs(m[8+j]-
        (m[(j+1)%3]*m[4+(j+2)%3]-m[(j+2)%3]*m[4+(j+1)%3]))<=1e-12);
    const double determinant=m[8]*(m[1]*m[6]-m[2]*m[5])+
        m[9]*(m[2]*m[4]-m[0]*m[6])+m[10]*(m[0]*m[5]-m[1]*m[4]);
    require(std::abs(determinant-1)<=1e-12);
    SmAxis2Placement frame;
    require(frame.SetCanonical(SmPoint3d(m[12],m[13],m[14]),
        SmVector3d(m[0],m[1],m[2]),SmVector3d(m[4],m[5],m[6]))==SM_SUCCESS);
    return frame;
}
