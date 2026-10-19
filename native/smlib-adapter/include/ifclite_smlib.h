/* SPDX-License-Identifier: MPL-2.0 */
#ifndef IFCLITE_SMLIB_H
#define IFCLITE_SMLIB_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

#define IFCLITE_SMLIB_ABI_VERSION 1u
typedef uint64_t ifclite_smlib_session;
typedef struct ifclite_smlib_handle {
    uint64_t session;
    uint32_t slot;
    uint32_t generation;
} ifclite_smlib_handle;
typedef int32_t ifclite_smlib_status;
typedef struct ifclite_smlib_mesh_info {
    uint32_t vertex_count, triangle_count, source_face_count;
    uint32_t boundary_edges, spine_edges, failed_faces;
} ifclite_smlib_mesh_info;
#define IFCLITE_SMLIB_OK 0
#define IFCLITE_SMLIB_INVALID_ARGUMENT 1
#define IFCLITE_SMLIB_INVALID_SESSION 2
#define IFCLITE_SMLIB_INVALID_HANDLE 3
#define IFCLITE_SMLIB_KERNEL_ERROR 4
#define IFCLITE_SMLIB_EXCEPTION 5
#define IFCLITE_SMLIB_RESOURCE_LIMIT 6
#define IFCLITE_SMLIB_UNSUPPORTED 7
/* SDK failure may leave unlinked internal allocations: discard the entire
 * process/module. No subsequent status-returning operation is permitted.
 * Existing ABI/protocol layouts are unchanged; this is an additive status. */
#define IFCLITE_SMLIB_TAINTED_DOMAIN 8
#define IFCLITE_SMLIB_UNION 1u
#define IFCLITE_SMLIB_INTERSECTION 2u
#define IFCLITE_SMLIB_DIFFERENCE 3u
#define IFCLITE_SMLIB_POSITIONS 1u
#define IFCLITE_SMLIB_INDICES 2u
#define IFCLITE_SMLIB_SOURCE_FACES 3u
#define IFCLITE_SMLIB_NORMALS 4u

/* All calls across ALL sessions must be serialized by the caller. Sessions own
 * solids, not independent SMLib contexts. Process/module lifetime owns context.
 * Output pointers must address caller-owned valid memory; null is rejected.
 * Handles are values, never pointers. No C++ allocation crosses this boundary.
 * Status-returning calls clear last error; error_copy preserves it.
 */
uint32_t ifclite_smlib_abi_version(void);
ifclite_smlib_status ifclite_smlib_session_create(ifclite_smlib_session* out);
ifclite_smlib_status ifclite_smlib_session_destroy(ifclite_smlib_session session);
/* Origin is minimum box corner; cylinder extends along positive Z. */
ifclite_smlib_status ifclite_smlib_box(ifclite_smlib_session session,
    double x, double y, double z, double width, double depth, double height,
    ifclite_smlib_handle* out);
ifclite_smlib_status ifclite_smlib_cylinder(ifclite_smlib_session session,
    double x, double y, double z, double radius, double height,
    ifclite_smlib_handle* out);
/* Copies both operands before invoking destructive upstream operations.
 * Inputs remain owned and unchanged on success and reported failure. */
ifclite_smlib_status ifclite_smlib_boolean(ifclite_smlib_session session,
    ifclite_smlib_handle left, ifclite_smlib_handle right, uint32_t operation,
    ifclite_smlib_handle* out);
/* Copies the BRep before transforming; input remains immutable on all outcomes.
 * Matrix has 16 column-major doubles: finite positive rigid affine only. */
ifclite_smlib_status ifclite_smlib_transform(ifclite_smlib_session session,
    ifclite_smlib_handle solid, const double* matrix, ifclite_smlib_handle* out);
/* Semantic query on actual retained boundary topology and known-void regions, not a mesh or
 * volume heuristic. Returns exactly 0 or 1; does not consume the solid.
 * Additive opcode 19, capability bit 5 (numeric 32). */
ifclite_smlib_status ifclite_smlib_is_empty(ifclite_smlib_session session,
    ifclite_smlib_handle solid, uint32_t* out);
/* Additive affine rational representation v1. Class counters are unique SDK
 * geometry objects: curve BSpline/Line/Circle/Ellipse/Parabola/Hyperbola,
 * surface BSpline/Plane/Cylinder/Cone/Sphere/Torus, in that order. This records
 * exact rationalizable representation conversion, not exact arithmetic, durable
 * face identity, product coverage or execution qualification. Unsupported source
 * classes (including offsets) refuse before copying. See AFFINE_CONTRACT.md. */
typedef struct ifclite_smlib_affine_certificate {
    uint32_t version, representation, source_classes[12];
} ifclite_smlib_affine_certificate;
ifclite_smlib_status ifclite_smlib_copy_affine(ifclite_smlib_session session,
    ifclite_smlib_handle solid, const double* matrix, ifclite_smlib_handle* out,
    ifclite_smlib_affine_certificate* certificate);
/* Unary derived finite clip, opcode20/capability64. Original local-metre plane
 * is point XYZ, normal XYZ (finite, nonzero). side=1 means dot(n,x-p)>=0;
 * side=-1 means <=0. mode is INTERSECTION or DIFFERENCE (opposite kept side).
 * No UNION, authored IFC recipe, paired split or persistent face ancestry.
 * Certificate is output evidence, never accepted as caller authority.
 * frame=1 means unchanged input local metre frame; basis is the effective
 * numerical orthonormal XYZ basis. Bounds arrays are loXYZ,hiXYZ.
 * method is a domain-proof bitmask: 1=analytic planar UV hull,
 * 2=generic positive clamped patch with existing UV containment,
 * 4=bounded analytic cylinder formula; 8=source-derived affine rectangle.
 * Version2 is emitted iff method8 records exist; all other domains use v1.
 * Source-derived inverse bounds are distinct from authored UV trims.
 * 0 is the canonical Empty domain.
 * Cylinder records bind actual local coefficients and source GetFaces index,
 * not persistent source ancestry. At most16 records; larger domains refuse.
 * Empty is the canonical topology query, not a zero-volume heuristic.
 * Unsupported domains refuse; capability is implementation, not qualification. */
#define IFCLITE_SMLIB_PLANE_MAX_CYLINDERS 16u
typedef struct ifclite_smlib_cylinder_domain {
    uint32_t source_face, swap_uv, inside_out, reserved;
    double origin[3], basis[9], radius, step_v[2];
} ifclite_smlib_cylinder_domain;
#define IFCLITE_SMLIB_PLANE_MAX_RECTANGLES 16u
#define IFCLITE_SMLIB_PLANE_RECTANGLE_BYTES 1376u
#define IFCLITE_SMLIB_PLANE_RECTANGLE_EDGE_BYTES 248u
#define IFCLITE_SMLIB_PLANE_SOURCE_RECTANGLE 8u
/* All wire integers are little-endian u32; all wire doubles IEEE binary64.
 * source_face is revision-local GetFaces inventory, never persistent ancestry.
 * Edge flags: bit0=canonical SmLine fields present, bit1=inside-out.
 * Non-analytic edge canonical fields are all zero. */
typedef struct ifclite_smlib_rectangle_edge {
    uint32_t flags, start_corner, end_corner, reserved;
    double controls[8], knots[4], interval[2], start[3], end[3];
    double line_origin[3], line_axis[3], step[2], scale;
} ifclite_smlib_rectangle_edge;
typedef struct ifclite_smlib_rectangle_domain {
    uint32_t version, source_face, u_axis, v_axis, normal_axis;
    uint32_t loops, holes, edge_count, control_count, flags, reserved0, reserved1;
    double controls[16], u[4], v[4], bounds[6], uv_hull[4];
    /* u0,u1,P00[U],P10[U],v0,v1,P00[V],P01[V]. No rounded division. */
    double inverse[8];
    ifclite_smlib_rectangle_edge edges[4];
} ifclite_smlib_rectangle_domain;
typedef struct ifclite_smlib_plane_certificate {
    uint32_t version, method, frame, empty;
    ifclite_smlib_handle input, output;
    int32_t side;
    uint32_t mode, faces, edges, coefficients;
    double plane[6], basis[9], domain[6], cutter[6], clearance;
    uint32_t cylinder_count;
    ifclite_smlib_cylinder_domain cylinders[IFCLITE_SMLIB_PLANE_MAX_CYLINDERS];
    /* V2 wire extension follows serialized cylinder records; never memcpy
     * the padded C certificate as a wire payload. V1 has no extension. */
    uint32_t rectangle_count, rectangle_record_bytes, rectangle_edge_bytes, rectangle_reserved;
    ifclite_smlib_rectangle_domain rectangles[IFCLITE_SMLIB_PLANE_MAX_RECTANGLES];
} ifclite_smlib_plane_certificate;
ifclite_smlib_status ifclite_smlib_clip_plane(ifclite_smlib_session session,
    ifclite_smlib_handle solid, const double* plane, int32_t side, uint32_t mode,
    ifclite_smlib_handle* out, ifclite_smlib_plane_certificate* certificate);
/* Relative numerical-integration tolerance, supported range [1e-8, 1e-1]. */
ifclite_smlib_status ifclite_smlib_volume(ifclite_smlib_session session,
    ifclite_smlib_handle solid, double integration_tolerance, double* out);
ifclite_smlib_status ifclite_smlib_manifold(ifclite_smlib_session session,
    ifclite_smlib_handle solid, uint32_t* out);
ifclite_smlib_status ifclite_smlib_release(ifclite_smlib_session session,
    ifclite_smlib_handle solid);
/* Strict tessellation. Positive chord in model units and angle in (0,180].
 * Source face IDs are local GetFaces() indices of this retained BRep revision,
 * not IFC IDs or durable topological identities. Returned mesh is separately owned. */
ifclite_smlib_status ifclite_smlib_tessellate(ifclite_smlib_session session,
    ifclite_smlib_handle solid, double chord, double angle, ifclite_smlib_handle* out);
ifclite_smlib_status ifclite_smlib_mesh_get_info(ifclite_smlib_session session,
    ifclite_smlib_handle mesh, ifclite_smlib_mesh_info* out);
/* Streams use native ABI scalar layout: f64 XYZ positions, u32 triangle indices,
 * u32 source face per triangle, f64 flat per-corner XYZ normals. Offset/count are
 * scalars, not vertices. Copies at most 480 scalars into caller-owned memory.
 * Capacity is bytes; no buffer is borrowed. output alignment need not be natural. */
ifclite_smlib_status ifclite_smlib_mesh_copy(ifclite_smlib_session session,
    ifclite_smlib_handle mesh, uint32_t stream, uint32_t offset, uint32_t count,
    void* out, uint32_t capacity_bytes);
/* Additive extension negotiation, independent of unchanged ABI/protocol v1.
 * Bit 1: staged format2 capped rational-path disk; bit3: copied rigid transform.
 * Format2 and its variable coefficient records: NUMERICAL_ROUND3.md.
 * Bit4: copied affine rational representation with conversion certificate.
 * Bit6: certified finite-domain unary plane clip (opcode20), not paired split.
 * Capability indicates implementation, never execution qualification.
 * Bit 0: staged sweep recipe format 1. One upload/session; max 1MiB/8192 curves/128 loops.
 * Recipe LE: u32 format,loops,segments,reserved; f64 unit direction XYZ,depth;
 * per loop u32 role(0 outer first,1 inner thereafter),count; per curve u32 kind,reserved and 12 f64.
 * Line(1): start XYZ,end XYZ,6 zeros. Circle(2): center XYZ,normal XYZ,
 * x-axis XYZ,radius,start radians,signed sweep radians (+/-2pi). Arc(3): same
 * fields with a partial signed interval. XY profiles; normal +/-Z, unit XY
 * x-axis. Multiple loops require outer CCW, holes CW. Units are local metres.
 * Extended regions are implemented but remain unqualified pending SDK receipts;
 * source admission must retain its own qualification gates.
 * Begin declares exact size/counts. Chunks are sequential and <=3840 bytes.
 * Invalid chunks discard the transaction; each matching commit with non-null output consumes it,
 * including incomplete/failed commits. Null output leaves the upload active. Abort/session destroy clean incomplete input.
 * New solids publish only after capped sweep manifold/volume checks. */
uint32_t ifclite_smlib_capabilities(void);
ifclite_smlib_status ifclite_smlib_sweep_begin(uint64_t session, uint32_t format,
    uint32_t length, uint32_t loops, uint32_t segments, uint64_t* out);
ifclite_smlib_status ifclite_smlib_sweep_chunk(uint64_t session, uint64_t upload,
    uint32_t offset, const uint8_t* bytes, uint32_t length);
ifclite_smlib_status ifclite_smlib_sweep_abort(uint64_t session, uint64_t upload);
ifclite_smlib_status ifclite_smlib_sweep_commit(uint64_t session, uint64_t upload,
    ifclite_smlib_handle* out);
/* Returns required bytes INCLUDING NUL. Copies a terminated, possibly truncated
 * message when capacity > 0 and buffer != NULL. Buffer may be NULL for sizing. */
uint32_t ifclite_smlib_error_copy(char* buffer, uint32_t capacity);
#ifdef __cplusplus
}
#endif
#endif
