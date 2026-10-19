// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "plane_interval.hpp"
#include <cstdint>
#include <cstring>
namespace plane_source_proof {
// Fixed-capacity exact sum of <= 16 products of finite binary64 operands.
// A binary64 is sign * mantissa * 2^exponent, exponent in [-1074,971].
// Products occupy bits [-2148,2047]; 136 base-2^32 limbs also hold 16
// carries above that range. No floating multiplication, heap, Boost or FMA.
class ProductSum {
    using Words=std::array<uint32_t,136>;
    Words positive{},negative{};
    unsigned terms=0;
    struct Binary { uint64_t mantissa; int exponent; bool negative; };
    static Binary unpack(double x) {
        plane_numeric::require(std::isfinite(x),"nonfinite exact source predicate");
        uint64_t bits=0; std::memcpy(&bits,&x,sizeof(bits));
        const auto e=unsigned((bits>>52)&2047);
        return {(bits&0xfffffffffffffULL)|(e?0x10000000000000ULL:0),
            e?int(e)-1075:-1074,bool(bits>>63)};
    }
    static void add_word(Words& words,unsigned index,uint64_t value) {
        while(value) {
            plane_numeric::require(index<words.size(),"exact source predicate overflow",IFCLITE_SMLIB_RESOURCE_LIMIT);
            const uint64_t sum=uint64_t(words[index])+uint32_t(value);
            words[index++]=uint32_t(sum); value=(value>>32)+(sum>>32);
        }
    }
public:
    void add(double a,double b,bool subtract=false) {
        plane_numeric::require(++terms<=16,"exact source predicate term budget",IFCLITE_SMLIB_RESOURCE_LIMIT);
        const auto x=unpack(a),y=unpack(b);
        auto& out=(x.negative^y.negative^subtract)?negative:positive;
        const unsigned shift=unsigned(x.exponent+y.exponent+2148);
        // Each partial 32x32 product fits uint64_t. Split before shifting;
        // otherwise a nonzero bit shift would discard the top product bits.
        for(unsigned i=0;i<2;++i) for(unsigned j=0;j<2;++j) {
            const uint64_t product=uint64_t(uint32_t(x.mantissa>>(32*i)))*uint32_t(y.mantissa>>(32*j));
            const unsigned index=shift/32+i+j,offset=shift%32;
            add_word(out,index,uint64_t(uint32_t(product))<<offset);
            add_word(out,index+1,(product>>32)<<offset);
        }
    }
    bool zero() const { return positive==negative; }
};
// q*(b-a) == c0*(b-t)+c1*(t-a), without rounded subtraction/division.
inline bool linear_value(double q,double c0,double c1,double a,double b,double t) {
    ProductSum s;
    s.add(q,b); s.add(q,a,true); s.add(c0,b,true);
    s.add(c0,t); s.add(c1,t,true); s.add(c1,a);
    return s.zero();
}
inline bool canonical_value(double q,double origin,double scale,double axis,double t) {
    plane_numeric::require(axis==0 || axis==1 || axis==-1,"nonaxis canonical line");
    ProductSum s; s.add(q,1); s.add(origin,1,true);
    s.add(t,axis==0?0:scale,axis>0); // subtract t*scale*axis
    return s.zero();
}
}
