// SPDX-License-Identifier: MPL-2.0
#include "ifclite_smlib.h"
#include "mesh.hpp"
#include "sweep.hpp"
#include "rigid.hpp"
#include "affine.hpp"
#include "copy.hpp"
#include <SmApiBrep.h>
#include <SmApiGeneral.h>
#include <SmApiPrimitives.h>
#include <SmApiQueries.h>
#include <SmBrep.h>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <exception>
#include <limits>
#include <memory>
#include <unordered_map>
#include <vector>

namespace {
using Solid = std::unique_ptr<SmBrep>;
struct Failure { int32_t status; const char* message; };
struct Slot { Solid solid; uint32_t generation = 1; std::unique_ptr<AdapterMesh> mesh; };
struct Upload { uint64_t id; uint32_t length, loops, segments, format; std::vector<uint8_t> bytes; };
struct Session { std::vector<Slot> slots; std::unique_ptr<Upload> upload; };
uint64_t next_upload = 1;
std::unordered_map<uint64_t, Session> sessions;
uint64_t next_session = 1;
char last_error[512] = {};

void require(bool condition, int32_t status, const char* message) {
    if (!condition) throw Failure{status, message};
}
void checked(SmApiStatus status) {
    if (status != SM_SUCCESS) {
        std::snprintf(last_error, sizeof(last_error), "SMLib status %d", static_cast<int>(status));
        throw Failure{IFCLITE_SMLIB_KERNEL_ERROR, nullptr};
    }
}
template<class Action> int32_t boundary(Action action) noexcept {
    if(kernel_domain_is_tainted()) {
        std::snprintf(last_error,sizeof(last_error),"kernel domain tainted; discard process/module");
        return IFCLITE_SMLIB_TAINTED_DOMAIN;
    }
    last_error[0] = '\0';
    try { action(); return IFCLITE_SMLIB_OK; }
    catch (const KernelDomainTainted& error) {
        std::snprintf(last_error,sizeof(last_error),"%s",error.message.c_str());
        return IFCLITE_SMLIB_TAINTED_DOMAIN;
    } catch (const Failure& error) {
        if (error.message) std::snprintf(last_error, sizeof(last_error), "%s", error.message);
        return error.status;
    } catch (const SweepFailure& error) {
        std::snprintf(last_error,sizeof(last_error),"%s",error.message);
        return error.status;
    } catch (const AdapterMeshFailure& error) {
        std::snprintf(last_error,sizeof(last_error),"%s",error.message);
        return IFCLITE_SMLIB_KERNEL_ERROR;
    } catch (const std::exception& error) {
        std::snprintf(last_error, sizeof(last_error), "%s", error.what());
    } catch (...) {
        std::snprintf(last_error, sizeof(last_error), "%s", "unknown C++ exception");
    }
    return IFCLITE_SMLIB_EXCEPTION;
}
Session& lookup(uint64_t id) {
    auto found = sessions.find(id);
    require(found != sessions.end(), IFCLITE_SMLIB_INVALID_SESSION, "unknown session");
    return found->second;
}
Slot& lookup(uint64_t id, ifclite_smlib_handle handle) {
    Session& session = lookup(id);
    require(handle.session == id && handle.slot < session.slots.size(),
        IFCLITE_SMLIB_INVALID_HANDLE, "handle belongs to another session or unknown slot");
    Slot& slot = session.slots[handle.slot];
    require((slot.solid || slot.mesh) && slot.generation == handle.generation,
        IFCLITE_SMLIB_INVALID_HANDLE, "stale or released handle");
    return slot;
}
SmBrep* solid(uint64_t id, ifclite_smlib_handle handle) {
    auto& slot = lookup(id,handle);
    require(slot.solid != nullptr, IFCLITE_SMLIB_INVALID_HANDLE, "handle is not a solid");
    return slot.solid.get();
}
AdapterMesh& mesh(uint64_t id, ifclite_smlib_handle handle) {
    auto& slot = lookup(id,handle);
    require(slot.mesh != nullptr, IFCLITE_SMLIB_INVALID_HANDLE, "handle is not a mesh");
    return *slot.mesh;
}
ifclite_smlib_handle store(uint64_t id, Solid solid, std::unique_ptr<AdapterMesh> mesh = nullptr) {
    require(solid || mesh, IFCLITE_SMLIB_KERNEL_ERROR, "kernel returned null object");
    Session& session = lookup(id);
    for (size_t i = 0; i < session.slots.size(); ++i) {
        Slot& slot = session.slots[i];
        if (!slot.solid && !slot.mesh && slot.generation != UINT32_MAX) {
            slot.solid = std::move(solid);
            slot.mesh = std::move(mesh);
            return {id, static_cast<uint32_t>(i), slot.generation};
        }
    }
    require(session.slots.size() < UINT32_MAX, IFCLITE_SMLIB_RESOURCE_LIMIT, "slot limit reached");
    session.slots.push_back({std::move(solid), 1, std::move(mesh)});
    return {id, static_cast<uint32_t>(session.slots.size() - 1), 1};
}
void valid_origin(double x, double y, double z) {
    require(std::isfinite(x) && std::isfinite(y) && std::isfinite(z),
        IFCLITE_SMLIB_INVALID_ARGUMENT, "origin must be finite");
}
void positive(double value) {
    require(std::isfinite(value) && value > 0, IFCLITE_SMLIB_INVALID_ARGUMENT,
        "dimensions and tolerances must be finite and positive");
}
void valid_extent(double origin, double size) {
    require(std::isfinite(origin + size) && origin + size > origin,
        IFCLITE_SMLIB_INVALID_ARGUMENT, "extent overflows or collapses at supplied origin; rebase geometry");
}
void output(ifclite_smlib_handle* out) {
    require(out != nullptr, IFCLITE_SMLIB_INVALID_ARGUMENT, "null output");
    *out = {};
}
void validate_primitive(SmBrep* solid, double expected) {
    require(solid && std::isfinite(expected) && expected > 0,
        IFCLITE_SMLIB_KERNEL_ERROR, "invalid primitive volume; rebase or rescale geometry");
    SmBoolean manifold = FALSE;
    checked(SmApiBrepIsManifoldSolid(solid,manifold));
    double actual = 0;
    checked(SmApiBrepComputeVolume(solid,1e-8,actual));
    require(manifold && std::isfinite(actual) && actual > 0 &&
        std::abs(actual - expected) <= expected * 1e-5,
        IFCLITE_SMLIB_KERNEL_ERROR, "primitive failed manifold/volume invariant; rebase geometry");
}
Solid copy(SmBrep* original) {
    return checked_brep_copy(original);
}
}
extern "C" {
uint32_t ifclite_smlib_abi_version(void) { return IFCLITE_SMLIB_ABI_VERSION; }
int32_t ifclite_smlib_session_create(uint64_t* out) {
    return boundary([&] {
        require(out != nullptr, IFCLITE_SMLIB_INVALID_ARGUMENT, "null session output");
        *out = 0;
        require(next_session != UINT64_MAX, IFCLITE_SMLIB_RESOURCE_LIMIT, "session limit reached");
        static bool initialized = false;
        if (!initialized) { SmApiCreateContext(); initialized = true; }
        const uint64_t id = next_session++;
        sessions.try_emplace(id);
        *out = id;
    });
}
int32_t ifclite_smlib_session_destroy(uint64_t session) {
    return boundary([&] { lookup(session); sessions.erase(session); });
}
int32_t ifclite_smlib_box(uint64_t session, double x, double y, double z,
    double width, double depth, double height, ifclite_smlib_handle* out) {
    return boundary([&] {
        output(out); lookup(session); valid_origin(x, y, z);
        positive(width); positive(depth); positive(height);
        valid_extent(x,width); valid_extent(y,depth); valid_extent(z,height);
        SmBrep* raw = nullptr;
        const auto status = SmApiCreateBox(SmVector3d(x,y,z), width, depth, height, raw);
        Solid result(raw); checked(status); validate_primitive(result.get(),width*depth*height);
        *out = store(session, std::move(result));
    });
}
int32_t ifclite_smlib_cylinder(uint64_t session, double x, double y, double z,
    double radius, double height, ifclite_smlib_handle* out) {
    return boundary([&] {
        output(out); lookup(session); valid_origin(x, y, z); positive(radius); positive(height);
        valid_extent(x,radius); valid_extent(-x,radius);
        valid_extent(y,radius); valid_extent(-y,radius); valid_extent(z,height);
        SmBrep* raw = nullptr;
        const auto status = SmApiCreateCylinder(SmVector3d(x,y,z), radius, height, raw);
        Solid result(raw); checked(status);
        validate_primitive(result.get(),3.14159265358979323846*radius*radius*height);
        *out = store(session, std::move(result));
    });
}
int32_t ifclite_smlib_boolean(uint64_t session, ifclite_smlib_handle left,
    ifclite_smlib_handle right, uint32_t operation, ifclite_smlib_handle* out) {
    return boundary([&] {
        output(out);
        SmBooleanOperationType selected;
        switch (operation) {
        case IFCLITE_SMLIB_UNION: selected = SM_BO_UNION; break;
        case IFCLITE_SMLIB_INTERSECTION: selected = SM_BO_INTERSECTION; break;
        case IFCLITE_SMLIB_DIFFERENCE: selected = SM_BO_DIFFERENCE; break;
        default: throw Failure{IFCLITE_SMLIB_INVALID_ARGUMENT, "unknown boolean operation"};
        }
        Solid a = copy(solid(session, left));
        Solid b = copy(solid(session, right));
        SmBrep* raw = nullptr;
        checked(SmApiBoolean(a.get(), b.get(), selected, raw));
        // Supported operations delete b and return a on success (upstream contract).
        b.release();
        require(raw == a.get(), IFCLITE_SMLIB_KERNEL_ERROR, "unexpected boolean result ownership");
        *out = store(session, std::move(a));
    });
}
int32_t ifclite_smlib_volume(uint64_t session, ifclite_smlib_handle handle,
    double tolerance, double* out) {
    return boundary([&] {
        require(out != nullptr, IFCLITE_SMLIB_INVALID_ARGUMENT, "null volume output");
        *out = 0;
        require(std::isfinite(tolerance) && tolerance >= 1e-8 && tolerance <= 1e-1,
            IFCLITE_SMLIB_INVALID_ARGUMENT, "relative volume tolerance must be in [1e-8, 1e-1]");
        double volume = 0;
        checked(SmApiBrepComputeVolume(solid(session, handle), tolerance, volume));
        require(std::isfinite(volume), IFCLITE_SMLIB_KERNEL_ERROR, "nonfinite volume");
        *out = volume;
    });
}
int32_t ifclite_smlib_is_empty(uint64_t session, ifclite_smlib_handle handle, uint32_t* out) {
    return boundary([&] {
        require(out != nullptr, IFCLITE_SMLIB_INVALID_ARGUMENT, "null empty query output");
        *out = 0;
        *out = solid(session,handle)->IsEmptyModel() ? 1u : 0u;
    });
}
int32_t ifclite_smlib_manifold(uint64_t session, ifclite_smlib_handle handle, uint32_t* out) {
    return boundary([&] {
        require(out != nullptr, IFCLITE_SMLIB_INVALID_ARGUMENT, "null manifold output");
        *out = 0;
        SmBoolean manifold = FALSE;
        checked(SmApiBrepIsManifoldSolid(solid(session, handle), manifold));
        *out = manifold ? 1 : 0;
    });
}
int32_t ifclite_smlib_release(uint64_t session, ifclite_smlib_handle handle) {
    return boundary([&] {
        Slot& slot = lookup(session, handle);
        slot.solid.reset(); slot.mesh.reset(); ++slot.generation;
    });
}
int32_t ifclite_smlib_tessellate(uint64_t session, ifclite_smlib_handle handle,
    double chord, double angle, ifclite_smlib_handle* out) {
    return boundary([&] {
        output(out); positive(chord); positive(angle);
        require(angle <= 180, IFCLITE_SMLIB_INVALID_ARGUMENT, "angle exceeds 180 degrees");
        auto result = tessellate_mesh(solid(session,handle),chord,angle);
        *out = store(session,nullptr,std::move(result));
    });
}
int32_t ifclite_smlib_mesh_get_info(uint64_t session, ifclite_smlib_handle handle,
    ifclite_smlib_mesh_info* out) {
    return boundary([&] {
        require(out != nullptr,IFCLITE_SMLIB_INVALID_ARGUMENT,"null mesh info output");
        *out = {}; *out = mesh(session,handle).info;
    });
}
int32_t ifclite_smlib_mesh_copy(uint64_t session, ifclite_smlib_handle handle,
    uint32_t stream, uint32_t offset, uint32_t count, void* out, uint32_t capacity) {
    return boundary([&] {
        AdapterMesh& data = mesh(session,handle);
        const void* source = nullptr; size_t length = 0; uint32_t width = 0;
        switch (stream) {
        case IFCLITE_SMLIB_POSITIONS: source=data.positions.data(); length=data.positions.size(); width=8; break;
        case IFCLITE_SMLIB_INDICES: source=data.indices.data(); length=data.indices.size(); width=4; break;
        case IFCLITE_SMLIB_SOURCE_FACES: source=data.faces.data(); length=data.faces.size(); width=4; break;
        case IFCLITE_SMLIB_NORMALS: source=data.normals.data(); length=data.normals.size(); width=8; break;
        default: throw Failure{IFCLITE_SMLIB_INVALID_ARGUMENT,"unknown mesh stream"};
        }
        require(count <= 480 && offset <= length && count <= length-offset &&
            capacity >= count*width && (out || count == 0),
            IFCLITE_SMLIB_INVALID_ARGUMENT,"invalid mesh copy range or buffer capacity");
        if (count) std::memcpy(out,static_cast<const uint8_t*>(source)+size_t(offset)*width,count*width);
    });
}
int32_t ifclite_smlib_transform(uint64_t session, ifclite_smlib_handle handle,
    const double* matrix, ifclite_smlib_handle* out) {
    return boundary([&] {
        output(out);
        const auto frame=numerical_rigid_frame(matrix);
        Solid result=copy(solid(session,handle));
        checked(SmApiTransform(result.get(),frame));
        *out=store(session,std::move(result));
    });
}
int32_t ifclite_smlib_copy_affine(uint64_t session, ifclite_smlib_handle handle,
    const double* matrix, ifclite_smlib_handle* out, ifclite_smlib_affine_certificate* certificate) {
    return boundary([&] {
        output(out);
        require(certificate,IFCLITE_SMLIB_INVALID_ARGUMENT,"null affine certificate");
        *certificate={}; ifclite_smlib_affine_certificate prepared{};
        auto result=copy_affine_rational(solid(session,handle),matrix,prepared);
        *out=store(session,std::move(result)); *certificate=prepared;
    });
}
uint32_t ifclite_smlib_capabilities(void) { return 1u|2u|8u|16u|32u; }
int32_t ifclite_smlib_sweep_begin(uint64_t session, uint32_t format,
    uint32_t length, uint32_t loops, uint32_t segments, uint64_t* out) {
    return boundary([&] {
        require(out != nullptr,IFCLITE_SMLIB_INVALID_ARGUMENT,"null upload output"); *out=0;
        auto& owner=lookup(session);
        require(!owner.upload,IFCLITE_SMLIB_RESOURCE_LIMIT,"upload already active");
        require(loops>0 && loops<=128 && loops<=segments,IFCLITE_SMLIB_INVALID_ARGUMENT,"invalid loop count");
        require(segments>0 && segments<=8192 && length<=1048576u &&
            ((format==1 && length==48u+8u*loops+104u*segments) ||
             (format==2 && loops==1 && segments==1 && length>=168)),
            IFCLITE_SMLIB_INVALID_ARGUMENT,"invalid/unqualified sweep declaration");
        require(next_upload!=UINT64_MAX,IFCLITE_SMLIB_RESOURCE_LIMIT,"upload IDs exhausted");
        auto upload=std::make_unique<Upload>();
        upload->id=next_upload++; upload->length=length; upload->loops=loops;
        upload->segments=segments; upload->format=format; upload->bytes.reserve(length);
        *out=upload->id; owner.upload=std::move(upload);
    });
}
int32_t ifclite_smlib_sweep_chunk(uint64_t session, uint64_t id, uint32_t offset,
    const uint8_t* bytes, uint32_t length) {
    return boundary([&] {
        auto& upload=lookup(session).upload;
        require(upload && upload->id==id,IFCLITE_SMLIB_INVALID_HANDLE,"unknown upload");
        if (!bytes || length==0 || length>3840 || offset!=upload->bytes.size() ||
            offset>upload->length || length>upload->length-offset) {
            upload.reset();
            throw Failure{IFCLITE_SMLIB_INVALID_ARGUMENT,"invalid chunk; upload discarded"};
        }
        upload->bytes.insert(upload->bytes.end(),bytes,bytes+length);
    });
}
int32_t ifclite_smlib_sweep_abort(uint64_t session, uint64_t id) {
    return boundary([&] {
        auto& upload=lookup(session).upload;
        require(upload && upload->id==id,IFCLITE_SMLIB_INVALID_HANDLE,"unknown upload");
        upload.reset();
    });
}
int32_t ifclite_smlib_sweep_commit(uint64_t session, uint64_t id, ifclite_smlib_handle* out) {
    return boundary([&] {
        output(out); auto& active=lookup(session).upload;
        require(active && active->id==id,IFCLITE_SMLIB_INVALID_HANDLE,"unknown upload");
        auto upload=std::move(active); // Every commit attempt consumes the transaction.
        require(upload->bytes.size()==upload->length,IFCLITE_SMLIB_INVALID_ARGUMENT,
            "incomplete sweep upload discarded");
        auto result=upload->format==2 ? create_authored_disk(upload->bytes) :
            create_authored_sweep(upload->bytes,upload->loops,upload->segments);
        *out=store(session,std::move(result));
    });
}
uint32_t ifclite_smlib_error_copy(char* buffer, uint32_t capacity) {
    const size_t length = std::strlen(last_error);
    if (buffer && capacity) {
        const size_t count = std::min(length, static_cast<size_t>(capacity - 1));
        std::memcpy(buffer, last_error, count); buffer[count] = '\0';
    }
    return static_cast<uint32_t>(length + 1);
}
}
