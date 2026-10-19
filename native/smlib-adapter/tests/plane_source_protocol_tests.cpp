// SPDX-License-Identifier: MPL-2.0
// Actual SDK C ABI/protocol agreement, UNRUN until parent-admitted execution.
#include "ifclite_smlib.h"
#include "protocol.h"
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
namespace {
void demand(bool value,const char* message) {
    if(!value) { std::fprintf(stderr,"rectangle wire FAIL: %s\n",message); std::exit(1); }
}
struct Reader {
    const std::vector<uint8_t>& data; size_t cursor=0;
    uint32_t u32() {
        demand(cursor+4<=data.size(),"bounded u32 read"); uint32_t result=0;
        for(unsigned i=0;i<4;++i) result|=uint32_t(data[cursor++])<<(8*i); return result;
    }
    uint64_t u64() { const auto lo=u32(); return uint64_t(lo)|(uint64_t(u32())<<32); }
    double f64() { const auto bits=u64(); double result; std::memcpy(&result,&bits,8); return result; }
    ifclite_smlib_handle handle() { const auto session=u64(); const auto slot=u32(); return {session,slot,u32()}; }
    void integer(uint32_t expected) { demand(u32()==expected,"actual fixed-width integer field"); }
    void real(double expected) { const auto value=f64(); demand(std::memcmp(&value,&expected,8)==0,"actual coefficient bits, including nonrational sentinel"); }
    template<size_t N> void reals(const double (&expected)[N]) { for(double value:expected) real(value); }
};
void rectangle(Reader& reader,const ifclite_smlib_rectangle_domain& r) {
    const auto begin=reader.cursor;
    for(uint32_t value:{r.version,r.source_face,r.u_axis,r.v_axis,r.normal_axis,r.loops,r.holes,
        r.edge_count,r.control_count,r.flags,r.reserved0,r.reserved1}) reader.integer(value);
    reader.reals(r.controls); reader.reals(r.u); reader.reals(r.v); reader.reals(r.bounds);
    reader.reals(r.uv_hull); reader.reals(r.inverse);
    for(const auto& e:r.edges) {
        const auto edge_begin=reader.cursor;
        reader.integer(e.flags); reader.integer(e.start_corner); reader.integer(e.end_corner); reader.integer(e.reserved);
        reader.reals(e.controls); reader.reals(e.knots); reader.reals(e.interval);
        reader.reals(e.start); reader.reals(e.end); reader.reals(e.line_origin); reader.reals(e.line_axis);
        reader.reals(e.step); reader.real(e.scale);
        demand(reader.cursor-edge_begin==248,"exact 248-byte edge wire contract");
    }
    demand(reader.cursor-begin==1376,"exact 1376-byte rectangle wire contract");
}
}
void run_plane_source_protocol_tests(uint64_t session,ifclite_smlib_handle input,
    const double* plane,const ifclite_smlib_plane_certificate& expected) {
    demand(expected.version==2 && (expected.method&8) && expected.rectangle_count>0,"actual derived C ABI certificate");
    std::vector<uint8_t> request;
    auto u32=[&](uint32_t value) { for(unsigned i=0;i<4;++i) request.push_back(uint8_t(value>>(8*i))); };
    auto u64=[&](uint64_t value) { u32(uint32_t(value)); u32(uint32_t(value>>32)); };
    u32(1); u32(5891); u32(20); u64(session); u64(input.session); u32(input.slot); u32(input.generation);
    for(unsigned i=0;i<6;++i) { uint64_t bits; std::memcpy(&bits,plane+i,8); u64(bits); } u32(1); u32(2);
    const auto response=ifclite_smlib_dispatch(request); Reader reader{response};
    reader.integer(1); reader.integer(5891); reader.integer(0); const auto output=reader.handle();
    reader.integer(2); reader.integer(expected.method); reader.integer(1); reader.integer(0);
    const auto bound_input=reader.handle(),bound_output=reader.handle();
    demand(bound_input.session==input.session && bound_input.slot==input.slot && bound_input.generation==input.generation &&
        bound_output.session==output.session && bound_output.slot==output.slot && bound_output.generation==output.generation,
        "records bound to actual operation handles, not ancestry");
    reader.integer(1); reader.integer(2); reader.integer(expected.faces); reader.integer(expected.edges); reader.integer(expected.coefficients);
    for(unsigned i=0;i<6;++i) reader.real(plane[i]);
    reader.reals(expected.basis); reader.reals(expected.domain); reader.reals(expected.cutter); reader.real(expected.clearance);
    reader.integer(expected.cylinder_count);
    for(unsigned i=0;i<expected.cylinder_count;++i) {
        const auto& c=expected.cylinders[i];
        reader.integer(c.source_face); reader.integer(c.swap_uv); reader.integer(c.inside_out); reader.integer(c.reserved);
        reader.reals(c.origin); reader.reals(c.basis); reader.real(c.radius); reader.reals(c.step_v);
    }
    reader.integer(expected.rectangle_count); reader.integer(1376); reader.integer(248); reader.integer(0);
    for(unsigned i=0;i<expected.rectangle_count;++i) rectangle(reader,expected.rectangles[i]);
    demand(reader.cursor==response.size() && response.size()==324+136*expected.cylinder_count+16+1376*expected.rectangle_count,
        "version2 extension exactly follows unchanged v1 prefix and cylinder records");
    double volume=0; uint32_t manifold=0;
    demand(ifclite_smlib_volume(session,output,1e-8,&volume)==0 && std::abs(volume-3)<1e-4 &&
        ifclite_smlib_manifold(session,output,&manifold)==0 && manifold==1,"actual protocol output retains analytical geometry and topology");
    demand(ifclite_smlib_release(session,output)==0,"release independent protocol result");
}
