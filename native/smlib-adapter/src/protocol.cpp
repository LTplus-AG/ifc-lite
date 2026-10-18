// SPDX-License-Identifier: MPL-2.0
#include "protocol.h"
#include "ifclite_smlib.h"
#include <array>
#include <cstring>
#include <stdexcept>
namespace {
constexpr uint32_t version = 1;
struct Reader {
    const std::vector<uint8_t>& bytes;
    size_t offset = 0;
    uint32_t u32() {
        if (bytes.size() - offset < 4) throw std::runtime_error("short field");
        uint32_t value = 0;
        for (unsigned i = 0; i < 4; ++i) value |= uint32_t(bytes[offset++]) << (8*i);
        return value;
    }
    uint64_t u64() { const uint64_t lo = u32(); return lo | (uint64_t(u32()) << 32); }
    double f64() {
        const uint64_t bits = u64(); double value; std::memcpy(&value,&bits,8); return value;
    }
    ifclite_smlib_handle handle() { return {u64(),u32(),u32()}; }
    void end() { if (offset != bytes.size()) throw std::runtime_error("trailing fields"); }
};
struct Writer {
    std::vector<uint8_t> bytes;
    void u32(uint32_t value) {
        for (unsigned i = 0; i < 4; ++i) bytes.push_back(uint8_t(value >> (8*i)));
    }
    void u64(uint64_t value) { u32(uint32_t(value)); u32(uint32_t(value >> 32)); }
    void f64(double value) { uint64_t bits; std::memcpy(&bits,&value,8); u64(bits); }
    void handle(ifclite_smlib_handle value) { u64(value.session); u32(value.slot); u32(value.generation); }
};
Writer dispatch(Reader& reader) {
    if (reader.u32() != version) throw std::runtime_error("unsupported protocol version");
    const uint32_t id = reader.u32(), operation = reader.u32();
    Writer payload;
    int32_t status = IFCLITE_SMLIB_OK;
    if (operation == 0) {
        reader.end(); payload.u32(ifclite_smlib_abi_version());
    } else if (operation == 1) {
        reader.end(); uint64_t session = 0;
        status = ifclite_smlib_session_create(&session); payload.u64(session);
    } else {
        const uint64_t session = reader.u64();
        switch (operation) {
        case 2:
            reader.end(); status = ifclite_smlib_session_destroy(session); break;
        case 3: {
            const double x = reader.f64(), y = reader.f64(), z = reader.f64();
            const double width = reader.f64(), depth = reader.f64(), height = reader.f64();
            reader.end(); ifclite_smlib_handle solid{};
            status = ifclite_smlib_box(session,x,y,z,width,depth,height,&solid);
            payload.handle(solid); break;
        }
        case 4: {
            const double x = reader.f64(), y = reader.f64(), z = reader.f64();
            const double radius = reader.f64(), height = reader.f64();
            reader.end(); ifclite_smlib_handle solid{};
            status = ifclite_smlib_cylinder(session,x,y,z,radius,height,&solid);
            payload.handle(solid); break;
        }
        case 5: {
            const auto a = reader.handle(), b = reader.handle(); const uint32_t op = reader.u32();
            reader.end(); ifclite_smlib_handle solid{};
            status = ifclite_smlib_boolean(session,a,b,op,&solid); payload.handle(solid); break;
        }
        case 6: {
            const auto solid = reader.handle(); const double tolerance = reader.f64();
            reader.end(); double value = 0;
            status = ifclite_smlib_volume(session,solid,tolerance,&value); payload.f64(value); break;
        }
        case 7: {
            const auto solid = reader.handle(); reader.end(); uint32_t value = 0;
            status = ifclite_smlib_manifold(session,solid,&value); payload.u32(value); break;
        }
        case 8: {
            const auto solid = reader.handle(); reader.end();
            status = ifclite_smlib_release(session,solid); break;
        }
        case 9: {
            const auto solid=reader.handle(); const double chord=reader.f64(), angle=reader.f64();
            reader.end(); ifclite_smlib_handle mesh{};
            status=ifclite_smlib_tessellate(session,solid,chord,angle,&mesh);
            payload.handle(mesh); break;
        }
        case 10: {
            const auto mesh=reader.handle(); reader.end(); ifclite_smlib_mesh_info info{};
            status=ifclite_smlib_mesh_get_info(session,mesh,&info);
            payload.u32(info.vertex_count); payload.u32(info.triangle_count);
            payload.u32(info.source_face_count); payload.u32(info.boundary_edges);
            payload.u32(info.spine_edges); payload.u32(info.failed_faces); break;
        }
        case 11: {
            const auto mesh=reader.handle(); const uint32_t stream=reader.u32();
            const uint32_t offset=reader.u32(), count=reader.u32(); reader.end();
            std::array<uint8_t,3840> buffer{};
            status=ifclite_smlib_mesh_copy(session,mesh,stream,offset,count,buffer.data(),buffer.size());
            if (status == IFCLITE_SMLIB_OK) {
                const bool floating=stream == IFCLITE_SMLIB_POSITIONS || stream == IFCLITE_SMLIB_NORMALS;
                for (uint32_t i=0; i<count; ++i) {
                    if (floating) { double value; std::memcpy(&value,buffer.data()+8*i,8); payload.f64(value); }
                    else { uint32_t value; std::memcpy(&value,buffer.data()+4*i,4); payload.u32(value); }
                }
            }
            break;
        }
        default: throw std::runtime_error("unknown opcode");
        }
    }
    Writer response; response.u32(version); response.u32(id); response.u32(uint32_t(status));
    if (status == IFCLITE_SMLIB_OK) {
        response.bytes.insert(response.bytes.end(),payload.bytes.begin(),payload.bytes.end());
    } else {
        char error[512]; ifclite_smlib_error_copy(error,sizeof(error));
        response.bytes.insert(response.bytes.end(),error,error + std::strlen(error));
    }
    return response;
}
}
std::vector<uint8_t> ifclite_smlib_dispatch(const std::vector<uint8_t>& request) {
    if (request.size() < 12 || request.size() > 4096)
        throw std::runtime_error("invalid frame length");
    Reader reader{request};
    return dispatch(reader).bytes;
}
