// SPDX-License-Identifier: MPL-2.0
#pragma once
#include "ifclite_smlib.h"
#include "mesh.hpp"
#include "failure.hpp"
#include "rigid.hpp"
#include "copy.hpp"
#include "affine.hpp"
#include "empty.hpp"
#include "plane.hpp"
#include "sweep.hpp"
#include "source_boundary.hpp"
#include "source_api.hpp"
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

namespace adapter_state {
using Solid = std::unique_ptr<SmBrep>;
struct Failure { int32_t status; const char* message; };
struct Slot { Solid solid; uint32_t generation = 1; std::unique_ptr<AdapterMesh> mesh;
    face_lineage::UnknownReason provenance=face_lineage::UnknownReason::UnobservedConstruction;
    std::unique_ptr<face_lineage::SourceBoundary> source; };
// One staged authored recipe per session. Bytes stay adapter-owned until commit.
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
void abandon_tainted_solids() noexcept {
    // SDK failure may leave internal topology inconsistent. Once this module is
    // terminal, even later static destruction must not invoke SDK destructors.
    // The native process / browser module owns reclamation of this memory.
    for(auto& entry:sessions) for(auto& slot:entry.second.slots) slot.solid.release();
}
template<class Action> int32_t boundary(Action action) noexcept {
    if(kernel_domain_is_tainted()) {
        abandon_tainted_solids();
        std::snprintf(last_error,sizeof(last_error),"kernel domain tainted; discard process/module");
        return IFCLITE_SMLIB_TAINTED_DOMAIN;
    }
    last_error[0] = '\0';
    try { action(); return IFCLITE_SMLIB_OK; }
    catch (const KernelDomainTainted& error) {
        abandon_tainted_solids();
        std::snprintf(last_error,sizeof(last_error),"%s",error.message.c_str());
        return IFCLITE_SMLIB_TAINTED_DOMAIN;
    } catch (const Failure& error) {
        if (error.message) std::snprintf(last_error, sizeof(last_error), "%s", error.message);
        return error.status;
    } catch (const AdapterFailure& error) {
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
    if(kernel_domain_is_tainted()) {
        abandon_tainted_solids();
        return IFCLITE_SMLIB_TAINTED_DOMAIN;
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
    require((slot.solid || slot.mesh || slot.source) && slot.generation == handle.generation,
        IFCLITE_SMLIB_INVALID_HANDLE, "stale or released handle");
    return slot;
}
SmBrep* solid(uint64_t id, ifclite_smlib_handle handle) {
    auto& slot = lookup(id,handle);
    require(!slot.source, IFCLITE_SMLIB_UNSUPPORTED, "source-bound operation has no authenticated Boolean/clip/rigid lineage");
    require(slot.solid != nullptr, IFCLITE_SMLIB_INVALID_HANDLE, "handle is not a solid");
    return slot.solid.get();
}
AdapterMesh& mesh(uint64_t id, ifclite_smlib_handle handle) {
    auto& slot = lookup(id,handle);
    require(slot.mesh != nullptr, IFCLITE_SMLIB_INVALID_HANDLE, "handle is not a mesh");
    return *slot.mesh;
}
ifclite_smlib_handle store(uint64_t id, Solid solid, std::unique_ptr<AdapterMesh> mesh = nullptr,
    face_lineage::UnknownReason provenance=face_lineage::UnknownReason::UnobservedConstruction) {
    require(solid || mesh, IFCLITE_SMLIB_KERNEL_ERROR, "kernel returned null object");
    Session& session = lookup(id);
    for (size_t i = 0; i < session.slots.size(); ++i) {
        Slot& slot = session.slots[i];
        if (!slot.solid && !slot.mesh && !slot.source && slot.generation != UINT32_MAX) {
            slot.solid = std::move(solid);
            slot.mesh = std::move(mesh); slot.provenance=provenance;
            return {id, static_cast<uint32_t>(i), slot.generation};
        }
    }
    require(session.slots.size() < UINT32_MAX, IFCLITE_SMLIB_RESOURCE_LIMIT, "slot limit reached");
    session.slots.push_back({std::move(solid), 1, std::move(mesh), provenance});
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
