// SPDX-License-Identifier: MPL-2.0
#include "adapter_state.hpp"
using namespace adapter_state;
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
        Solid a,b;
        try {
            a=copy(solid(session,left)); b=copy(solid(session,right));
        } catch(...) {
            if(kernel_domain_is_tainted()) { a.release(); b.release(); }
            throw;
        }
        SmBrep* raw = nullptr;
        checked(SmApiBoolean(a.get(), b.get(), selected, raw));
        // Supported operations delete b and return a on success (upstream contract).
        b.release();
        require(raw == a.get(), IFCLITE_SMLIB_KERNEL_ERROR, "unexpected boolean result ownership");
        *out = store(session, std::move(a),nullptr,face_lineage::UnknownReason::UnauditedBoolean);
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
int32_t ifclite_smlib_manifold(uint64_t session, ifclite_smlib_handle handle, uint32_t* out) {
    return boundary([&] {
        require(out != nullptr, IFCLITE_SMLIB_INVALID_ARGUMENT, "null manifold output");
        *out = 0;
        SmBoolean manifold = FALSE;
        checked(SmApiBrepIsManifoldSolid(solid(session, handle), manifold));
        *out = manifold ? 1 : 0;
    });
}
int32_t ifclite_smlib_is_empty(uint64_t session, ifclite_smlib_handle handle, uint32_t* out) {
    return boundary([&] {
        require(out != nullptr, IFCLITE_SMLIB_INVALID_ARGUMENT, "null empty query output");
        *out = 0;
        *out = semantically_empty_brep(solid(session, handle)) ? 1u : 0u;
    });
}
int32_t ifclite_smlib_release(uint64_t session, ifclite_smlib_handle handle) {
    return boundary([&] {
        Slot& slot = lookup(session, handle);
        slot.solid.reset(); slot.mesh.reset(); slot.source.reset();
        // Saturate rather than wrap: a slot whose generation reaches UINT32_MAX
        // stays retired (store() skips it), so a stale handle can never match a
        // recycled generation.
        if (slot.generation != UINT32_MAX) ++slot.generation;
    });
}
int32_t ifclite_smlib_tessellate(uint64_t session, ifclite_smlib_handle handle,
    double chord, double angle, ifclite_smlib_handle* out) {
    return boundary([&] {
        output(out); positive(chord); positive(angle);
        require(angle <= 180, IFCLITE_SMLIB_INVALID_ARGUMENT, "angle exceeds 180 degrees");
        auto& owner=lookup(session,handle);
        auto result = owner.source ? owner.source->tessellate(chord,angle) : tessellate_mesh(solid(session,handle),chord,angle);
        *out = store(session,nullptr,std::move(result),face_lineage::UnknownReason::UnobservedTessellation);
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
        case 5: require(bool(data.source_inventory),IFCLITE_SMLIB_UNSUPPORTED,"persistent construction correspondence unavailable");
            source=data.source_roots.data(); length=data.source_roots.size(); width=4; break;
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
        *out=store(session,std::move(result),nullptr,face_lineage::UnknownReason::UnauditedAffine);
    });
}
int32_t ifclite_smlib_copy_affine(uint64_t session, ifclite_smlib_handle handle,
    const double* matrix, ifclite_smlib_handle* out, ifclite_smlib_affine_certificate* certificate) {
    return boundary([&] {
        output(out);
        require(certificate != nullptr,IFCLITE_SMLIB_INVALID_ARGUMENT,"null affine certificate");
        *certificate={}; ifclite_smlib_affine_certificate prepared{};
        auto& owner=lookup(session,handle);
        if(owner.source) {
            auto result=owner.source->affine(matrix,prepared);
            auto& slots=lookup(session).slots;
            require(slots.size()<4096,IFCLITE_SMLIB_RESOURCE_LIMIT,"source object slot bound");
            Slot target;target.source=std::move(result);slots.push_back(std::move(target));
            *out={session,uint32_t(slots.size()-1),1};*certificate=prepared;return;
        }
        auto result=copy_affine_rational(solid(session,handle),matrix,prepared);
        *out=store(session,std::move(result),nullptr,face_lineage::UnknownReason::UnauditedAffine); *certificate=prepared;
    });
}
int32_t ifclite_smlib_clip_plane(uint64_t session, ifclite_smlib_handle handle,
    const double* plane, int32_t side, uint32_t mode, ifclite_smlib_handle* out,
    ifclite_smlib_plane_certificate* certificate) {
    return boundary([&] {
        output(out);
        require(certificate,IFCLITE_SMLIB_INVALID_ARGUMENT,"null plane certificate");
        *certificate={}; ifclite_smlib_plane_certificate prepared{};
        auto result=clip_finite_plane(solid(session,handle),plane,side,mode,prepared);
        *out=store(session,std::move(result),nullptr,face_lineage::UnknownReason::UnauditedClip);
        prepared.input=handle; prepared.output=*out; *certificate=prepared;
    });
}
uint32_t ifclite_smlib_capabilities(void) {
    return IFCLITE_SMLIB_CAPABILITY_SWEEP_REGION | IFCLITE_SMLIB_CAPABILITY_SWEEP_DISK |
        IFCLITE_SMLIB_CAPABILITY_RIGID_COPY | IFCLITE_SMLIB_CAPABILITY_AFFINE_COPY |
        IFCLITE_SMLIB_CAPABILITY_SEMANTIC_EMPTY | IFCLITE_SMLIB_CAPABILITY_PLANE_CLIP | 256u;
}
int32_t ifclite_smlib_sweep_begin(uint64_t session, uint32_t format,
    uint32_t length, uint32_t loops, uint32_t segments, uint64_t* out) {
    return boundary([&] {
        require(out != nullptr,IFCLITE_SMLIB_INVALID_ARGUMENT,"null upload output"); *out=0;
        auto& owner=lookup(session);
        require(!owner.upload,IFCLITE_SMLIB_RESOURCE_LIMIT,"upload already active");
        require(loops>0 && loops<=128 && loops<=segments,IFCLITE_SMLIB_INVALID_ARGUMENT,"invalid loop count");
        // Format 1 has an exact declared size; format 2 is validated at commit.
        require(segments>0 && segments<=8192 && length<=1048576u &&
            ((format==1 && length==48u+8u*loops+104u*segments) ||
             (format==2 && loops==1 && segments==1 && length>=168)),
            IFCLITE_SMLIB_INVALID_ARGUMENT,"invalid sweep declaration");
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

face_lineage::UnknownReason face_lineage::unavailable_reason(uint64_t session,ifclite_smlib_handle handle) {
    return lookup(session,handle).provenance;
}

int32_t source_commit(uint64_t session,uint64_t id,face_lineage::SourceStamp stamp,ifclite_smlib_handle* out) {
    return boundary([&] {
        output(out);auto& owner=lookup(session);auto& active=owner.upload;
        require(active && active->id==id,IFCLITE_SMLIB_INVALID_HANDLE,"unknown source upload");
        auto upload=std::move(active);
        require(upload->format==1 && upload->bytes.size()==upload->length,IFCLITE_SMLIB_UNSUPPORTED,"source binding requires a complete region recipe");
        require(owner.slots.size()<4096,IFCLITE_SMLIB_RESOURCE_LIMIT,"source object slot bound");
        const ifclite_smlib_handle handle{session,uint32_t(owner.slots.size()),1};
        auto source=face_lineage::SourceBoundary::construct(upload->bytes,upload->loops,upload->segments,stamp,handle,id);
        Slot target;target.source=std::move(source);owner.slots.push_back(std::move(target));*out=handle;
    });
}
int32_t source_info(uint64_t session,ifclite_smlib_handle handle,uint8_t* bytes,uint32_t capacity,uint32_t* length) {
    return boundary([&] {
        require(bytes && length,IFCLITE_SMLIB_INVALID_ARGUMENT,"null source inventory output");*length=0;
        auto& slot=lookup(session,handle);
        const auto* inventory=slot.source ? &slot.source->inventory() : slot.mesh ? slot.mesh->source_inventory.get() : nullptr;
        require(inventory,IFCLITE_SMLIB_UNSUPPORTED,"source construction correspondence unavailable");
        auto packet=face_lineage::source_packet(*inventory,handle);
        require(packet.size()<=capacity,IFCLITE_SMLIB_RESOURCE_LIMIT,"source inventory output bound");
        std::memcpy(bytes,packet.data(),packet.size());*length=uint32_t(packet.size());
    });
}
