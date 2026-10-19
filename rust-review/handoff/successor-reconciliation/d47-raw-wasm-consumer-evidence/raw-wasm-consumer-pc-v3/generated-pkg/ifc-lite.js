/* @ts-self-types="./ifc-lite.d.ts" */

export class AlignmentAxisJs {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        AlignmentAxisJsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_alignmentaxisjs_free(ptr, 0);
    }
    /**
     * @returns {string | undefined}
     */
    get GlobalId() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.alignmentaxisjs_GlobalId(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v1;
            if (r0 !== 0) {
                v1 = getStringFromWasm0(r0, r1).slice();
                wasm.__wbindgen_export4(r0, r1 * 1, 1);
            }
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {string | undefined}
     */
    get Name() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.alignmentaxisjs_Name(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v1;
            if (r0 !== 0) {
                v1 = getStringFromWasm0(r0, r1).slice();
                wasm.__wbindgen_export4(r0, r1 * 1, 1);
            }
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {boolean}
     */
    get approximate() {
        const ret = wasm.alignmentaxisjs_approximate(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * [horizontal distance, IFC Z-up point XYZ, normalized world tangent XYZ].
     * Coordinates remain f64 absolute metres; no renderer origin is applied.
     * @param {number} distance_m
     * @returns {Float64Array}
     */
    evaluate(distance_m) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.alignmentaxisjs_evaluate(retptr, this.__wbg_ptr, distance_m);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {number}
     */
    get expressId() {
        const ret = wasm.alignmentaxisjs_expressId(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get geometricHorizontalLengthMeters() {
        const ret = wasm.alignmentaxisjs_geometricHorizontalLengthMeters(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {string} content
     * @param {number} express_id
     */
    constructor(content, express_id) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.alignmentaxisjs_new(retptr, ptr0, len0, express_id);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            this.__wbg_ptr = r0;
            AlignmentAxisJsFinalization.register(this, this.__wbg_ptr, this);
            return this;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) AlignmentAxisJs.prototype[Symbol.dispose] = AlignmentAxisJs.prototype.free;

/**
 * The overlap solid of one clashing pair, or the reason there is none.
 */
export class ClashIntersectionSolidJs {
    static __wrap(ptr) {
        const obj = Object.create(ClashIntersectionSolidJs.prototype);
        obj.__wbg_ptr = ptr;
        ClashIntersectionSolidJsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ClashIntersectionSolidJsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_clashintersectionsolidjs_free(ptr, 0);
    }
    /**
     * `""` when `isSolid`, otherwise one of:
     * - `"malformed-operand"` — any of FOUR malformations, all rejected
     *   before the boolean runs, because computing on them would silently
     *   drop the offending triangle (or worse) rather than report the true
     *   operand:
     *   1. `positionsA`/`positionsB` is not a flat `[x, y, z, …]` triple
     *      (length not a multiple of 3);
     *   2. `indicesA`/`indicesB` has a length that is not a multiple of 3,
     *      so it does not describe whole triangles;
     *   3. `indicesA`/`indicesB` references a vertex past the end of its own
     *      operand's positions;
     *   4. a position is **non-finite** (NaN or infinity). This one is worth
     *      calling out to callers: a NaN coordinate is caught by neither
     *      length check, and left alone it can be absorbed into a
     *      normal-looking answer or corrupt a face enough to report a
     *      genuinely overlapping pair as `"no-overlap"`. So if you are
     *      debugging an unexpected `"no-overlap"`, check your inputs for
     *      NaN — it surfaces here, not there.
     * - `"empty-operand"` — an operand had no triangles.
     * - `"no-overlap"` — the exact intersection is empty. Covers a disjoint
     *   pair AND a *touching* pair, including any graze below the kernel's
     *   `2^-16 m ≈ 15.26 µm` snap grid (both faces snap flush).
     * - `"below-kernel-resolution"` — the pair overlaps, but too shallowly for
     *   the kernel to resolve as a solid rather than a coplanar contact. See
     *   `thicknessM` / `requiredM`.
     * - `"budget-exhausted"` — the escalation budget tripped; the arrangement
     *   is partial and nothing about it is trustworthy.
     * @returns {string}
     */
    get degenerateReason() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.clashintersectionsolidjs_degenerateReason(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Triangle indices into `positions / 3`.
     * @returns {Uint32Array}
     */
    get indices() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.clashintersectionsolidjs_indices(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * True when a trustworthy overlap solid was produced. When false, every
     * geometry getter is empty and `degenerateReason` says why.
     * @returns {boolean}
     */
    get isSolid() {
        const ret = wasm.clashintersectionsolidjs_isSolid(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * World-space vertex positions, flat `[x, y, z, …]`, f64.
     *
     * f64 rather than the f32 the rest of the mesh pipeline uses because the
     * caller reports this solid's volume: the f32 round-trip costs ~1e-7
     * relative, a thousand times the exactness the kernel actually delivers.
     * Downcast to f32 at the GPU upload if the renderer wants it.
     * @returns {Float64Array}
     */
    get positions() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.clashintersectionsolidjs_positions(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * For `"below-kernel-resolution"`: the depth this pair would have needed
     * for the kernel to resolve a solid, in metres. `0` otherwise. Grows with
     * distance from the world origin, as the kernel's own tolerance does.
     * @returns {number}
     */
    get requiredM() {
        const ret = wasm.clashintersectionsolidjs_requiredM(this.__wbg_ptr);
        return ret;
    }
    /**
     * For `"below-kernel-resolution"`: the overlap's measured thinnest extent,
     * in metres. `0` otherwise. Useful to tell the user how shallow the clash
     * is even though no solid can be drawn.
     * @returns {number}
     */
    get thicknessM() {
        const ret = wasm.clashintersectionsolidjs_thicknessM(this.__wbg_ptr);
        return ret;
    }
    /**
     * Triangle count of the solid; `0` when degenerate.
     * @returns {number}
     */
    get triangleCount() {
        const ret = wasm.clashintersectionsolidjs_triangleCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Enclosed volume in m³. `0` when not a solid — check `isSolid` first;
     * "no measurable overlap" and "an overlap of zero" are different claims.
     * @returns {number}
     */
    get volumeM3() {
        const ret = wasm.clashintersectionsolidjs_volumeM3(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) ClashIntersectionSolidJs.prototype[Symbol.dispose] = ClashIntersectionSolidJs.prototype.free;

/**
 * Packed result of one rule run. Parallel arrays, one entry per clash record;
 * `points` has 3 per record and `bounds` has 6 per record.
 */
export class ClashRunResult {
    static __wrap(ptr) {
        const obj = Object.create(ClashRunResult.prototype);
        obj.__wbg_ptr = ptr;
        ClashRunResultFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ClashRunResultFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_clashrunresult_free(ptr, 0);
    }
    /**
     * @returns {Uint32Array}
     */
    get a() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.clashrunresult_a(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {Uint32Array}
     */
    get b() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.clashrunresult_b(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {Float64Array}
     */
    get bounds() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.clashrunresult_bounds(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {Float64Array}
     */
    get depthFloor() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.clashrunresult_depthFloor(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {Float64Array}
     */
    get distance() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.clashrunresult_distance(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {Uint8Array}
     */
    get distanceKind() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.clashrunresult_distanceKind(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {Float64Array}
     */
    get points() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.clashrunresult_points(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {Uint8Array}
     */
    get status() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.clashrunresult_status(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) ClashRunResult.prototype[Symbol.dispose] = ClashRunResult.prototype.free;

/**
 * A clash session: ingest element geometry once, then run rules repeatedly.
 */
export class ClashSession {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ClashSessionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_clashsession_free(ptr, 0);
    }
    /**
     * Ingest N elements from flat arenas.
     *
     * - `positions`: concatenated per-element vertex coords (x,y,z,...)
     * - `pos_ranges`: 2 per element = [float_offset, float_len]
     * - `indices`: concatenated per-element LOCAL (0-based) triangle indices
     * - `idx_ranges`: 2 per element = [idx_offset, idx_len]
     * - `aabbs`: 6 per element = [minx,miny,minz,maxx,maxy,maxz]
     * @param {Float32Array} positions
     * @param {Uint32Array} pos_ranges
     * @param {Uint32Array} indices
     * @param {Uint32Array} idx_ranges
     * @param {Float32Array} aabbs
     */
    ingest(positions, pos_ranges, indices, idx_ranges, aabbs) {
        const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(pos_ranges, wasm.__wbindgen_export);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray32ToWasm0(indices, wasm.__wbindgen_export);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArray32ToWasm0(idx_ranges, wasm.__wbindgen_export);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArrayF32ToWasm0(aabbs, wasm.__wbindgen_export);
        const len4 = WASM_VECTOR_LEN;
        wasm.clashsession_ingest(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4);
    }
    constructor() {
        const ret = wasm.clashsession_new();
        this.__wbg_ptr = ret;
        ClashSessionFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Run one rule. `group_a`/`group_b` are GLOBAL element indices.
     * OMIT `group_b` (pass `undefined`/`null`) for a self-clash within
     * `group_a`; pass an array -- INCLUDING an empty one -- for a two-sided
     * rule. An empty array is a B side that matched nothing and yields no
     * clashes, which is why this is nullable rather than "empty means
     * self" (#5354). `mode`: 0 = hard, 1 = clearance. Records carry GLOBAL
     * element indices.
     * @param {Uint32Array} group_a
     * @param {Uint32Array | null | undefined} group_b
     * @param {number} mode
     * @param {number} tolerance
     * @param {number} clearance
     * @param {boolean} report_touch
     * @returns {ClashRunResult}
     */
    runRule(group_a, group_b, mode, tolerance, clearance, report_touch) {
        const ptr0 = passArray32ToWasm0(group_a, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        var ptr1 = isLikeNone(group_b) ? 0 : passArray32ToWasm0(group_b, wasm.__wbindgen_export);
        var len1 = WASM_VECTOR_LEN;
        const ret = wasm.clashsession_runRule(this.__wbg_ptr, ptr0, len0, ptr1, len1, mode, tolerance, clearance, report_touch);
        return ClashRunResult.__wrap(ret);
    }
}
if (Symbol.dispose) ClashSession.prototype[Symbol.dispose] = ClashSession.prototype.free;

/**
 * A set of closed 2D rings, grouped into disjoint shapes.
 *
 * Rings carry no duplicated closing vertex (connect the last point back to
 * the first). Winding is meaningful: a counter-clockwise ring covers area, a
 * clockwise one removes it, so an outer boundary and its holes are
 * distinguishable without any extra tagging — the property
 * `meshOutline2d`'s flattened contour list relies on too.
 */
export class Contours2D {
    static __wrap(ptr) {
        const obj = Object.create(Contours2D.prototype);
        obj.__wbg_ptr = ptr;
        Contours2DFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        Contours2DFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_contours2d_free(ptr, 0);
    }
    /**
     * Axis-aligned bounds as `[minX, minY, maxX, maxY]`, or `undefined` when
     * empty. Cheap enough to gate the boolean itself: an accumulated occluder
     * whose bounds miss the next element needs no difference at all.
     * @returns {Float64Array | undefined}
     */
    bounds() {
        const ret = wasm.contours2d_bounds(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Every ring's coordinates concatenated. Paired with `ringLengths()` this
     * reconstructs the set through the constructor, and reads a whole result
     * back in one boundary crossing instead of one per ring. It round-trips the
     * constructor's *sanitised* rings — degenerate rings and explicit closing
     * vertices are dropped at construction, so those are not echoed back.
     * @returns {Float64Array}
     */
    coords() {
        const ret = wasm.contours2d_coords(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Adopt the rings of a `meshOutline2d` result, widening its f32
     * coordinates to the f64 the boolean engine works in.
     *
     * The outline's `axisMin`/`axisMax` are dropped — they describe the cut
     * axis, which a 2D boolean has no notion of; keep them on the JS side if
     * the caller still needs them for band classification.
     * @param {MeshOutlineJs} outline
     * @returns {Contours2D}
     */
    static fromMeshOutline(outline) {
        _assertClass(outline, MeshOutlineJs);
        const ret = wasm.contours2d_fromMeshOutline(outline.__wbg_ptr);
        return Contours2D.__wrap(ret);
    }
    /**
     * True when the set holds no rings. Degenerate rings are dropped at
     * construction and never emitted by an operation, so this also means the
     * set covers no area.
     * @returns {boolean}
     */
    get isEmpty() {
        const ret = wasm.contours2d_isEmpty(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Build a contour set from flat coordinates plus per-ring vertex counts.
     *
     * `coords` is `[x0, y0, x1, y1, …]` with every ring concatenated in order;
     * `ringLengths[i]` is the VERTEX count (not the float count) of ring `i`.
     * Throws when the counts do not add up to `coords.length / 2`.
     *
     * Shape grouping is a property of boolean *results*: a set built here is
     * an unstructured ring soup, so `shapeCount` reports 0 until it has been
     * through an operation (`resolve2d` alone is enough). Degenerate rings
     * (under 3 vertices, non-finite, or exactly collinear) are dropped at
     * construction, so `isEmpty`/`bounds()` report the same rings a later
     * boolean would keep rather than exposing an unsanitised soup.
     * @param {Float64Array} coords
     * @param {Uint32Array} ring_lengths
     */
    constructor(coords, ring_lengths) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArrayF64ToWasm0(coords, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray32ToWasm0(ring_lengths, wasm.__wbindgen_export);
            const len1 = WASM_VECTOR_LEN;
            wasm.contours2d_new(retptr, ptr0, len0, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            this.__wbg_ptr = r0;
            Contours2DFinalization.register(this, this.__wbg_ptr, this);
            return this;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Ring `index` as a flat `[x0, y0, x1, y1, …]` array, or `undefined` when
     * out of range.
     * @param {number} index
     * @returns {Float64Array | undefined}
     */
    ring(index) {
        const ret = wasm.contours2d_ring(this.__wbg_ptr, index);
        return takeObject(ret);
    }
    /**
     * Total number of boundary rings across every shape.
     * @returns {number}
     */
    get ringCount() {
        const ret = wasm.contours2d_ringCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Vertex count of each ring, in the same order as `coords()`.
     * @returns {Uint32Array}
     */
    ringLengths() {
        const ret = wasm.contours2d_ringLengths(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Number of disjoint shapes, or 0 for a set that has not been through an
     * operation yet (see the constructor).
     * @returns {number}
     */
    get shapeCount() {
        const ret = wasm.contours2d_shapeCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Ring index at which each shape starts. Entry `s` is shape `s`'s OUTER
     * ring; the rings up to the next entry (or `ringCount`) are its holes.
     * @returns {Uint32Array}
     */
    shapeOffsets() {
        const ret = wasm.contours2d_shapeOffsets(this.__wbg_ptr);
        return takeObject(ret);
    }
}
if (Symbol.dispose) Contours2D.prototype[Symbol.dispose] = Contours2D.prototype.free;

/**
 * A collection of resolved grid axes.
 */
export class GridAxisCollection {
    static __wrap(ptr) {
        const obj = Object.create(GridAxisCollection.prototype);
        obj.__wbg_ptr = ptr;
        GridAxisCollectionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        GridAxisCollectionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_gridaxiscollection_free(ptr, 0);
    }
    /**
     * Get the axis at `index`. Returns `undefined` for out-of-bounds index.
     * @param {number} index
     * @returns {GridAxisJs | undefined}
     */
    getAxis(index) {
        const ret = wasm.gridaxiscollection_getAxis(this.__wbg_ptr, index);
        return ret === 0 ? undefined : GridAxisJs.__wrap(ret);
    }
    /**
     * Whether the collection is empty.
     * @returns {boolean}
     */
    get isEmpty() {
        const ret = wasm.gridaxiscollection_isEmpty(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Number of grid axes.
     * @returns {number}
     */
    get length() {
        const ret = wasm.gridaxiscollection_length(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) GridAxisCollection.prototype[Symbol.dispose] = GridAxisCollection.prototype.free;

/**
 * One grid axis: tag + endpoints in renderer Y-up world space (metres).
 */
export class GridAxisJs {
    static __wrap(ptr) {
        const obj = Object.create(GridAxisJs.prototype);
        obj.__wbg_ptr = ptr;
        GridAxisJsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        GridAxisJsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_gridaxisjs_free(ptr, 0);
    }
    /**
     * Express ID of the `IfcGridAxis`.
     * @returns {number}
     */
    get axisId() {
        const ret = wasm.gridaxisjs_axisId(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * End endpoint `[x, y, z]` in renderer Y-up world space (metres).
     * @returns {Float32Array}
     */
    get end() {
        const ret = wasm.gridaxisjs_end(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Express ID of the owning `IfcGrid`.
     * @returns {number}
     */
    get gridId() {
        const ret = wasm.gridaxisjs_gridId(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Start endpoint `[x, y, z]` in renderer Y-up world space (metres).
     * @returns {Float32Array}
     */
    get start() {
        const ret = wasm.gridaxisjs_start(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Axis tag (e.g. `"A"`, `"1"`); empty string when unauthored.
     * @returns {string}
     */
    get tag() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.gridaxisjs_tag(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) GridAxisJs.prototype[Symbol.dispose] = GridAxisJs.prototype.free;

/**
 * Main IFC-Lite API
 */
export class IfcAPI {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        IfcAPIFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_ifcapi_free(ptr, 0);
    }
    /**
     * Run the pre-pass ONCE and return serialized results for worker distribution.
     * Takes raw bytes (&[u8]) to avoid TextDecoder overhead.
     * @param {Uint8Array} data
     * @returns {any}
     */
    buildPrePassOnce(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_buildPrePassOnce(this.__wbg_ptr, ptr0, len0);
        return takeObject(ret);
    }
    /**
     * Streaming pre-pass: emits geometry jobs in chunks via a JS callback
     * instead of waiting for the full file scan to complete.
     *
     * Single linear walk over the file:
     *   1. Builds the entity index incrementally from the same scan that
     *      collects geometry jobs (a separate index scan would double
     *      wall-clock).
     *   2. As soon as `IFCPROJECT` has been seen, the unit scale and the
     *      first ~50 geometry jobs have been collected, resolves
     *      `unitScale` + `rtcOffset` and emits a `meta` callback so the
     *      JS host can spin up geometry process workers.
     *   3. Emits `jobs` callbacks every `chunk_size` jobs (or fewer if
     *      the meta phase already buffered some).
     *   4. Emits `complete` with the total job count at end of scan.
     *
     * On a 986 MB / 14 M-entity file this drops time-to-first-geometry
     * from ~17 s (full pre-pass + worker spawn + first batch) to ~3 s
     * (first 100 K bytes scanned + meta + first chunk).
     *
     * The callback receives a single `JsValue` argument shaped as one of:
     *   `{ type: "meta", unitScale, rtcOffset: [x,y,z], needsShift, buildingRotation? }`
     *   `{ type: "jobs", jobs: Uint32Array }`     // [id, start, end] triples
     *   `{ type: "complete", totalJobs }`
     * @param {Uint8Array} data
     * @param {Function} on_event
     * @param {number} chunk_size
     * @param {string[] | null | undefined} disabled_type_names
     * @param {boolean} skip_type_geometry
     * @returns {any}
     */
    buildPrePassStreaming(data, on_event, chunk_size, disabled_type_names, skip_type_geometry) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            var ptr1 = isLikeNone(disabled_type_names) ? 0 : passArrayJsValueToWasm0(disabled_type_names, wasm.__wbindgen_export);
            var len1 = WASM_VECTOR_LEN;
            wasm.ifcapi_buildPrePassStreaming(retptr, this.__wbg_ptr, ptr0, len0, addBorrowedObject(on_event), chunk_size, ptr1, len1, skip_type_geometry);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            heap[stack_pointer++] = undefined;
        }
    }
    /**
     * Sharded pre-pass variant: same scan/discovery/jobs/columns pipeline as
     * `buildPrePassStreaming`, but
     *  1. the entity index is PREBUILT from the host's stitched shard columns
     *     (file order; see `scanEntityIndexShard`) — the scan skips its inline
     *     index build, the meta RTC ladder resolves against the FULL index
     *     (no partial-ladder full-rescan detour), and the post-scan
     *     `entity-index` event is skipped (the host already delivered it), and
     *  2. styles resolution is EXTERNAL: the styled-item spans are resolved as
     *     shard slices on the geometry workers (`resolveStyledItemsShard`);
     *     this call stashes the SUPPORT spans + plane-angle scale, and the
     *     follow-up `finalizePrepassStyles` merges + flattens into the exact
     *     styles payload the serial path emits. NO `styles` event is emitted
     *     here.
     * @param {Uint8Array} data
     * @param {Function} on_event
     * @param {number} chunk_size
     * @param {string[] | null | undefined} disabled_type_names
     * @param {boolean} skip_type_geometry
     * @param {Uint32Array} index_ids
     * @param {Uint32Array} index_starts
     * @param {Uint32Array} index_lengths
     * @param {Uint8Array} index_classes
     * @returns {any}
     */
    buildPrePassStreamingSharded(data, on_event, chunk_size, disabled_type_names, skip_type_geometry, index_ids, index_starts, index_lengths, index_classes) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            var ptr1 = isLikeNone(disabled_type_names) ? 0 : passArrayJsValueToWasm0(disabled_type_names, wasm.__wbindgen_export);
            var len1 = WASM_VECTOR_LEN;
            const ptr2 = passArray32ToWasm0(index_ids, wasm.__wbindgen_export);
            const len2 = WASM_VECTOR_LEN;
            const ptr3 = passArray32ToWasm0(index_starts, wasm.__wbindgen_export);
            const len3 = WASM_VECTOR_LEN;
            const ptr4 = passArray32ToWasm0(index_lengths, wasm.__wbindgen_export);
            const len4 = WASM_VECTOR_LEN;
            const ptr5 = passArray8ToWasm0(index_classes, wasm.__wbindgen_export);
            const len5 = WASM_VECTOR_LEN;
            wasm.ifcapi_buildPrePassStreamingSharded(retptr, this.__wbg_ptr, ptr0, len0, addBorrowedObject(on_event), chunk_size, ptr1, len1, skip_type_geometry, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            heap[stack_pointer++] = undefined;
        }
    }
    /**
     * Existing sharded prepass plus an exact full-source key in complete.
     * @param {Uint8Array} data
     * @param {Function} on_event
     * @param {number} chunk_size
     * @param {string[] | null | undefined} disabled_type_names
     * @param {boolean} skip_type_geometry
     * @param {Uint32Array} index_ids
     * @param {Uint32Array} index_starts
     * @param {Uint32Array} index_lengths
     * @param {Uint8Array} index_classes
     * @returns {any}
     */
    buildPrePassStreamingShardedWithSourceFingerprint(data, on_event, chunk_size, disabled_type_names, skip_type_geometry, index_ids, index_starts, index_lengths, index_classes) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            var ptr1 = isLikeNone(disabled_type_names) ? 0 : passArrayJsValueToWasm0(disabled_type_names, wasm.__wbindgen_export);
            var len1 = WASM_VECTOR_LEN;
            const ptr2 = passArray32ToWasm0(index_ids, wasm.__wbindgen_export);
            const len2 = WASM_VECTOR_LEN;
            const ptr3 = passArray32ToWasm0(index_starts, wasm.__wbindgen_export);
            const len3 = WASM_VECTOR_LEN;
            const ptr4 = passArray32ToWasm0(index_lengths, wasm.__wbindgen_export);
            const len4 = WASM_VECTOR_LEN;
            const ptr5 = passArray8ToWasm0(index_classes, wasm.__wbindgen_export);
            const len5 = WASM_VECTOR_LEN;
            wasm.ifcapi_buildPrePassStreamingShardedWithSourceFingerprint(retptr, this.__wbg_ptr, ptr0, len0, addBorrowedObject(on_event), chunk_size, ptr1, len1, skip_type_geometry, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            heap[stack_pointer++] = undefined;
        }
    }
    /**
     * Existing streaming prepass plus an exact full-source key in complete.
     * @param {Uint8Array} data
     * @param {Function} on_event
     * @param {number} chunk_size
     * @param {string[] | null | undefined} disabled_type_names
     * @param {boolean} skip_type_geometry
     * @returns {any}
     */
    buildPrePassStreamingWithSourceFingerprint(data, on_event, chunk_size, disabled_type_names, skip_type_geometry) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            var ptr1 = isLikeNone(disabled_type_names) ? 0 : passArrayJsValueToWasm0(disabled_type_names, wasm.__wbindgen_export);
            var len1 = WASM_VECTOR_LEN;
            wasm.ifcapi_buildPrePassStreamingWithSourceFingerprint(retptr, this.__wbg_ptr, ptr0, len0, addBorrowedObject(on_event), chunk_size, ptr1, len1, skip_type_geometry);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            heap[stack_pointer++] = undefined;
        }
    }
    /**
     * Calibrate one raster plane from native-source landmarks and a measured
     * world span. Returns UTF-8 CalibratedPlane JSON. Constant bounded work;
     * does not read IFC, decode image pixels or mutate a model.
     * @param {string} request_json
     * @returns {Uint8Array}
     */
    calibrateAppearancePlane(request_json) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(request_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.ifcapi_calibrateAppearancePlane(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Catalog effective IfcProduct classes and IfcRelDefinesByType membership.
     * JSON input is AppearanceCatalogRequest; output is AppearanceCatalog JSON.
     * Run in a worker and validate sourceRevision before using the selectors.
     * @param {Uint8Array} content
     * @param {string} request_json
     * @returns {Uint8Array}
     */
    catalogAppearance(content, request_json) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(content, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(request_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            wasm.ifcapi_catalogAppearance(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v3 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v3;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Clear the cached entity index (call between loads when reusing
     * the same `IfcAPI` instance — e.g. the parser worker keeps one
     * `IfcAPI` alive across multiple `parse` requests).
     *
     * Recovers a poisoned cache Mutex instead of panicking; see `mod_tests.rs`.
     */
    clearPrePassCache() {
        wasm.ifcapi_clearPrePassCache(this.__wbg_ptr);
    }
    /**
     * Starts one owned raw-byte LandXML session. The caller must free or abort
     * the session on every cancellation path.
     *
     * `options` is the same shape `parseLandXmlSourceBytesWithOptions`
     * accepts (see `LandXmlParseOptionsJs`) and is optional so every
     * existing single-argument call site keeps working unchanged. A bad
     * `assumedLinearUnit` token (or any other invalid option) refuses here,
     * at session construction, never partway through a stream (#5175).
     * @param {number} max_bytes
     * @param {LandXmlParseOptionsJs | null} [options]
     * @returns {LandXmlTinStreamSession}
     */
    createLandXmlTinStreamSession(max_bytes, options) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.ifcapi_createLandXmlTinStreamSession(retptr, this.__wbg_ptr, max_bytes, isLikeNone(options) ? 0 : addHeapObject(options));
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return LandXmlTinStreamSession.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Run geometry extraction on `content` and return its typed CSG / opening
     * diagnostics (the `GeometryDiagnostics` contract) as a JS object, or
     * `undefined` when nothing diagnostic-worthy happened (no openings, no
     * failures). Takes the raw IFC bytes (`Uint8Array`) so there is no input-size
     * cap. The produced meshes are dropped; only the diagnostics are returned.
     * @param {Uint8Array} content
     * @returns {any}
     */
    diagnoseGeometry(content) {
        const ptr0 = passArray8ToWasm0(content, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_diagnoseGeometry(this.__wbg_ptr, ptr0, len0);
        return takeObject(ret);
    }
    /**
     * Export tabular **CSV**. `mode` ∈ {`"entities"`, `"properties"`, `"quantities"`,
     * `"spatial"`}. `delimiter` defaults to `,` when empty; `include_properties` adds
     * flattened `Pset_Prop` columns to the entities view.
     * @param {Uint8Array} content
     * @param {string} mode
     * @param {string} delimiter
     * @param {boolean} include_properties
     * @returns {Uint8Array}
     */
    exportCsv(content, mode, delimiter, include_properties) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(content, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(mode, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passStringToWasm0(delimiter, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len2 = WASM_VECTOR_LEN;
            wasm.ifcapi_exportCsv(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, include_properties);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v4 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v4;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Export the `IfcSpace` volumes in `content` as a Dragonfly **DFJSON** string.
     *
     * Each space becomes an extruded `Room2D` (floor polygon + floor-to-ceiling height)
     * grouped into stories — the simpler Ladybug Tools target for mostly-vertical-wall
     * models. Loads via `dragonfly.model.Model.from_dfjson`.
     *
     * ```javascript
     * const api = new IfcAPI();
     * const dfjson = api.exportDfjson(ifcContent, "my_model");
     * ```
     * @param {Uint8Array} content
     * @param {string} name
     * @returns {string}
     */
    exportDfjson(content, name) {
        let deferred3_0;
        let deferred3_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(content, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(name, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            wasm.ifcapi_exportDfjson(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred3_0 = r0;
            deferred3_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Export the render geometry in `content` as a binary **GLB** (`Uint8Array`).
     *
     * `hidden` / `isolated` are express-id visibility filters; `hidden_types_csv` is a
     * comma-separated list of IFC type names whose class toggle is off (e.g.
     * `"IfcOpeningElement,IfcSpace"`). `isolated` carries the isolation allowlist's
     * null-vs-empty distinction across the wasm boundary: omit it (`undefined`) for
     * "no isolation filter" (every mesh is a candidate); pass an empty `Uint32Array`
     * for "isolation is ACTIVE and currently matches nothing" (every mesh is
     * excluded). Collapsing the two — as a bare `Uint32Array` parameter would force a
     * caller to do — silently exports the whole model when a filter matches nothing
     * (#4328 follow-up: reachable by filtering the Class tab to a type present only
     * in a federated model's secondary member, then exporting "Visible Only"). A
     * non-empty `Uint32Array` is the ordinary allowlist. `include_metadata` attaches
     * counts + per-node `expressId`. Per-mesh RTC origin rides the node translation
     * (precision-safe).
     * `lit` emits standard PBR materials that shade from normals; omitted or
     * `true` ⇒ lit (the default), `false` ⇒ flat `KHR_materials_unlit` (the
     * historical look — #1321). Optional at the boundary so older 5-arg callers
     * keep lit-by-default behaviour.
     * `emissive` self-illuminates each material at its base colour (core glTF
     * `emissiveFactor`) so renderers without ambient/IBL — Google Earth — don't
     * render the model near-black (#1427); omitted or `false` ⇒ off.
     *
     * Fails CLOSED: when the visible mesh set is empty this throws an `Error`
     * whose message starts with `NO_RENDER_GEOMETRY`, instead of returning a
     * structurally valid but empty GLB. #1438 put that guard only in the TS
     * CLI/MCP wrappers; making the boundary itself refuse means SDK/viewer/
     * direct callers inherit it too (the TS guards stay as defense-in-depth).
     * @param {Uint8Array} content
     * @param {boolean} include_metadata
     * @param {Uint32Array} hidden
     * @param {Uint32Array | null | undefined} isolated
     * @param {string} hidden_types_csv
     * @param {boolean | null} [lit]
     * @param {boolean | null} [emissive]
     * @returns {Uint8Array}
     */
    exportGlb(content, include_metadata, hidden, isolated, hidden_types_csv, lit, emissive) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(content, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray32ToWasm0(hidden, wasm.__wbindgen_export);
            const len1 = WASM_VECTOR_LEN;
            var ptr2 = isLikeNone(isolated) ? 0 : passArray32ToWasm0(isolated, wasm.__wbindgen_export);
            var len2 = WASM_VECTOR_LEN;
            const ptr3 = passStringToWasm0(hidden_types_csv, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len3 = WASM_VECTOR_LEN;
            wasm.ifcapi_exportGlb(retptr, this.__wbg_ptr, ptr0, len0, include_metadata, ptr1, len1, ptr2, len2, ptr3, len3, isLikeNone(lit) ? 0xFFFFFF : lit ? 1 : 0, isLikeNone(emissive) ? 0xFFFFFF : emissive ? 1 : 0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v5 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v5;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Assemble a **GLB** from already-produced meshes (the viewer's `MeshData`, flattened)
     * — no re-meshing. Per mesh `i`: `vertex_counts[i]` verts + `index_counts[i]` indices
     * taken in order from the concatenated `positions`/`normals`/`indices`; `colors` is
     * RGBA per mesh, `origins` xyz per mesh, `express_ids` labels each mesh (indices are
     * per-mesh local). The caller passes exactly the meshes it wants emitted.
     *
     * Fails CLOSED: if the declared vertex/index counts run past the flattened
     * `positions` / `indices`, there are fewer `index_counts` than meshes, `normals`
     * is empty or too short to cover every vertex, a mesh's index block is not a
     * whole number of triangles, or an index names a vertex its own mesh does not
     * have (glTF 2.0 3.7.2.1), this throws an `Error` whose message starts with
     * `MALFORMED_MESH_INPUT` — instead of silently emitting a GLB with those meshes
     * dropped, a TRIANGLES primitive whose count is not a multiple of 3, or the
     * out-of-range index copied into the BIN chunk. (The viewer always passes
     * fully-backed, normal-covered, whole-triangle, in-range arrays, so this only
     * fires on a caller bug.)
     *
     * `world_matrix` is the frame the meshes were baked in (#7734): 16 finite
     * numbers, a column-major 4x4 in IFC Z-up metres with `world = M * baked`
     * (the viewer builds it from `CoordinateInfo`). The GLB root carries it, so
     * a georeferenced model exports where the from-bytes `exportGlb` puts it
     * instead of in the render frame. Omit it (`undefined`) for an unshifted
     * model; a matrix that is not 16 finite numbers throws
     * `MALFORMED_MESH_INPUT`.
     * @param {Float32Array} positions
     * @param {Float32Array} normals
     * @param {Uint32Array} indices
     * @param {Uint32Array} vertex_counts
     * @param {Uint32Array} index_counts
     * @param {Float32Array} colors
     * @param {Float64Array} origins
     * @param {Uint32Array} express_ids
     * @param {boolean} include_metadata
     * @param {boolean | null} [lit]
     * @param {boolean | null} [emissive]
     * @param {Float64Array | null} [world_matrix]
     * @returns {Uint8Array}
     */
    exportGlbFromMeshes(positions, normals, indices, vertex_counts, index_counts, colors, origins, express_ids, include_metadata, lit, emissive, world_matrix) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArrayF32ToWasm0(normals, wasm.__wbindgen_export);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passArray32ToWasm0(indices, wasm.__wbindgen_export);
            const len2 = WASM_VECTOR_LEN;
            const ptr3 = passArray32ToWasm0(vertex_counts, wasm.__wbindgen_export);
            const len3 = WASM_VECTOR_LEN;
            const ptr4 = passArray32ToWasm0(index_counts, wasm.__wbindgen_export);
            const len4 = WASM_VECTOR_LEN;
            const ptr5 = passArrayF32ToWasm0(colors, wasm.__wbindgen_export);
            const len5 = WASM_VECTOR_LEN;
            const ptr6 = passArrayF64ToWasm0(origins, wasm.__wbindgen_export);
            const len6 = WASM_VECTOR_LEN;
            const ptr7 = passArray32ToWasm0(express_ids, wasm.__wbindgen_export);
            const len7 = WASM_VECTOR_LEN;
            var ptr8 = isLikeNone(world_matrix) ? 0 : passArrayF64ToWasm0(world_matrix, wasm.__wbindgen_export);
            var len8 = WASM_VECTOR_LEN;
            wasm.ifcapi_exportGlbFromMeshes(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, include_metadata, isLikeNone(lit) ? 0xFFFFFF : lit ? 1 : 0, isLikeNone(emissive) ? 0xFFFFFF : emissive ? 1 : 0, ptr8, len8);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v10 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v10;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Export the `IfcSpace` volumes in `content` as Honeybee **HBJSON** UTF-8 bytes.
     *
     * Returned as UTF-8 bytes (`Uint8Array`) so output is not capped by the
     * V8 max-string ceiling (~512 MB); decode with `TextDecoder` when a string
     * is genuinely needed.
     *
     * Rooms are built analytically from extruded-area profiles (watertight by construction);
     * faces are typed Floor / RoofCeiling / Wall with outward normals. The result loads via
     * `honeybee.model.Model.from_hbjson` and is ready for Ladybug Tools / Pollination.
     *
     * ```javascript
     * const api = new IfcAPI();
     * const hbjson = api.exportHbjson(ifcContent, "my_model");
     * ```
     * @param {Uint8Array} content
     * @param {string} name
     * @returns {Uint8Array}
     */
    exportHbjson(content, name) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(content, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(name, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            wasm.ifcapi_exportHbjson(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v3 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v3;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Like [`Self::export_hbjson`], but also returns the export's coverage stats
     * (`HbjsonStats`: spaces seen, rooms emitted, spaces skipped as degenerate, plus
     * apertures / doors / shades / constructions / interior adjacencies) so a caller
     * can tell whether the "success" result silently dropped input.
     *
     * Returns a plain JS object `{ content: Uint8Array, stats: HbjsonStats }`; `content`
     * is UTF-8 HBJSON bytes (same encoding rationale as [`Self::export_hbjson`] — not
     * capped by the V8 max-string ceiling). Runs the export once — `content` and `stats`
     * come from the same pass, not two separate exports.
     *
     * ```javascript
     * const api = new IfcAPI();
     * const { content, stats } = api.exportHbjsonWithStats(ifcContent, "my_model");
     * if (stats.skipped > 0) console.warn(`${stats.skipped} spaces skipped as degenerate`);
     * ```
     * @param {Uint8Array} content
     * @param {string} name
     * @returns {any}
     */
    exportHbjsonWithStats(content, name) {
        const ptr0 = passArray8ToWasm0(content, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(name, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_exportHbjsonWithStats(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        return takeObject(ret);
    }
    /**
     * Export **IFC5 / IFCX** (the USD-style node graph). `only_known_properties` keeps
     * only properties with an official IFC5 schema.
     * @param {Uint8Array} content
     * @param {boolean} only_known_properties
     * @param {boolean} pretty
     * @returns {Uint8Array}
     */
    exportIfcx(content, only_known_properties, pretty) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(content, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.ifcapi_exportIfcx(retptr, this.__wbg_ptr, ptr0, len0, only_known_properties, pretty);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Export structured **JSON** (array of entity objects with typed property values).
     * @param {Uint8Array} content
     * @param {boolean} pretty
     * @param {boolean} include_properties
     * @param {boolean} include_quantities
     * @returns {Uint8Array}
     */
    exportJson(content, pretty, include_properties, include_quantities) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(content, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.ifcapi_exportJson(retptr, this.__wbg_ptr, ptr0, len0, pretty, include_properties, include_quantities);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Export **JSON-LD** (`@graph` of `ifc:` nodes). Empty `context` ⇒ buildingSMART
     * IFC4 OWL default.
     *
     * `included` is an express-id isolation filter mirroring `exportObj` /
     * `exportGlb`, and carries the same null-vs-empty distinction across the wasm
     * boundary: omit it (`undefined`) for "no isolation filter" (every entity is
     * emitted); pass an empty `Uint32Array` for "isolation is ACTIVE and currently
     * matches nothing", which emits an empty `@graph`. Collapsing the two — as a
     * bare `Uint32Array` parameter would force a caller to do — silently exported
     * the whole model when a filter matched nothing (#4659, the JSON-LD twin of
     * #4483/#4484). A non-empty `Uint32Array` is the ordinary allowlist.
     * @param {Uint8Array} content
     * @param {string} context
     * @param {boolean} include_properties
     * @param {boolean} include_quantities
     * @param {boolean} pretty
     * @param {Uint32Array | null} [included]
     * @returns {Uint8Array}
     */
    exportJsonld(content, context, include_properties, include_quantities, pretty, included) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(content, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(context, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            var ptr2 = isLikeNone(included) ? 0 : passArray32ToWasm0(included, wasm.__wbindgen_export);
            var len2 = WASM_VECTOR_LEN;
            wasm.ifcapi_exportJsonld(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, include_properties, include_quantities, pretty, ptr2, len2);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v4 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v4;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Build a Google-Earth-ready **KMZ** (`Uint8Array`) straight from the viewer's
     * already-produced meshes — the working path (#1427). The model is embedded as
     * **COLLADA** (`model.dae`), the only `<Model>` format Google Earth loads (a GLB
     * raises "Unsupported element: Model"), with emission-lit double-sided materials
     * placement. Mesh arrays match `exportGlbFromMeshes`;
     * `latitude`/`longitude`/`altitude` + `x_axis_abscissa`/`x_axis_ordinate`
     * (grid-north, `undefined` ⇒ heading 0) place + orient the model.
     * `altitude_mode` (`"clampToGround"` default ⇒ rest on terrain, ignoring
     * `altitude`; `"absolute"` ⇒ place at `altitude` metres MSL) selects the
     * KML vertical placement (#1427).
     *
     * Fails CLOSED: when no triangle survives (an empty visible set, or meshes
     * whose only triangles are degenerate and collapse in the vertex dedup)
     * this throws an `Error` whose message starts with `NO_RENDER_GEOMETRY`;
     * a declared vertex/index count running past its buffer, an index block
     * that is not whole triangles, or an index outside its mesh throws
     * `MALFORMED_MESH_INPUT`, exactly as `exportGlbFromMeshes` does. These used
     * to ship as a "successful" archive: an empty one around a COLLADA
     * document the 1.4.1 schema rejects, or one with meshes or faces missing.
     * @param {Float32Array} positions
     * @param {Float32Array} normals
     * @param {Uint32Array} indices
     * @param {Uint32Array} vertex_counts
     * @param {Uint32Array} index_counts
     * @param {Float32Array} colors
     * @param {Float64Array} origins
     * @param {number} latitude
     * @param {number} longitude
     * @param {number} altitude
     * @param {number | null | undefined} x_axis_abscissa
     * @param {number | null | undefined} x_axis_ordinate
     * @param {string} name
     * @param {string | null} [altitude_mode]
     * @returns {Uint8Array}
     */
    exportKmzFromMeshes(positions, normals, indices, vertex_counts, index_counts, colors, origins, latitude, longitude, altitude, x_axis_abscissa, x_axis_ordinate, name, altitude_mode) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArrayF32ToWasm0(normals, wasm.__wbindgen_export);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passArray32ToWasm0(indices, wasm.__wbindgen_export);
            const len2 = WASM_VECTOR_LEN;
            const ptr3 = passArray32ToWasm0(vertex_counts, wasm.__wbindgen_export);
            const len3 = WASM_VECTOR_LEN;
            const ptr4 = passArray32ToWasm0(index_counts, wasm.__wbindgen_export);
            const len4 = WASM_VECTOR_LEN;
            const ptr5 = passArrayF32ToWasm0(colors, wasm.__wbindgen_export);
            const len5 = WASM_VECTOR_LEN;
            const ptr6 = passArrayF64ToWasm0(origins, wasm.__wbindgen_export);
            const len6 = WASM_VECTOR_LEN;
            const ptr7 = passStringToWasm0(name, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len7 = WASM_VECTOR_LEN;
            var ptr8 = isLikeNone(altitude_mode) ? 0 : passStringToWasm0(altitude_mode, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            var len8 = WASM_VECTOR_LEN;
            wasm.ifcapi_exportKmzFromMeshes(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, latitude, longitude, altitude, !isLikeNone(x_axis_abscissa), isLikeNone(x_axis_abscissa) ? 0 : x_axis_abscissa, !isLikeNone(x_axis_ordinate), isLikeNone(x_axis_ordinate) ? 0 : x_axis_ordinate, ptr7, len7, ptr8, len8);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v10 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v10;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Export the terrain products `product_ids` (express ids) of `content` as
     * one LandXML 1.2 document, one `<Surface>` each.
     *
     * Returns JSON `{ xml, crsName, surfaces: [{ productId, globalId, name,
     * points, faces }] }`. A selection that is not an authored triangulated
     * terrain, or whose georeferencing is missing or ambiguous, throws an
     * `Error` whose message starts with `TERRAIN_REFUSED:` and names the
     * reason.
     * @param {Uint8Array} content
     * @param {Uint32Array} product_ids
     * @param {LandXmlTerrainOptionsJs} options
     * @returns {string}
     */
    exportLandXmlTerrain(content, product_ids, options) {
        let deferred4_0;
        let deferred4_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(content, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray32ToWasm0(product_ids, wasm.__wbindgen_export);
            const len1 = WASM_VECTOR_LEN;
            wasm.ifcapi_exportLandXmlTerrain(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, addHeapObject(options));
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            var ptr3 = r0;
            var len3 = r1;
            if (r3) {
                ptr3 = 0; len3 = 0;
                throw takeObject(r2);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * Merge several IFC models into one STEP/IFC UTF-8 byte buffer (`Uint8Array`).
     * `concatenated` is every model's
     * bytes laid end-to-end; `lengths[i]` is the byte length of model `i`. The first model
     * keeps its ids; later models are id-offset and their project unified to the first.
     * @param {Uint8Array} concatenated
     * @param {Uint32Array} lengths
     * @param {string} schema
     * @returns {Uint8Array}
     */
    exportMerged(concatenated, lengths, schema) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(concatenated, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray32ToWasm0(lengths, wasm.__wbindgen_export);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passStringToWasm0(schema, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len2 = WASM_VECTOR_LEN;
            wasm.ifcapi_exportMerged(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v4 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v4;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Export the render geometry in `content` as Wavefront **OBJ** UTF-8 bytes.
     *
     * Returned as UTF-8 bytes (`Uint8Array`) so output is not capped by the
     * V8 max-string ceiling (~512 MB); decode with `TextDecoder` when a string
     * is genuinely needed.
     *
     * `hidden` is an express-id filter mirroring the viewer's visibility state.
     * `isolated` carries the isolation allowlist's null-vs-empty distinction across
     * the wasm boundary: omit it (`undefined`) for "no isolation filter" (every mesh
     * is a candidate); pass an empty `Uint32Array` for "isolation is ACTIVE and
     * currently matches nothing" (every mesh is excluded). Collapsing the two — as a
     * bare `Uint32Array` parameter would force a caller to do — silently exports the
     * whole model when a filter matches nothing (the OBJ twin of #4328/#4364, fixed
     * for GLB in `export_glb`). A non-empty `Uint32Array` is the ordinary allowlist.
     * Instanced type-library shapes are skipped regardless of the filter.
     *
     * Fails CLOSED like `exportGlb`: when no mesh is written this throws an
     * `Error` whose message starts with `NO_RENDER_GEOMETRY`, instead of
     * returning a header-only OBJ (#7695).
     *
     * ```javascript
     * const obj = api.exportObj(ifcContent, true, new Uint32Array(), undefined);
     * ```
     * @param {Uint8Array} content
     * @param {boolean} include_normals
     * @param {Uint32Array} hidden
     * @param {Uint32Array | null} [isolated]
     * @returns {Uint8Array}
     */
    exportObj(content, include_normals, hidden, isolated) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(content, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray32ToWasm0(hidden, wasm.__wbindgen_export);
            const len1 = WASM_VECTOR_LEN;
            var ptr2 = isLikeNone(isolated) ? 0 : passArray32ToWasm0(isolated, wasm.__wbindgen_export);
            var len2 = WASM_VECTOR_LEN;
            wasm.ifcapi_exportObj(retptr, this.__wbg_ptr, ptr0, len0, include_normals, ptr1, len1, ptr2, len2);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v4 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v4;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Re-serialize the model in `content` to STEP/IFC UTF-8 bytes.
     *
     * Returned as UTF-8 bytes (`Uint8Array`) so output is not capped by the
     * V8 max-string ceiling (~512 MB); decode with `TextDecoder` when a string
     * is genuinely needed.
     *
     * `schema` is the FILE_SCHEMA label to write (empty ⇒ preserve the source schema).
     *
     * `included` is an express-id allowlist carrying the same null-vs-empty
     * distinction as `exportObj` / `exportGlb`: omit it (`undefined`) for "no
     * isolation filter" (whole model); pass an empty `Uint32Array` for "isolation
     * is ACTIVE and currently matches nothing", which writes a header-only file
     * with an empty `DATA;` section. Collapsing the two — as a bare `Uint32Array`
     * parameter would force a caller to do — silently exported the whole model
     * when a filter matched nothing (#4659, the STEP twin of #4483/#4484). When
     * set, the forward `#`-reference closure is added so the subset never dangles
     * a reference.
     * `mutations_json` carries `MutablePropertyView` edits; empty ⇒ none. It is
     * either the mutation log `MutablePropertyView.exportMutations()` returns
     * (an object with a `mutations` array, optionally `newEntities` and
     * `georefMutations`), written with byte parity to the TypeScript
     * `StepExporter` (#5941), or the older pre-serialized
     * `{ attributeUpdates, propertyMutations }` shape. A log does not combine
     * with `included`. See `export_step_json` for both shapes.
     * A non-empty but malformed `mutations_json` throws rather than silently
     * exporting the model with none of the caller's edits applied — mirrors
     * `exportGlb`'s and `exportMerged`'s fail-closed contract on this same API.
     * @param {Uint8Array} content
     * @param {string} schema
     * @param {Uint32Array | null | undefined} included
     * @param {string} mutations_json
     * @returns {Uint8Array}
     */
    exportStep(content, schema, included, mutations_json) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(content, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(schema, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            var ptr2 = isLikeNone(included) ? 0 : passArray32ToWasm0(included, wasm.__wbindgen_export);
            var len2 = WASM_VECTOR_LEN;
            const ptr3 = passStringToWasm0(mutations_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len3 = WASM_VECTOR_LEN;
            wasm.ifcapi_exportStep(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v5 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v5;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Export **OpenUSD** (`.usda` ASCII): a real Z-up USD stage — spatial hierarchy of
     * `Xform` prims, `UsdGeomMesh` geometry, `UsdPreviewSurface` materials, IFC
     * metadata as custom attributes. Whole-model (geometry-backed).
     *
     * Fails CLOSED like `exportGlb`: a model with no render geometry throws an
     * `Error` whose message starts with `NO_RENDER_GEOMETRY`, instead of
     * returning a stage with nothing to look at (#7695).
     * @param {Uint8Array} content
     * @returns {Uint8Array}
     */
    exportUsd(content) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(content, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.ifcapi_exportUsd(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Extract raw profile polygons from all building elements with `IfcExtrudedAreaSolid`
     * representations.
     *
     * Returns a [`ProfileCollection`] whose entries each carry:
     * - A 2D polygon (outer + holes) in local profile space (metres)
     * - A 4 × 4 column-major transform in WebGL Y-up world space
     * - Extrusion direction (world space) and depth (metres)
     *
     * Use [`ProfileProjector`] (TypeScript) to convert these into `DrawingLine[]`
     * for clean projection without tessellation artifacts.
     *
     * ```javascript
     * const api = new IfcAPI();
     * const profiles = api.extractProfiles(ifcContent, 0);
     * console.log('Profiles:', profiles.length);
     * for (let i = 0; i < profiles.length; i++) {
     *   const p = profiles.get(i);
     *   console.log(p.ifcType, 'depth:', p.extrusionDepth);
     * }
     * ```
     * @param {string} content
     * @param {number} model_index
     * @returns {ProfileCollection}
     */
    extractProfiles(content, model_index) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_extractProfiles(this.__wbg_ptr, ptr0, len0, model_index);
        return ProfileCollection.__wrap(ret);
    }
    /**
     * Return authored swept-disk occurrences, including exact line/arc
     * directrices and derived measurements, in absolute IFC Z-up metres.
     * `ids` contains product STEP IDs; omit it for all products or pass an
     * empty `Uint32Array` for none. Unsupported records keep their status and
     * a null `directrix_metrics`; malformed representation walks report a
     * diagnostic and omit that product atomically.
     * @param {Uint8Array} content
     * @param {Uint32Array | null} [ids]
     * @returns {any}
     */
    extractSweptDiskDescriptions(content, ids) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(content, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            var ptr1 = isLikeNone(ids) ? 0 : passArray32ToWasm0(ids, wasm.__wbindgen_export);
            var len1 = WASM_VECTOR_LEN;
            wasm.ifcapi_extractSweptDiskDescriptions(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * `ids` is an optional product STEP-ID filter; `None` selects all and
     * `Some([])` selects no products, matching the Rust and Python APIs.
     * Matrices are column-major f64; profile_position and position_matrix are
     * applied before world_from_source. No mesh is decoded on this path.
     * @param {Uint8Array} content
     * @param {Uint32Array | null} [ids]
     * @returns {ExtrusionDefinitionsJs}
     */
    extrusionDefinitions(content, ids) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(content, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            var ptr1 = isLikeNone(ids) ? 0 : passArray32ToWasm0(ids, wasm.__wbindgen_export);
            var len1 = WASM_VECTOR_LEN;
            wasm.ifcapi_extrusionDefinitions(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Sharded pre-pass: merge the shard-resolved styled-item columns with the
     * SUPPORT spans (extracted host-side from the shard classes) and run the
     * CANONICAL styles flatten. Returns the exact `styles` event payload the
     * serial path emits. Runs on any worker with `setEntityIndex` installed.
     * Span arguments are `[id, start, len]` triples; `plane_angle_to_radians`
     * comes from the meta event. `orphanColors` / `geomColors` carry exactly
     * four floats per id in `orphanIds` / `geomIds`; any other length throws
     * before either column is read. The payload's `styleFinishes` come from
     * the geometry finishes a preceding `setPrepassGeometryFinishes` stashed
     * (consumed here); without that call they are all NaN.
     * @param {Uint8Array} data
     * @param {Uint32Array} orphan_ids
     * @param {Float32Array} orphan_colors
     * @param {Uint32Array} geom_ids
     * @param {Float32Array} geom_colors
     * @param {Uint32Array} colour_map_spans
     * @param {Uint32Array} material_def_spans
     * @param {Uint32Array} rel_material_spans
     * @param {Uint32Array} void_spans
     * @param {Uint32Array} fills_spans
     * @param {Uint32Array} aggregate_spans
     * @param {number} plane_angle_to_radians
     * @returns {any}
     */
    finalizePrepassStyles(data, orphan_ids, orphan_colors, geom_ids, geom_colors, colour_map_spans, material_def_spans, rel_material_spans, void_spans, fills_spans, aggregate_spans, plane_angle_to_radians) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray32ToWasm0(orphan_ids, wasm.__wbindgen_export);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passArrayF32ToWasm0(orphan_colors, wasm.__wbindgen_export);
            const len2 = WASM_VECTOR_LEN;
            const ptr3 = passArray32ToWasm0(geom_ids, wasm.__wbindgen_export);
            const len3 = WASM_VECTOR_LEN;
            const ptr4 = passArrayF32ToWasm0(geom_colors, wasm.__wbindgen_export);
            const len4 = WASM_VECTOR_LEN;
            const ptr5 = passArray32ToWasm0(colour_map_spans, wasm.__wbindgen_export);
            const len5 = WASM_VECTOR_LEN;
            const ptr6 = passArray32ToWasm0(material_def_spans, wasm.__wbindgen_export);
            const len6 = WASM_VECTOR_LEN;
            const ptr7 = passArray32ToWasm0(rel_material_spans, wasm.__wbindgen_export);
            const len7 = WASM_VECTOR_LEN;
            const ptr8 = passArray32ToWasm0(void_spans, wasm.__wbindgen_export);
            const len8 = WASM_VECTOR_LEN;
            const ptr9 = passArray32ToWasm0(fills_spans, wasm.__wbindgen_export);
            const len9 = WASM_VECTOR_LEN;
            const ptr10 = passArray32ToWasm0(aggregate_spans, wasm.__wbindgen_export);
            const len10 = WASM_VECTOR_LEN;
            wasm.ifcapi_finalizePrepassStyles(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, ptr8, len8, ptr9, len9, ptr10, len10, plane_angle_to_radians);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Finalize prepass styles against the installed source and entity index.
     * @param {Uint32Array} orphan_ids
     * @param {Float32Array} orphan_colors
     * @param {Uint32Array} geom_ids
     * @param {Float32Array} geom_colors
     * @param {Uint32Array} colour_map_spans
     * @param {Uint32Array} material_def_spans
     * @param {Uint32Array} rel_material_spans
     * @param {Uint32Array} void_spans
     * @param {Uint32Array} fills_spans
     * @param {Uint32Array} aggregate_spans
     * @param {number} plane_angle_to_radians
     * @returns {any}
     */
    finalizePrepassStylesFromSource(orphan_ids, orphan_colors, geom_ids, geom_colors, colour_map_spans, material_def_spans, rel_material_spans, void_spans, fills_spans, aggregate_spans, plane_angle_to_radians) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray32ToWasm0(orphan_ids, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArrayF32ToWasm0(orphan_colors, wasm.__wbindgen_export);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passArray32ToWasm0(geom_ids, wasm.__wbindgen_export);
            const len2 = WASM_VECTOR_LEN;
            const ptr3 = passArrayF32ToWasm0(geom_colors, wasm.__wbindgen_export);
            const len3 = WASM_VECTOR_LEN;
            const ptr4 = passArray32ToWasm0(colour_map_spans, wasm.__wbindgen_export);
            const len4 = WASM_VECTOR_LEN;
            const ptr5 = passArray32ToWasm0(material_def_spans, wasm.__wbindgen_export);
            const len5 = WASM_VECTOR_LEN;
            const ptr6 = passArray32ToWasm0(rel_material_spans, wasm.__wbindgen_export);
            const len6 = WASM_VECTOR_LEN;
            const ptr7 = passArray32ToWasm0(void_spans, wasm.__wbindgen_export);
            const len7 = WASM_VECTOR_LEN;
            const ptr8 = passArray32ToWasm0(fills_spans, wasm.__wbindgen_export);
            const len8 = WASM_VECTOR_LEN;
            const ptr9 = passArray32ToWasm0(aggregate_spans, wasm.__wbindgen_export);
            const len9 = WASM_VECTOR_LEN;
            wasm.ifcapi_finalizePrepassStylesFromSource(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, ptr8, len8, ptr9, len9, plane_angle_to_radians);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Get WASM memory for zero-copy access
     * @returns {any}
     */
    getMemory() {
        const ret = wasm.ifcapi_getMemory(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Structured pipeline diagnostics accumulated across every
     * `processGeometryBatch*` call since the last load reset
     * (`clearPrePassCache` / `setEntityIndex`), as a JS object with a
     * `schemaVersion` field — or `undefined` when no batch has run yet.
     * Includes per-batch summed geometry wall time, mesh/triangle counts,
     * the degenerate-backstop drop count, and the CSG failure aggregates.
     * @returns {any}
     */
    getPipelineDiagnostics() {
        const ret = wasm.ifcapi_getPipelineDiagnostics(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Inspect authored cant and superelevation records at a physical distance.
     * Cant exposes bracketing source records only; no transition value is
     * fabricated. Superelevation blocks preserve their authored bounds.
     * @param {Uint8Array} data
     * @param {string} alignment_source_id
     * @param {number} distance
     * @returns {LandXmlAlignmentInspectionJs}
     */
    inspectLandXmlAlignmentAtDistance(data, alignment_source_id, distance) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(alignment_source_id, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            wasm.ifcapi_inspectLandXmlAlignmentAtDistance(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, distance);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Check if API is initialized
     * @returns {boolean}
     */
    get is_ready() {
        const ret = wasm.ifcapi_is_ready(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Create and initialize the IFC API
     */
    constructor() {
        const ret = wasm.ifcapi_new();
        this.__wbg_ptr = ret;
        IfcAPIFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Parse the file and return every `IfcAlignment` directrix as a flat
     * `Float32Array` of 3D line-list vertices `[x0,y0,z0, x1,y1,z1, …]` in
     * the renderer's Y-up world space (RTC-subtracted, metres). Consecutive
     * samples form line segments. Feed straight to
     * `renderer.setLineOverlay('alignment', ...)`.
     *
     * Returns an empty array when the file has no alignments (or none with a
     * resolvable Axis curve), so the caller can clear the overlay cheaply.
     * @param {string} content
     * @returns {Float32Array}
     */
    parseAlignmentLines(content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_parseAlignmentLines(this.__wbg_ptr, ptr0, len0);
        return takeObject(ret);
    }
    /**
     * Parse alignments in the exact RTC frame selected by the mesh pre-pass.
     * @param {string} content
     * @param {RtcFrame} frame
     * @returns {Float32Array}
     */
    parseAlignmentLinesInFrame(content, frame) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.ifcapi_parseAlignmentLinesInFrame(retptr, this.__wbg_ptr, ptr0, len0, addHeapObject(frame));
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Parse the file and return structured per-axis data (tag + endpoints) in
     * the renderer's Y-up world space (RTC-subtracted, metres). Use this when
     * you also need the axis tags (to render grid bubbles / labels).
     * @param {string} content
     * @returns {GridAxisCollection}
     */
    parseGridAxes(content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_parseGridAxes(this.__wbg_ptr, ptr0, len0);
        return GridAxisCollection.__wrap(ret);
    }
    /**
     * Parse structured grid axes in the exact frame selected by the mesh pre-pass.
     * @param {string} content
     * @param {RtcFrame} frame
     * @returns {GridAxisCollection}
     */
    parseGridAxesInFrame(content, frame) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.ifcapi_parseGridAxesInFrame(retptr, this.__wbg_ptr, ptr0, len0, addHeapObject(frame));
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return GridAxisCollection.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Parse the file and return every `IfcGridAxis` as a flat `Float32Array`
     * of 3D line-list vertices `[x0,y0,z0, x1,y1,z1, …]` (one segment per
     * axis) in the renderer's Y-up world space (RTC-subtracted, metres). Feed
     * straight to a line pipeline (e.g. `renderer.setLineOverlay('grid', …)`).
     *
     * Returns an empty array when the file has no grids, so the caller can
     * clear the overlay cheaply.
     * @param {string} content
     * @returns {Float32Array}
     */
    parseGridLines(content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_parseGridLines(this.__wbg_ptr, ptr0, len0);
        return takeObject(ret);
    }
    /**
     * Parse grid line vertices in the exact frame selected by the mesh pre-pass.
     * @param {string} content
     * @param {RtcFrame} frame
     * @returns {Float32Array}
     */
    parseGridLinesInFrame(content, frame) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.ifcapi_parseGridLinesInFrame(retptr, this.__wbg_ptr, ptr0, len0, addHeapObject(frame));
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Parse all currently supported LandXML source families from the original
     * bytes. Terrain-only and alignment-only sources both return an honest
     * empty sibling collection, allowing the viewer's single load path to
     * handle either form and mixed documents uniformly.
     * @param {Uint8Array} data
     * @returns {LandXmlSourceDocumentJs}
     */
    parseLandXmlSourceBytes(data) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.ifcapi_parseLandXmlSourceBytes(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Parse a source with explicit hostile-input bounds. Passing
     * `cancelled: true` refuses before entering WASM; in-flight browser
     * cancellation is performed by terminating the worker that owns this
     * synchronous operation.
     * @param {Uint8Array} data
     * @param {any} options
     * @returns {LandXmlSourceDocumentJs}
     */
    parseLandXmlSourceBytesWithOptions(data, options) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.ifcapi_parseLandXmlSourceBytesWithOptions(retptr, this.__wbg_ptr, ptr0, len0, addHeapObject(options));
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Parse a supported LandXML TIN document from its original bytes.
     *
     * The object is an owned serialization of the semantic document. Errors
     * deliberately use `LandXmlError::Display`, including its stable LXML code.
     * @param {Uint8Array} data
     * @returns {LandXmlTinDocumentJs}
     */
    parseLandXmlTinBytes(data) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.ifcapi_parseLandXmlTinBytes(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Parse IFC file and extract symbolic representations (Plan,
     * Annotation, FootPrint, Axis). These are 2D curves used for
     * architectural drawings instead of sectioning 3D geometry.
     *
     * This standalone entry point detects an RTC frame from the whole source.
     * Use `parseSymbolicRepresentationsInFrame` when the symbols accompany
     * meshes produced by a streaming pre-pass or federation override.
     *
     * Example:
     * ```javascript
     * const api = new IfcAPI();
     * const symbols = api.parseSymbolicRepresentations(ifcData);
     * console.log('Found', symbols.totalCount, 'symbolic items');
     * for (let i = 0; i < symbols.polylineCount; i++) {
     *   const polyline = symbols.getPolyline(i);
     *   console.log('Polyline for', polyline.ifcType, ':', polyline.points);
     * }
     * ```
     * @param {string} content
     * @returns {SymbolicRepresentationCollection}
     */
    parseSymbolicRepresentations(content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_parseSymbolicRepresentations(this.__wbg_ptr, ptr0, len0);
        return SymbolicRepresentationCollection.__wrap(ret);
    }
    /**
     * Parse symbolic representations in the exact RTC frame selected by the
     * browser mesh pre-pass rather than detecting a second frame from the
     * whole source.
     * @param {string} content
     * @param {RtcFrame} frame
     * @returns {SymbolicRepresentationCollection}
     */
    parseSymbolicRepresentationsInFrame(content, frame) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.ifcapi_parseSymbolicRepresentationsInFrame(retptr, this.__wbg_ptr, ptr0, len0, addHeapObject(frame));
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return SymbolicRepresentationCollection.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Create a calibrated image annotation through canonical native geometry.
     * Input is AnnotationPlaneRequest; output UTF-8 AnnotationPlanePlan JSON.
     * Does not mutate the IFC snapshot or decode the host-owned image.
     * @param {Uint8Array} content
     * @param {string} request_json
     * @returns {Uint8Array}
     */
    planAnnotationPlane(content, request_json) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(content, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(request_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            wasm.ifcapi_planAnnotationPlane(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v3 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v3;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Plan image/UV edits against an effective IFC snapshot without mutating it.
     * JSON input uses AppearanceRequest; output is UTF-8 AppearancePlan JSON.
     * Call from a worker, then validate sourceRevision and allocator before an
     * atomic host commit. Preview UVs describe an unsplit canonical mesh item.
     * @param {Uint8Array} content
     * @param {string} request_json
     * @returns {Uint8Array}
     */
    planAppearance(content, request_json) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(content, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(request_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            wasm.ifcapi_planAppearance(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v3 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v3;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Create a captured textured surface through canonical native geometry.
     * Input is CapturedMeshRequest; output UTF-8 CapturedMeshPlan JSON.
     * Does not mutate the IFC snapshot or decode the host-owned image.
     * @param {Uint8Array} content
     * @param {string} request_json
     * @returns {Uint8Array}
     */
    planCapturedMesh(content, request_json) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(content, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(request_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            wasm.ifcapi_planCapturedMesh(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v3 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v3;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Plan opt-in map similarity normalization on a completed STEP export.
     * Returns entity patches, allocated IDs and atomic refusal warnings as JSON.
     * @param {Uint8Array} content
     * @returns {string}
     */
    planMapConversionNormalization(content) {
        let deferred3_0;
        let deferred3_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(content, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.ifcapi_planMapConversionNormalization(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            var ptr2 = r0;
            var len2 = r1;
            if (r3) {
                ptr2 = 0; len2 = 0;
                throw takeObject(r2);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Registered mesh observations over canonical target albedo. Host verifies
     * original GLB identity against decoded source mesh/image and freezes frames.
     * Run in an owned cancellable worker. IFPA output adds `transfer` coverage;
     * `plan` is null when no sample is observed. Never infer accuracy approval.
     * @param {Uint8Array} content
     * @param {string} request_json
     * @param {Uint8Array} rgba
     * @returns {Uint8Array}
     */
    planMeshTransfer(content, request_json, rgba) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(content, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(request_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passArray8ToWasm0(rgba, wasm.__wbindgen_export);
            const len2 = WASM_VECTOR_LEN;
            wasm.ifcapi_planMeshTransfer(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v4 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v4;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Finite-page composition over original canonical albedo. RGBA is supplied
     * separately from the bounded JSON request. Result: IFPA magic, little-endian
     * u32 JSON byte length, metadata JSON, then PNG bytes addressed by metadata.
     * Run in a cancellable worker; atomically adopt every item asset and IFC edit.
     * @param {Uint8Array} content
     * @param {string} request_json
     * @param {Uint8Array} rgba
     * @returns {Uint8Array}
     */
    planPageAppearance(content, request_json, rgba) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(content, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(request_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passArray8ToWasm0(rgba, wasm.__wbindgen_export);
            const len2 = WASM_VECTOR_LEN;
            wasm.ifcapi_planPageAppearance(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v4 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v4;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Plan an opaque polygonal PDF fill page as canonical IfcAnnotation
     * geometry with a provenance property set. An exact page plans directly; a
     * page with visible omissions needs the accepted fidelity report digest.
     * @param {Uint8Array} source
     * @param {string} request_json
     * @returns {Uint8Array}
     */
    planPdfFillAnnotation(source, request_json) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(source, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(request_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            wasm.ifcapi_planPdfFillAnnotation(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v3 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v3;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Registered RGB point-cloud observations (#4381). `request_json.source`
     * is `{kind:'points', …}`; `positions` (3n f64, source-frame metres) and
     * `colors` (3n RGB8) are the payload, `normals` (3n f32, oriented) and
     * `stations` (n indices into `source.viewpoints`) are empty when absent.
     * `rgba` carries only the target's existing rasters. Same output as
     * `planMeshTransfer`; `transfer.source` records the orientation used.
     * @param {Uint8Array} content
     * @param {string} request_json
     * @param {Uint8Array} rgba
     * @param {Float64Array} positions
     * @param {Uint8Array} colors
     * @param {Float32Array} normals
     * @param {Uint32Array} stations
     * @returns {Uint8Array}
     */
    planPointTransfer(content, request_json, rgba, positions, colors, normals, stations) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(content, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(request_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passArray8ToWasm0(rgba, wasm.__wbindgen_export);
            const len2 = WASM_VECTOR_LEN;
            const ptr3 = passArrayF64ToWasm0(positions, wasm.__wbindgen_export);
            const len3 = WASM_VECTOR_LEN;
            const ptr4 = passArray8ToWasm0(colors, wasm.__wbindgen_export);
            const len4 = WASM_VECTOR_LEN;
            const ptr5 = passArrayF32ToWasm0(normals, wasm.__wbindgen_export);
            const len5 = WASM_VECTOR_LEN;
            const ptr6 = passArray32ToWasm0(stations, wasm.__wbindgen_export);
            const len6 = WASM_VECTOR_LEN;
            wasm.ifcapi_planPointTransfer(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v8 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v8;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Prepare bounded ordered PDF vector graphics states and the page fidelity
     * report (convertible paths, omissions with extent, exact/raster-only).
     * @param {string} request_json
     * @returns {Uint8Array}
     */
    preparePdfVectorPage(request_json) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(request_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.ifcapi_preparePdfVectorPage(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Evaluate one supported horizontal-alignment source span at an exact
     * f64 distance. The binding reuses the native validator, so malformed
     * deserialized records, discontinuities, unresolved references, and
     * unsupported transition domains are rejected rather than approximated.
     * @param {Uint8Array} data
     * @param {string} alignment_source_id
     * @param {number} distance
     * @param {number} offset_right
     * @returns {LandXmlAlignmentProbeJs}
     */
    probeLandXmlAlignmentAtDistance(data, alignment_source_id, distance, offset_right) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(alignment_source_id, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            wasm.ifcapi_probeLandXmlAlignmentAtDistance(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, distance, offset_right);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Evaluate a bounded set of physical locations carrying a displayed
     * station label. A duplicate label is real, never collapsed; an
     * excessive number is refused rather than allocated synchronously.
     * @param {Uint8Array} data
     * @param {string} alignment_source_id
     * @param {number} station
     * @param {number} offset_right
     * @returns {LandXmlAlignmentProbesJs}
     */
    probeLandXmlAlignmentAtStation(data, alignment_source_id, station, offset_right) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(alignment_source_id, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            wasm.ifcapi_probeLandXmlAlignmentAtStation(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, station, offset_right);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Process geometry for a subset of pre-scanned entities → flat
     * MeshCollection. Takes raw bytes + pre-pass data from buildPrePassOnce.
     * Thin wrapper over [`IfcAPI::produce_batch`]; converts each produced mesh
     * to MeshDataJs (the IFC Z-up→WebGL Y-up rotation with preserved winding happens
     * there). Flat indices preserve source order through this proper rotation.
     * @param {Uint8Array} data
     * @param {Uint32Array} jobs_flat
     * @param {number} unit_scale
     * @param {number} rtc_x
     * @param {number} rtc_y
     * @param {number} rtc_z
     * @param {boolean} needs_shift
     * @param {Uint32Array} void_keys
     * @param {Uint32Array} void_counts
     * @param {Uint32Array} void_values
     * @param {Uint32Array} style_ids
     * @param {Uint8Array} style_colors
     * @param {number | null} [plane_angle_to_radians]
     * @param {Uint32Array | null} [material_element_ids]
     * @param {Uint32Array | null} [material_color_counts]
     * @param {Uint8Array | null} [material_colors_rgba]
     * @returns {MeshCollection}
     */
    processGeometryBatch(data, jobs_flat, unit_scale, rtc_x, rtc_y, rtc_z, needs_shift, void_keys, void_counts, void_values, style_ids, style_colors, plane_angle_to_radians, material_element_ids, material_color_counts, material_colors_rgba) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(jobs_flat, wasm.__wbindgen_export);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray32ToWasm0(void_keys, wasm.__wbindgen_export);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArray32ToWasm0(void_counts, wasm.__wbindgen_export);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArray32ToWasm0(void_values, wasm.__wbindgen_export);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passArray32ToWasm0(style_ids, wasm.__wbindgen_export);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passArray8ToWasm0(style_colors, wasm.__wbindgen_export);
        const len6 = WASM_VECTOR_LEN;
        var ptr7 = isLikeNone(material_element_ids) ? 0 : passArray32ToWasm0(material_element_ids, wasm.__wbindgen_export);
        var len7 = WASM_VECTOR_LEN;
        var ptr8 = isLikeNone(material_color_counts) ? 0 : passArray32ToWasm0(material_color_counts, wasm.__wbindgen_export);
        var len8 = WASM_VECTOR_LEN;
        var ptr9 = isLikeNone(material_colors_rgba) ? 0 : passArray8ToWasm0(material_colors_rgba, wasm.__wbindgen_export);
        var len9 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_processGeometryBatch(this.__wbg_ptr, ptr0, len0, ptr1, len1, unit_scale, rtc_x, rtc_y, rtc_z, needs_shift, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, !isLikeNone(plane_angle_to_radians), isLikeNone(plane_angle_to_radians) ? 0 : plane_angle_to_radians, ptr7, len7, ptr8, len8, ptr9, len9);
        return MeshCollection.__wrap(ret);
    }
    /**
     * Like [`IfcAPI::process_geometry_batch`] but reads the source bytes held by
     * [`IfcAPI::set_source_bytes`] instead of taking `data`. Byte-for-byte
     * identical output — it delegates to the legacy twin with the held slice.
     * @param {Uint32Array} jobs_flat
     * @param {number} unit_scale
     * @param {number} rtc_x
     * @param {number} rtc_y
     * @param {number} rtc_z
     * @param {boolean} needs_shift
     * @param {Uint32Array} void_keys
     * @param {Uint32Array} void_counts
     * @param {Uint32Array} void_values
     * @param {Uint32Array} style_ids
     * @param {Uint8Array} style_colors
     * @param {number | null} [plane_angle_to_radians]
     * @param {Uint32Array | null} [material_element_ids]
     * @param {Uint32Array | null} [material_color_counts]
     * @param {Uint8Array | null} [material_colors_rgba]
     * @returns {MeshCollection}
     */
    processGeometryBatchFromSource(jobs_flat, unit_scale, rtc_x, rtc_y, rtc_z, needs_shift, void_keys, void_counts, void_values, style_ids, style_colors, plane_angle_to_radians, material_element_ids, material_color_counts, material_colors_rgba) {
        const ptr0 = passArray32ToWasm0(jobs_flat, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(void_keys, wasm.__wbindgen_export);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray32ToWasm0(void_counts, wasm.__wbindgen_export);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArray32ToWasm0(void_values, wasm.__wbindgen_export);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArray32ToWasm0(style_ids, wasm.__wbindgen_export);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passArray8ToWasm0(style_colors, wasm.__wbindgen_export);
        const len5 = WASM_VECTOR_LEN;
        var ptr6 = isLikeNone(material_element_ids) ? 0 : passArray32ToWasm0(material_element_ids, wasm.__wbindgen_export);
        var len6 = WASM_VECTOR_LEN;
        var ptr7 = isLikeNone(material_color_counts) ? 0 : passArray32ToWasm0(material_color_counts, wasm.__wbindgen_export);
        var len7 = WASM_VECTOR_LEN;
        var ptr8 = isLikeNone(material_colors_rgba) ? 0 : passArray8ToWasm0(material_colors_rgba, wasm.__wbindgen_export);
        var len8 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_processGeometryBatchFromSource(this.__wbg_ptr, ptr0, len0, unit_scale, rtc_x, rtc_y, rtc_z, needs_shift, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, !isLikeNone(plane_angle_to_radians), isLikeNone(plane_angle_to_radians) ? 0 : plane_angle_to_radians, ptr6, len6, ptr7, len7, ptr8, len8);
        return MeshCollection.__wrap(ret);
    }
    /**
     * Like [`IfcAPI::process_geometry_batch`] but collates the batch's meshes
     * into a GPU-instancing shard (IFNS wire format) instead of a flat
     * MeshCollection. Repeated geometry collapses to one template + per-
     * occurrence transforms; non-instanceable meshes ride as flat singleton
     * templates so nothing is dropped. The shard stays in the producer-native
     * (IFC Z-up) frame — the renderer composes the constant Z-up→Y-up swap at
     * upload. Each batch shard renders independently: affinity routing already
     * co-locates identical geometry on one worker, so per-batch collation
     * captures ~all the dedup and no cross-batch merge is needed. Returns empty
     * bytes only when the batch produced zero non-empty meshes.
     * @param {Uint8Array} data
     * @param {Uint32Array} jobs_flat
     * @param {number} unit_scale
     * @param {number} rtc_x
     * @param {number} rtc_y
     * @param {number} rtc_z
     * @param {boolean} needs_shift
     * @param {Uint32Array} void_keys
     * @param {Uint32Array} void_counts
     * @param {Uint32Array} void_values
     * @param {Uint32Array} style_ids
     * @param {Uint8Array} style_colors
     * @param {number | null} [plane_angle_to_radians]
     * @param {Uint32Array | null} [material_element_ids]
     * @param {Uint32Array | null} [material_color_counts]
     * @param {Uint8Array | null} [material_colors_rgba]
     * @returns {Uint8Array}
     */
    processGeometryBatchInstanced(data, jobs_flat, unit_scale, rtc_x, rtc_y, rtc_z, needs_shift, void_keys, void_counts, void_values, style_ids, style_colors, plane_angle_to_radians, material_element_ids, material_color_counts, material_colors_rgba) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray32ToWasm0(jobs_flat, wasm.__wbindgen_export);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passArray32ToWasm0(void_keys, wasm.__wbindgen_export);
            const len2 = WASM_VECTOR_LEN;
            const ptr3 = passArray32ToWasm0(void_counts, wasm.__wbindgen_export);
            const len3 = WASM_VECTOR_LEN;
            const ptr4 = passArray32ToWasm0(void_values, wasm.__wbindgen_export);
            const len4 = WASM_VECTOR_LEN;
            const ptr5 = passArray32ToWasm0(style_ids, wasm.__wbindgen_export);
            const len5 = WASM_VECTOR_LEN;
            const ptr6 = passArray8ToWasm0(style_colors, wasm.__wbindgen_export);
            const len6 = WASM_VECTOR_LEN;
            var ptr7 = isLikeNone(material_element_ids) ? 0 : passArray32ToWasm0(material_element_ids, wasm.__wbindgen_export);
            var len7 = WASM_VECTOR_LEN;
            var ptr8 = isLikeNone(material_color_counts) ? 0 : passArray32ToWasm0(material_color_counts, wasm.__wbindgen_export);
            var len8 = WASM_VECTOR_LEN;
            var ptr9 = isLikeNone(material_colors_rgba) ? 0 : passArray8ToWasm0(material_colors_rgba, wasm.__wbindgen_export);
            var len9 = WASM_VECTOR_LEN;
            wasm.ifcapi_processGeometryBatchInstanced(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, unit_scale, rtc_x, rtc_y, rtc_z, needs_shift, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, !isLikeNone(plane_angle_to_radians), isLikeNone(plane_angle_to_radians) ? 0 : plane_angle_to_radians, ptr7, len7, ptr8, len8, ptr9, len9);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v11 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v11;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Produce a batch ONCE and PARTITION it (the instanced-ONLY path): opaque
     * ordinary occurrences (colour alpha >= 0.99 AND geometry_class == 0) are
     * collated into the instanced shard; everything else (transparent glass,
     * type-product geometry) goes to the flat MeshCollection. Each mesh takes
     * exactly ONE route, so produce_batch runs once (no emit-both 2× meshing)
     * and the renderer draws opaque occurrences via instancing instead of flat.
     * Partition mirrors the renderer gates: INSTANCED_ALPHA_CUTOFF (0.99 =
     * OPAQUE_ALPHA_CUTOFF) for transparency, geometry_class for the Model/Types
     * split.
     *
     * NOTE: the renderer must be instanced-feature-complete (picking / selection
     * / lens overlays on instanced geometry) before the worker calls this in
     * place of processGeometryBatch — otherwise those features break for the
     * opaque bulk. See the instanced-only follow-ups.
     * @param {Uint8Array} data
     * @param {Uint32Array} jobs_flat
     * @param {number} unit_scale
     * @param {number} rtc_x
     * @param {number} rtc_y
     * @param {number} rtc_z
     * @param {boolean} needs_shift
     * @param {Uint32Array} void_keys
     * @param {Uint32Array} void_counts
     * @param {Uint32Array} void_values
     * @param {Uint32Array} style_ids
     * @param {Uint8Array} style_colors
     * @param {number | null} [plane_angle_to_radians]
     * @param {Uint32Array | null} [material_element_ids]
     * @param {Uint32Array | null} [material_color_counts]
     * @param {Uint8Array | null} [material_colors_rgba]
     * @returns {PartitionedBatch}
     */
    processGeometryBatchPartitioned(data, jobs_flat, unit_scale, rtc_x, rtc_y, rtc_z, needs_shift, void_keys, void_counts, void_values, style_ids, style_colors, plane_angle_to_radians, material_element_ids, material_color_counts, material_colors_rgba) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(jobs_flat, wasm.__wbindgen_export);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray32ToWasm0(void_keys, wasm.__wbindgen_export);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArray32ToWasm0(void_counts, wasm.__wbindgen_export);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArray32ToWasm0(void_values, wasm.__wbindgen_export);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passArray32ToWasm0(style_ids, wasm.__wbindgen_export);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passArray8ToWasm0(style_colors, wasm.__wbindgen_export);
        const len6 = WASM_VECTOR_LEN;
        var ptr7 = isLikeNone(material_element_ids) ? 0 : passArray32ToWasm0(material_element_ids, wasm.__wbindgen_export);
        var len7 = WASM_VECTOR_LEN;
        var ptr8 = isLikeNone(material_color_counts) ? 0 : passArray32ToWasm0(material_color_counts, wasm.__wbindgen_export);
        var len8 = WASM_VECTOR_LEN;
        var ptr9 = isLikeNone(material_colors_rgba) ? 0 : passArray8ToWasm0(material_colors_rgba, wasm.__wbindgen_export);
        var len9 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_processGeometryBatchPartitioned(this.__wbg_ptr, ptr0, len0, ptr1, len1, unit_scale, rtc_x, rtc_y, rtc_z, needs_shift, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, !isLikeNone(plane_angle_to_radians), isLikeNone(plane_angle_to_radians) ? 0 : plane_angle_to_radians, ptr7, len7, ptr8, len8, ptr9, len9);
        return PartitionedBatch.__wrap(ret);
    }
    /**
     * Like [`IfcAPI::process_geometry_batch_partitioned`] but reads the source
     * bytes held by [`IfcAPI::set_source_bytes`] instead of taking `data`.
     * Byte-for-byte identical output — it delegates to the legacy twin.
     * @param {Uint32Array} jobs_flat
     * @param {number} unit_scale
     * @param {number} rtc_x
     * @param {number} rtc_y
     * @param {number} rtc_z
     * @param {boolean} needs_shift
     * @param {Uint32Array} void_keys
     * @param {Uint32Array} void_counts
     * @param {Uint32Array} void_values
     * @param {Uint32Array} style_ids
     * @param {Uint8Array} style_colors
     * @param {number | null} [plane_angle_to_radians]
     * @param {Uint32Array | null} [material_element_ids]
     * @param {Uint32Array | null} [material_color_counts]
     * @param {Uint8Array | null} [material_colors_rgba]
     * @returns {PartitionedBatch}
     */
    processGeometryBatchPartitionedFromSource(jobs_flat, unit_scale, rtc_x, rtc_y, rtc_z, needs_shift, void_keys, void_counts, void_values, style_ids, style_colors, plane_angle_to_radians, material_element_ids, material_color_counts, material_colors_rgba) {
        const ptr0 = passArray32ToWasm0(jobs_flat, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(void_keys, wasm.__wbindgen_export);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray32ToWasm0(void_counts, wasm.__wbindgen_export);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArray32ToWasm0(void_values, wasm.__wbindgen_export);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArray32ToWasm0(style_ids, wasm.__wbindgen_export);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passArray8ToWasm0(style_colors, wasm.__wbindgen_export);
        const len5 = WASM_VECTOR_LEN;
        var ptr6 = isLikeNone(material_element_ids) ? 0 : passArray32ToWasm0(material_element_ids, wasm.__wbindgen_export);
        var len6 = WASM_VECTOR_LEN;
        var ptr7 = isLikeNone(material_color_counts) ? 0 : passArray32ToWasm0(material_color_counts, wasm.__wbindgen_export);
        var len7 = WASM_VECTOR_LEN;
        var ptr8 = isLikeNone(material_colors_rgba) ? 0 : passArray8ToWasm0(material_colors_rgba, wasm.__wbindgen_export);
        var len8 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_processGeometryBatchPartitionedFromSource(this.__wbg_ptr, ptr0, len0, unit_scale, rtc_x, rtc_y, rtc_z, needs_shift, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, !isLikeNone(plane_angle_to_radians), isLikeNone(plane_angle_to_radians) ? 0 : plane_angle_to_radians, ptr6, len6, ptr7, len7, ptr8, len8);
        return PartitionedBatch.__wrap(ret);
    }
    /**
     * Propose IFC walls, slabs, columns and pipes from a scan segmentation
     * report (#6894). `report_json` is the JSON `segmentScanPoints`
     * returned; `options_json` is a camelCase `ScanProposalOptions` object
     * (`{}` for the defaults; `scanToModel` maps the report's frame into the
     * IFC model frame). Returns the UTF-8 JSON `ScanProposalReport` in the
     * model frame (Z up, metres). Pure: loads and changes nothing.
     * @param {string} report_json
     * @param {string} options_json
     * @returns {Uint8Array}
     */
    proposeScanElements(report_json, options_json) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(report_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(options_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            wasm.ifcapi_proposeScanElements(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v3 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v3;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Fit bounded manual correspondences in source metres -> IFC world Z-up
     * metres, reporting held-out errors separately. Does not load or move models.
     * @param {string} request_json
     * @returns {Uint8Array}
     */
    registerScanCorrespondences(request_json) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passStringToWasm0(request_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len0 = WASM_VECTOR_LEN;
            wasm.ifcapi_registerScanCorrespondences(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v2 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Sharded pre-pass: resolve ONE contiguous (file-ordered) slice of the
     * styled-item span list on this worker, against the entity index installed
     * by `setEntityIndex`. Returns raw resolved maps as flat columns:
     * `{ orphanIds, orphanColors (f32 rgba per id), geomIds, geomColors,
     * geomFinishes }`, where `geomFinishes` is the #5582 `[metallic,
     * roughness]` pair per `geomIds` entry (NaN when unauthored), from
     * `resolve_geometry_finishes` over this slice.
     * The host merges shard results IN SHARD ORDER with first-wins per
     * geometry id, reproducing the serial resolver's file-order precedence,
     * then hands the merged columns to `finalizePrepassStyles`.
     * `spans` is `[id, start, len]` triples.
     * @param {Uint8Array} data
     * @param {Uint32Array} spans
     * @returns {any}
     */
    resolveStyledItemsShard(data, spans) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray32ToWasm0(spans, wasm.__wbindgen_export);
            const len1 = WASM_VECTOR_LEN;
            wasm.ifcapi_resolveStyledItemsShard(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Resolve styled-item spans against the installed source and entity index.
     * @param {Uint32Array} spans
     * @returns {any}
     */
    resolveStyledItemsShardFromSource(spans) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray32ToWasm0(spans, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.ifcapi_resolveStyledItemsShardFromSource(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Fast entity scanning using SIMD-accelerated Rust scanner
     * Returns array of entity references for data model parsing
     * Much faster than TypeScript byte-by-byte scanning (5-10x speedup)
     *
     * The returned array also carries two own properties describing what the
     * scan refused (#7393): `oversizedIdCount` (records skipped because their
     * express id does not fit u32, #3395) and `malformedRecordCount` (0 or 1:
     * whether a record was dropped for having no terminating `;`, #3695).
     * @param {string} content
     * @returns {any}
     */
    scanEntitiesFast(content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_scanEntitiesFast(this.__wbg_ptr, ptr0, len0);
        return takeObject(ret);
    }
    /**
     * Fast entity scanning from raw bytes (avoids TextDecoder.decode on JS side).
     * Accepts Uint8Array directly — saves ~2-5s for 487MB files by skipping
     * JS string creation and UTF-16→UTF-8 conversion.
     *
     * Carries the same `oversizedIdCount` / `malformedRecordCount` array
     * properties as `scanEntitiesFast` (#7393).
     * @param {Uint8Array} data
     * @returns {any}
     */
    scanEntitiesFastBytes(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_scanEntitiesFastBytes(this.__wbg_ptr, ptr0, len0);
        return takeObject(ret);
    }
    /**
     * SPIKE (sharded pre-pass): scan the entity index over a single byte range.
     *
     * Each idle browser geometry worker calls this on its `[range_start,
     * range_end)` shard; the main thread stitches the returned columns into the
     * full entity index (byte-identical to the single-threaded
     * `build_entity_index`) by binary-searching each shard for the previous
     * shard's `handoff`. Delegates to
     * `ifc_lite_processing::scan_shard_classified_with_refusals` — a
     * separately-maintained loop over the same `EntityScanner` primitive as
     * `scan_shard` (the one the native `build_entity_index_parallel` fans across
     * cores), plus a per-record class column this sharded path also needs. The
     * two loops' records/handoff are kept in parity by a dedicated test
     * (`rust/processing/tests/issue_2053_shard_scan_parity.rs`), not by
     * delegation — edit one without the other and that test catches the drift.
     *
     * Byte offsets returned are GLOBAL (relative to file start), so shards
     * concatenate without rewriting. Returns a plain object:
     *   `{ ids: Uint32Array, starts: Uint32Array, lengths: Uint32Array,
     *      classes: Uint8Array, handoff: number,
     *      oversizedIdStarts: Uint32Array }`
     * where `classes` is the parallel per-record prepass class byte
     * (`PREPASS_CLASS_*`: named code in the low bits plus the geometry-job /
     * type-candidate flags) the host filters on to rebuild pre-pass span
     * lists, and `handoff` is the global start of the first entity at/after
     * `range_end` (the next shard's first real entity), or `-1` at EOF.
     *
     * `oversizedIdStarts` carries the global start byte of every record this
     * shard refused for an express id above `u32::MAX` (#3395). Offsets, not
     * a count, and deliberately NOT reported from here: a shard begins at an
     * arbitrary byte, so it can start inside a quoted value and refuse a
     * string literal shaped like `#4294967297=IFCWALL(` — text no file
     * declared. Reporting per shard would warn "skipped N records" on a file
     * that is fine. The host's stitch keeps only the offsets at/after the
     * retained boundary it computed for this shard and reports once, which is
     * what makes the number attributable to a record the stitch retained
     * (#3430).
     * @param {Uint8Array} data
     * @param {number} range_start
     * @param {number} range_end
     * @returns {any}
     */
    scanEntityIndexShard(data, range_start, range_end) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_scanEntityIndexShard(this.__wbg_ptr, ptr0, len0, range_start, range_end);
        return takeObject(ret);
    }
    /**
     * Scan a shard of the source installed by `setSourceBytes`.
     * @param {number} start
     * @param {number} end
     * @returns {any}
     */
    scanEntityIndexShardFromSource(start, end) {
        const ret = wasm.ifcapi_scanEntityIndexShardFromSource(this.__wbg_ptr, start, end);
        return takeObject(ret);
    }
    /**
     * Fast geometry-only entity scanning
     * Scans only entities that have geometry, skipping 99% of non-geometry entities
     * Returns array of geometry entity references for parallel processing
     * Much faster than scanning all entities (3x speedup for large files)
     * @param {string} content
     * @returns {any}
     */
    scanGeometryEntitiesFast(content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.ifcapi_scanGeometryEntitiesFast(this.__wbg_ptr, ptr0, len0);
        return takeObject(ret);
    }
    /**
     * Detect planes and cylinders (columns, pipes) in a point cloud (#6870). `positions` are xyz f32 metres
     * (at most 100,000,000 points); `options_json` is a camelCase
     * `ScanSegmentationOptions` object (`{}` for the defaults). Returns the
     * UTF-8 JSON `ScanSegmentationReport`. Pure: loads and changes nothing.
     * @param {Float32Array} positions
     * @param {string} options_json
     * @returns {Uint8Array}
     */
    segmentScanPoints(positions, options_json) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(options_json, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            wasm.ifcapi_segmentScanPoints(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true);
            if (r3) {
                throw takeObject(r2);
            }
            var v3 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v3;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Enable or disable per-entity geometry fingerprinting in
     * `processGeometryBatch`, used by the viewer's revision-diff feature.
     *
     * Pass a positive `tolerance` (metres) to enable — the quantization grid
     * positions snap to (larger tolerates more float noise, smaller catches
     * finer edits; below the `f32` precision floor of model-local coordinates,
     * ~1 mm, mostly hashes noise). Finer than
     * `ifc_lite_geometry::MIN_GEOM_HASH_TOLERANCE` (1e-6 m) is clamped up to it
     * — see that constant's doc for why (an `i128` overflow surface, not a
     * precision win). `null`/`undefined`/non-positive disables. Default: off.
     * @param {number | null} [tolerance]
     */
    setComputeGeometryHashes(tolerance) {
        wasm.ifcapi_setComputeGeometryHashes(this.__wbg_ptr, !isLikeNone(tolerance), isLikeNone(tolerance) ? 0 : tolerance);
    }
    /**
     * Populate `cached_entity_index` from pre-extracted column arrays.
     *
     * Used by the streaming pre-pass to share its already-built entity
     * index across worker realms via SAB-backed Uint32Arrays — every
     * process worker would otherwise re-scan the entire file in
     * `processGeometryBatch`'s lazy build path (~5 s on a 1 GB IFC),
     * even though the pre-pass worker built the same index minutes
     * earlier.
     *
     * Adopts the three binding-owned columns into a compact [`ColumnarEntityIndex`]
     * (sorted `u32` columns + binary search) instead of a per-worker
     * `FxHashMap` — ~229 MB vs ~436 MB on a 19.1 M-entity model (#1682).
     * [`ColumnarEntityIndex::from_owned_columns`] verifies the id ordering once
     * (O(n)) and only argsorts if the producer did not emit sorted columns.
     *
     * `lengths[i]` is the byte length of entity `ids[i]`, so lookup returns
     * `(start, start + length)` to match the existing `(start, end)` layout.
     *
     * Idempotent in the sense that repeated calls REPLACE the cache —
     * supports the parser-worker pattern of reusing one IfcAPI across
     * multiple loads with different files.
     *
     * Throws when the three columns disagree in length. Every call is a
     * content swap, a rejected one included: the previous file's index,
     * content-scoped caches and pipeline diagnostics are dropped before the
     * error is raised, and a rejected or empty index leaves no index, so the
     * next batch scans the bytes it is given.
     * @param {Uint32Array} ids
     * @param {Uint32Array} starts
     * @param {Uint32Array} lengths
     */
    setEntityIndex(ids, starts, lengths) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray32ToWasm0(ids, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray32ToWasm0(starts, wasm.__wbindgen_export);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passArray32ToWasm0(lengths, wasm.__wbindgen_export);
            const len2 = WASM_VECTOR_LEN;
            wasm.ifcapi_setEntityIndex(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            if (r1) {
                throw takeObject(r0);
            }
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Install the pre-computed set of type ids that an `IfcRelDefinesByType`
     * instantiates (#957 follow-up), so the worker's first type-product batch
     * skips the per-worker [`Self::get_or_build_instantiated_type_ids`]
     * full-file walk. Same injection contract as [`Self::set_referenced_repmaps`].
     * @param {Uint32Array} ids
     */
    setInstantiatedTypeIds(ids) {
        const ptr0 = passArray32ToWasm0(ids, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.ifcapi_setInstantiatedTypeIds(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Install the pre-computed #1623 Phase 3 don't-bake plan: the flat list of
     * `IfcRepresentationMap` ids that an `IfcMappedItem` instantiates >= 2 times.
     * The streaming pre-pass tallies it in the SAME scan that builds the referenced-
     * repmap set (`styling::build_mapped_instance_plan_from_spans`) and ships the id
     * list here. The batch path arms its router with it (batch-local template mode),
     * so a repeated single-solid mapped source materializes ONCE per batch and the
     * rest ride as instances in the IFNS shard.
     *
     * Same injection contract as [`Self::set_referenced_repmaps`]: installed after
     * `setEntityIndex` (which clears it on content swap), and a no-op absence leaves
     * the batch path materializing every occurrence (byte-identical). Each id is
     * stored as `(2, id)` — the batch-local router only needs the eligibility set
     * (count >= 2); the min-id template slot is unused in batch-local mode.
     * @param {Uint32Array} source_ids
     */
    setMappedInstancePlan(source_ids) {
        const ptr0 = passArray32ToWasm0(source_ids, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.ifcapi_setMappedInstancePlan(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Install the pre-computed [`ifc_lite_geometry::MaterialLayerIndex`] (#563)
     * from its flat SoA encoding, so the worker's first batch skips the
     * per-worker [`Self::get_or_build_material_layer_index`] full-file decode
     * scan (the dominant first-batch cost on layered architectural models,
     * which run this on the DEFAULT view). The streaming pre-pass built the
     * index once from the `IfcRelAssociatesMaterial` spans it already scanned
     * (`MaterialLayerIndex::from_spans`) and flat-encoded it here; the flat
     * encoding round-trips bit-for-bit (proven in `material_layer_index` tests),
     * so the injected index equals each worker's `from_content` result.
     *
     * Same injection contract as [`Self::set_referenced_repmaps`]: installed
     * after `setEntityIndex`, and a no-op absence leaves the lazy build intact.
     * @param {Uint32Array} element_ids
     * @param {Uint32Array} axis
     * @param {Uint32Array} layer_counts
     * @param {Float64Array} direction_sense
     * @param {Float64Array} offset
     * @param {Uint32Array} layer_material_ids
     * @param {Float64Array} layer_thicknesses
     */
    setMaterialLayerIndex(element_ids, axis, layer_counts, direction_sense, offset, layer_material_ids, layer_thicknesses) {
        const ptr0 = passArray32ToWasm0(element_ids, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(axis, wasm.__wbindgen_export);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray32ToWasm0(layer_counts, wasm.__wbindgen_export);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArrayF64ToWasm0(direction_sense, wasm.__wbindgen_export);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArrayF64ToWasm0(offset, wasm.__wbindgen_export);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passArray32ToWasm0(layer_material_ids, wasm.__wbindgen_export);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passArrayF64ToWasm0(layer_thicknesses, wasm.__wbindgen_export);
        const len6 = WASM_VECTOR_LEN;
        wasm.ifcapi_setMaterialLayerIndex(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6);
    }
    /**
     * Toggle the "render multilayer walls as a single solid" mode (issue #540).
     *
     * When `enabled` is `true`, every subsequent `processGeometryBatch` call
     * will suppress geometry emission for `IfcBuildingElementPart` entities
     * whose `IfcRelAggregates` parent wall is sliceable (has an
     * `IfcMaterialLayerSetUsage`) AND has its own `Representation`. The
     * parent wall keeps its per-layer sub-mesh colouring, so the visual
     * result is the same as the layered render but with one mesh per wall
     * instead of one per layer part — much cheaper for both CPU and GPU.
     *
     * Default is `false`. Pass `true` before calling `processGeometryBatch`.
     * @param {boolean} enabled
     */
    setMergeLayers(enabled) {
        wasm.ifcapi_setMergeLayers(this.__wbg_ptr, enabled);
    }
    /**
     * Sharded pre-pass (#5582): stash the shard-merged geometry finishes —
     * the `geomFinishes` columns `resolveStyledItemsShard` returns, merged
     * first-wins like `geomColors` — for the next `finalizePrepassStyles` /
     * `finalizePrepassStylesFromSource` call on this instance, which consumes
     * them and emits the aligned `styleFinishes`. Without this call that
     * finalize emits NaN finishes, as it always emitted colours only.
     * @param {Uint32Array} geom_ids
     * @param {Float32Array} geom_finishes
     */
    setPrepassGeometryFinishes(geom_ids, geom_finishes) {
        const ptr0 = passArray32ToWasm0(geom_ids, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(geom_finishes, wasm.__wbindgen_export);
        const len1 = WASM_VECTOR_LEN;
        wasm.ifcapi_setPrepassGeometryFinishes(this.__wbg_ptr, ptr0, len0, ptr1, len1);
    }
    /**
     * Enable or disable the PARAMETRIC rectangular-opening fast path (the
     * placement-frame, ground-truth-exact analytic cut) for `processGeometryBatch`.
     *
     * DEFAULT ON (corpus-validated; native defaults ON too, and wasm has no env to
     * read `IFC_LITE_RECT_PARAM`, so both targets default in LOCKSTEP -- the
     * byte-identical native==wasm contract requires both take the same path). This
     * toggle is the wasm-side escape hatch mirroring `IFC_LITE_RECT_PARAM=0`.
     * The path subtracts rectangular openings as exact parametric boxes in the host's
     * own placement frame (rotated walls included), deferring any non-clean case to
     * the exact kernel. Pass `false` before `processGeometryBatch` to opt out.
     * @param {boolean} enabled
     */
    setRectParamFastPath(enabled) {
        wasm.ifcapi_setRectParamFastPath(this.__wbg_ptr, enabled);
    }
    /**
     * Install the pre-computed set of `IfcRepresentationMap` ids referenced by
     * an `IfcMappedItem` (issue #957), so the worker's first type-product batch
     * SKIPS the per-worker [`Self::get_or_build_referenced_repmaps`] full-file
     * walk. The streaming pre-pass built the same set once from the
     * `IfcMappedItem` spans it already scanned (see
     * `styling::build_referenced_representation_maps_from_spans`) and ships the
     * id list here — bit-identical to what each worker would compute, since a
     * set's membership is order-invariant and consumers only call `.contains`.
     *
     * Installed AFTER `setEntityIndex` (which clears this cache on content
     * swap), so the injected value survives. When this setter is never called
     * (native path, non-streaming callers), the lazy build path is unchanged.
     * @param {Uint32Array} ids
     */
    setReferencedRepmaps(ids) {
        const ptr0 = passArray32ToWasm0(ids, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.ifcapi_setReferencedRepmaps(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Toggle the tier-independent small-cut skip (#1286). When `true`,
     * `processGeometryBatch` drops `IfcBooleanResult` differences whose cutter is
     * tiny relative to its host (steel copes/notches) while keeping the
     * tessellation tier — so curves stay full-density. The viewer enables this for
     * the on-screen load; exports/drawings leave it off so their geometry keeps
     * every cut. Default off ⇒ byte-identical to before.
     *
     * Set BEFORE processing — meshes already emitted are not regenerated.
     * @param {boolean} on
     */
    setSkipSmallCuts(on) {
        wasm.ifcapi_setSkipSmallCuts(this.__wbg_ptr, on);
    }
    /**
     * Store the whole IFC source file ONCE per load so the `*FromSource` batch
     * variants can read it from the wasm heap instead of re-copying it per call.
     *
     * Mirrors the `setEntityIndex` lifecycle: called once per worker per load,
     * and REPLACES the previous file wholesale (repeated calls swap the bytes),
     * so a parser/geometry worker reusing one `IfcAPI` across loads is safe.
     * The bytes must be the exact source the batch jobs' byte spans index into
     * (the same buffer passed as `data` to the legacy `processGeometryBatch*`),
     * or the decoded entities won't match — the JS worker installs its own
     * session buffer, so this holds by construction.
     *
     * Taking `Vec<u8>` (by value) means wasm-bindgen hands us ownership of the
     * single JS→wasm copy directly; we wrap it in `Arc` with no second copy.
     * @param {Uint8Array} data
     */
    setSourceBytes(data) {
        const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.ifcapi_setSourceBytes(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * Install the prepass's authored metallic/roughness per style (#5582):
     * `styleFinishes` carries two floats per `styleIds` entry,
     * `[metallic, roughness]`, NaN for an unauthored field — the
     * `styleFinishes` array every prepass result carries beside `styleColors`.
     * Call it with the same `styleIds` later passed to `processGeometryBatch*`;
     * finishes set for a different style wire are ignored. Empty arrays clear
     * them. Malformed lengths never throw: a style without a complete pair
     * simply gets no finish.
     *
     * The batch stamps each returned `MeshDataJs` (`metallic` / `roughness`)
     * from these, taking each mesh's finish from the style its colour came
     * from (#5984). Occurrences that ride the instanced (IFNS) shard carry
     * theirs in the shard's per-instance finish field (v3).
     * @param {Uint32Array} style_ids
     * @param {Float32Array} style_finishes
     */
    setStyleFinishes(style_ids, style_finishes) {
        const ptr0 = passArray32ToWasm0(style_ids, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(style_finishes, wasm.__wbindgen_export);
        const len1 = WASM_VECTOR_LEN;
        wasm.ifcapi_setStyleFinishes(this.__wbg_ptr, ptr0, len0, ptr1, len1);
    }
    /**
     * Select the tessellation detail level applied by every subsequent
     * `processGeometryBatch` call (issue #976, step 4).
     *
     * `level` is one of `"lowest" | "low" | "medium" | "high" | "highest"`
     * (case-insensitive). `"medium"` is the default and reproduces the
     * engine's historical hardcoded densities byte-for-byte; lower levels
     * trade curved-surface smoothness for throughput, higher levels reduce
     * faceting on pipes / cylinders / NURBS at a triangle-count cost.
     * Pass `null`/`undefined` to reset to the default.
     *
     * Set BEFORE processing — meshes already emitted are not regenerated.
     * Throws on an unrecognized level so typos fail loudly instead of
     * silently rendering at the wrong density.
     * @param {string | null} [level]
     */
    setTessellationQuality(level) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            var ptr0 = isLikeNone(level) ? 0 : passStringToWasm0(level, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            var len0 = WASM_VECTOR_LEN;
            wasm.ifcapi_setTessellationQuality(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            if (r1) {
                throw takeObject(r0);
            }
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Simplify already-produced element meshes at per-element demesher
     * levels (1-4 = cavity removal + clustering at 0.5/0.25/0.10/0.03
     * triangle ratio, 5 = bounding box).
     *
     * One RECORD per input `MeshData` entry (an element may span several
     * records — per-material submeshes; pass all of them, grouped or not).
     * Per record `i`: `vertexCounts[i]` vertices from `positions` (and
     * `normals` when non-empty), `indexCounts[i]` indices from `indices`
     * (per-record local), `origins[i*3..]`, `localToWorld[i*16..]` valid
     * only when `localToWorldPresent[i] != 0`, level `levels[i]` (records
     * of one element must agree). Arrays are the boundary Y-up convention
     * when `yUp` is true (the browser/SDK case).
     *
     * `rtcX/Y/Z` = `coordinateInfo.originShift` (IFC Z-up metres);
     * `unitScale` = metres per project length unit.
     * @param {Uint32Array} express_ids
     * @param {Uint8Array} levels
     * @param {Float32Array} positions
     * @param {Float32Array} normals
     * @param {Uint32Array} indices
     * @param {Uint32Array} vertex_counts
     * @param {Uint32Array} index_counts
     * @param {Float64Array} origins
     * @param {Float64Array} local_to_world
     * @param {Uint8Array} local_to_world_present
     * @param {number} rtc_x
     * @param {number} rtc_y
     * @param {number} rtc_z
     * @param {number} unit_scale
     * @param {boolean} y_up
     * @returns {SimplifiedMeshes}
     */
    simplifyMeshes(express_ids, levels, positions, normals, indices, vertex_counts, index_counts, origins, local_to_world, local_to_world_present, rtc_x, rtc_y, rtc_z, unit_scale, y_up) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray32ToWasm0(express_ids, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray8ToWasm0(levels, wasm.__wbindgen_export);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passArrayF32ToWasm0(positions, wasm.__wbindgen_export);
            const len2 = WASM_VECTOR_LEN;
            const ptr3 = passArrayF32ToWasm0(normals, wasm.__wbindgen_export);
            const len3 = WASM_VECTOR_LEN;
            const ptr4 = passArray32ToWasm0(indices, wasm.__wbindgen_export);
            const len4 = WASM_VECTOR_LEN;
            const ptr5 = passArray32ToWasm0(vertex_counts, wasm.__wbindgen_export);
            const len5 = WASM_VECTOR_LEN;
            const ptr6 = passArray32ToWasm0(index_counts, wasm.__wbindgen_export);
            const len6 = WASM_VECTOR_LEN;
            const ptr7 = passArrayF64ToWasm0(origins, wasm.__wbindgen_export);
            const len7 = WASM_VECTOR_LEN;
            const ptr8 = passArrayF64ToWasm0(local_to_world, wasm.__wbindgen_export);
            const len8 = WASM_VECTOR_LEN;
            const ptr9 = passArray8ToWasm0(local_to_world_present, wasm.__wbindgen_export);
            const len9 = WASM_VECTOR_LEN;
            wasm.ifcapi_simplifyMeshes(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, ptr7, len7, ptr8, len8, ptr9, len9, rtc_x, rtc_y, rtc_z, unit_scale, y_up);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return SimplifiedMeshes.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Get version string
     * @returns {string}
     */
    get version() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.ifcapi_version(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) IfcAPI.prototype[Symbol.dispose] = IfcAPI.prototype.free;

export class LandXmlTinStreamSession {
    static __wrap(ptr) {
        const obj = Object.create(LandXmlTinStreamSession.prototype);
        obj.__wbg_ptr = ptr;
        LandXmlTinStreamSessionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        LandXmlTinStreamSessionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_landxmltinstreamsession_free(ptr, 0);
    }
    abort() {
        wasm.landxmltinstreamsession_abort(this.__wbg_ptr);
    }
    /**
     * @param {Uint8Array} data
     */
    advanceChunk(data) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArray8ToWasm0(data, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.landxmltinstreamsession_advanceChunk(retptr, this.__wbg_ptr, ptr0, len0);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            if (r1) {
                throw takeObject(r0);
            }
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Drain only after the renderer has credited this many transport bytes.
     * @param {number} max_bytes
     * @returns {any}
     */
    drain(max_bytes) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.landxmltinstreamsession_drain(retptr, this.__wbg_ptr, max_bytes);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {any}
     */
    finish() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.landxmltinstreamsession_finish(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Start the resumable metadata cursor. Consumers must continue draining
     * until [`Self::output_pending`] is false, then abort/free the session.
     */
    finishCursor() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.landxmltinstreamsession_finishCursor(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            if (r1) {
                throw takeObject(r0);
            }
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {any}
     */
    header() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.landxmltinstreamsession_header(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Whether the host must grant more credited output drain capacity.
     * @returns {boolean}
     */
    outputPending() {
        const ret = wasm.landxmltinstreamsession_outputPending(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Exact serialized transport bytes currently retained by the Rust queue.
     * @returns {number}
     */
    queuedBytes() {
        const ret = wasm.landxmltinstreamsession_queuedBytes(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Complete credited transport records currently retained by the Rust queue.
     * @returns {number}
     */
    queuedEvents() {
        const ret = wasm.landxmltinstreamsession_queuedEvents(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) LandXmlTinStreamSession.prototype[Symbol.dispose] = LandXmlTinStreamSession.prototype.free;

/**
 * Collection of mesh data for returning multiple meshes
 */
export class MeshCollection {
    static __wrap(ptr) {
        const obj = Object.create(MeshCollection.prototype);
        obj.__wbg_ptr = ptr;
        MeshCollectionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        MeshCollectionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_meshcollection_free(ptr, 0);
    }
    /**
     * Get building rotation angle in radians (from IfcSite placement)
     * Returns None if no rotation was detected
     * @returns {number | undefined}
     */
    get buildingRotation() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.meshcollection_buildingRotation(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r2 = getDataViewMemory0().getFloat64(retptr + 8 * 1, true);
            return r0 === 0 ? undefined : r2;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * The batch's typed CSG / opening diagnostics as a JS object (the
     * `GeometryDiagnostics` contract), or `undefined` if none were recorded. The
     * worker merges these across batches. One serialized value keeps the rich
     * nested shape as a single FFI crossing instead of dozens of getters.
     * @returns {any}
     */
    get diagnostics() {
        const ret = wasm.meshcollection_diagnostics(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Per-entity world-space AABBs as a `Float64Array`, SIX values per entry
     * (`minx, miny, minz, maxx, maxy, maxz`), in the same order as
     * [`Self::geometry_hash_ids`] — entry `i` spans `[6*i, 6*i+6)`. Empty
     * unless geometry hashing was enabled; the same
     * `IfcAPI.setComputeGeometryHashes` switch gates both, so nothing is
     * computed when the diff feature is off.
     *
     * Unquantized world `f64` (the file's RTC folded back in), so two
     * revisions that chose different RTC offsets report the same box. This is
     * what lets a consumer say "MOVED" honestly instead of inferring it from a
     * changed hash, which also fires on reshape and on retriangulation.
     *
     * **Frame: WebGL Y-up**, like every other box, position, origin and
     * placement that crosses this boundary (see `MeshDataJs::local_bounds`).
     * The hasher accumulates in the producer's IFC Z-up frame, so the swap
     * `(x,y,z) -> (x,z,-y)` is applied here, on the way out. Unconverted, the
     * boxes would not enclose the very meshes `processGeometryBatch` returns
     * alongside them. Positions are RTC-relative and this box is absolute, so
     * a consumer comparing the two folds `rtcOffset*` in — itself Y-up-swapped.
     *
     * Present for every hashed entity. Its companion
     * [`Self::geometry_volume_values`] is not — see there.
     * @returns {Float64Array}
     */
    get geometryAabbValues() {
        const ret = wasm.meshcollection_geometryAabbValues(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Per-entity topology verdict as a `Uint8Array`, one packed byte per entry
     * in [`Self::geometry_hash_ids`] order:
     *
     * * bit 0 (`1`) — every segment closed (no boundary / non-manifold edge)
     * * bit 1 (`2`) — every segment orientable
     * * bit 2 (`4`) — every segment a single connected component
     * * bit 3 (`8`) — the entity produced exactly one segment
     *
     * `0x0F` is exactly the set that carries a volume in
     * [`Self::geometry_volume_values`]. The individual bits are the diagnosis:
     * a model checker can distinguish "this wall is an open shell" (bit 0
     * clear) from "this door is a multi-item assembly whose parts may overlap"
     * (bit 3 clear), which are different findings with different fixes.
     * @returns {Uint8Array}
     */
    get geometryClosureFlags() {
        const ret = wasm.meshcollection_geometryClosureFlags(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Number of per-entity geometry fingerprints recorded.
     * @returns {number}
     */
    get geometryHashCount() {
        const ret = wasm.meshcollection_geometryHashCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Express ids for the per-entity geometry fingerprints, parallel to
     * [`Self::geometry_hash_values`]. Empty unless geometry hashing was
     * enabled via `IfcAPI.setComputeGeometryHashes`.
     * @returns {Uint32Array}
     */
    get geometryHashIds() {
        const ret = wasm.meshcollection_geometryHashIds(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Per-entity geometry fingerprints as a `BigUint64Array`, parallel to
     * [`Self::geometry_hash_ids`]. `u64` is exposed (not hex strings) so JS
     * can compare with `===` and key maps without allocation. Empty unless
     * geometry hashing was enabled.
     * @returns {BigUint64Array}
     */
    get geometryHashValues() {
        const ret = wasm.meshcollection_geometryHashValues(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Per-entity enclosed volume in CUBIC METRES as a `Float64Array`, one
     * value per entry in [`Self::geometry_hash_ids`] order. `NaN` means NO
     * TRUSTWORTHY VOLUME — the same absent convention as
     * [`Self::geometry_aabb_values`] — and it is `NaN` for roughly a third of
     * entities by design, not by failure.
     *
     * A value is emitted only when that entity's produced geometry was
     * PROVABLY a single closed, orientable, single-component solid, as decided
     * by the mesher's own orientation pass. Read
     * `ifc_lite_geometry::GeometryHasher::volume` before treating a `NaN` as a
     * bug: an open `SurfaceModel`, a material-layered wall (whose slices are
     * open bands by construction), and any element assembled from more than one
     * representation item all correctly report nothing rather than a plausible
     * wrong number. [`Self::geometry_closure_flags`] says which.
     *
     * This is NOT a substitute for an IFC `BaseQuantities` `GrossVolume`: it is
     * the volume of the geometry that was actually meshed, after opening cuts,
     * and it says nothing about whether a CSG degradation left the host uncut
     * (see the `diagnostics` getter).
     * @returns {Float64Array}
     */
    get geometryVolumeValues() {
        const ret = wasm.meshcollection_geometryVolumeValues(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Get mesh at index (clones — non-destructive). Prefer `takeMesh` on the
     * hot streaming path; this stays for callers that read meshes more than once.
     * @param {number} index
     * @returns {MeshDataJs | undefined}
     */
    get(index) {
        const ret = wasm.meshcollection_get(this.__wbg_ptr, index);
        return ret === 0 ? undefined : MeshDataJs.__wrap(ret);
    }
    /**
     * Check if an RTC offset was applied to these meshes (any non-zero
     * component). It can be inside 10 km: the placement-bounds fallback
     * re-bases on the bbox centre when a corner is past 10 km (#4643).
     * @returns {boolean}
     */
    hasRtcOffset() {
        const ret = wasm.meshcollection_hasRtcOffset(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Get number of meshes
     * @returns {number}
     */
    get length() {
        const ret = wasm.meshcollection_length(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get RTC offset X (for converting local coords back to world coords)
     * Add this to local X coordinates to get world X coordinates
     * @returns {number}
     */
    get rtcOffsetX() {
        const ret = wasm.meshcollection_rtcOffsetX(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get RTC offset Y
     * @returns {number}
     */
    get rtcOffsetY() {
        const ret = wasm.meshcollection_rtcOffsetY(this.__wbg_ptr);
        return ret;
    }
    /**
     * Get RTC offset Z
     * @returns {number}
     */
    get rtcOffsetZ() {
        const ret = wasm.meshcollection_rtcOffsetZ(this.__wbg_ptr);
        return ret;
    }
    /**
     * #1097 perf: MOVE the mesh at `index` out of the collection (the Vec
     * buffers are `std::mem::take`-n, leaving an empty stub). The streaming
     * worker reads each mesh exactly once, so moving avoids the full vertex-
     * data clone `get` pays — one fewer copy of positions/normals/indices/uvs/
     * texture per mesh (the JS getters still do the single Rust→JS copy). Calling
     * it twice for the same index yields the second call a DEFAULT mesh:
     * `expressId` 0 and every buffer empty, rather than the metadata-bearing
     * husk the hand-written copy used to leave. The method is read-once by
     * contract and the wasm-contract test pins this.
     * @param {number} index
     * @returns {MeshDataJs | undefined}
     */
    takeMesh(index) {
        const ret = wasm.meshcollection_takeMesh(this.__wbg_ptr, index);
        return ret === 0 ? undefined : MeshDataJs.__wrap(ret);
    }
    /**
     * Get total triangle count across all meshes
     * @returns {number}
     */
    get totalTriangles() {
        const ret = wasm.meshcollection_totalTriangles(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get total vertex count across all meshes
     * @returns {number}
     */
    get totalVertices() {
        const ret = wasm.meshcollection_totalVertices(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) MeshCollection.prototype[Symbol.dispose] = MeshCollection.prototype.free;

/**
 * Individual mesh data with express ID and color (matches MeshData interface)
 *
 * `Clone` is derived so the three sites that used to enumerate all 21 fields
 * by hand -- `get`, `takeMesh` and `MeshCollection`'s own `Clone` -- reduce to
 * `.cloned()`, `mem::take` and `.clone()`. Adding a field to #3199 meant
 * editing three literals in lockstep; the allowlist row for this file records
 * exactly that cost.
 *
 * To be precise about what this does and does not buy, because the obvious
 * claim is wrong: an exhaustive struct literal that OMITS a field is a compile
 * error, so those literals were never silently lossy. What they were is three
 * places to edit for one field, and `..Default::default()` is the shortcut a
 * hurried author reaches for when the compiler complains -- which WOULD be
 * silently lossy. `Default` is what makes `takeMesh` a one-liner, so the rule
 * is: TWO literals remain, `new` and `Default` below (both spelled
 * `Self { .. }`, which is why a grep for `MeshDataJs {` finds neither). Both
 * must stay exhaustive AND must agree on every field `new` does not take as an
 * argument. The compiler catches an omitted field in either; it cannot catch
 * the two DISAGREEING, which is the failure the pair exists to prevent, so
 * `default_agrees_with_new_on_the_fields_new_does_not_take` covers that.
 * Never spread `Default` into `new` -- `new` is the only place a field's
 * initial value is decided, so a field defaulted there is inert everywhere.
 */
export class MeshDataJs {
    static __wrap(ptr) {
        const obj = Object.create(MeshDataJs.prototype);
        obj.__wbg_ptr = ptr;
        MeshDataJsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        MeshDataJsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_meshdatajs_free(ptr, 0);
    }
    /**
     * Get color as [r, g, b, a] array
     * @returns {Float32Array}
     */
    get color() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.meshdatajs_color(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Get express ID
     * @returns {number}
     */
    get expressId() {
        const ret = wasm.meshdatajs_expressId(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Geometry provenance for the viewer's Model/Types switch (#957 follow-up):
     * 0 = occurrence, 1 = orphan type geometry (no occurrence), 2 = instanced
     * type geometry (hidden in Model mode, shown in Types mode).
     * @returns {number}
     */
    get geometryClass() {
        const ret = wasm.meshdatajs_geometryClass(this.__wbg_ptr);
        return ret;
    }
    /**
     * Source `IfcRepresentationItem`, or `undefined` where identity is merged
     * away. Never set alongside `materialId` (#3199).
     * @returns {number | undefined}
     */
    get geometryItemId() {
        const ret = wasm.meshdatajs_geometryItemId(this.__wbg_ptr);
        return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
    }
    /**
     * True when this mesh carries a surface texture (#961).
     * @returns {boolean}
     */
    get hasTexture() {
        const ret = wasm.meshdatajs_hasTexture(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Get IFC type name (e.g., "IfcWall", "IfcSpace")
     * @returns {string}
     */
    get ifcType() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.meshdatajs_ifcType(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Get indices as Uint32Array (copy to JS)
     * @returns {Uint32Array}
     */
    get indices() {
        const ret = wasm.meshdatajs_indices(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Local (pre-placement, object-space) AABB (issue #1474), WebGL Y-up,
     * `[minX,minY,minZ,maxX,maxY,maxZ]`. `undefined` when not captured
     * (wasm-bindgen maps `Option::None` to `undefined`, not `null`).
     * @returns {Float32Array | undefined}
     */
    get localBounds() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.meshdatajs_localBounds(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v1;
            if (r0 !== 0) {
                v1 = getArrayF32FromWasm0(r0, r1).slice();
                wasm.__wbindgen_export4(r0, r1 * 4, 4);
            }
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * The resolved `IfcLocalPlacement` chain for this mesh (issue #1474),
     * row-major 4×4, WebGL Y-up. `undefined` when not captured (see
     * `local_bounds` above).
     * @returns {Float64Array | undefined}
     */
    get localToWorld() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.meshdatajs_localToWorld(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v1;
            if (r0 !== 0) {
                v1 = getArrayF64FromWasm0(r0, r1).slice();
                wasm.__wbindgen_export4(r0, r1 * 8, 8);
            }
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * `IfcMaterial` layer sliced, or `undefined` (#3199).
     * @returns {number | undefined}
     */
    get materialId() {
        const ret = wasm.meshdatajs_materialId(this.__wbg_ptr);
        return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
    }
    /**
     * IFC-authored metallic/roughness (#5582). `undefined` when unauthored.
     * @returns {number | undefined}
     */
    get metallic() {
        const ret = wasm.meshdatajs_metallic(this.__wbg_ptr);
        return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
    }
    /**
     * Get normals as Float32Array (copy to JS)
     * @returns {Float32Array}
     */
    get normals() {
        const ret = wasm.meshdatajs_normals(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Per-element local-frame origin (Float64Array[3], WebGL Y-up, metres):
     * world position of vertex i = `origin + positions[3i..3i+3]`. Returns
     * [0,0,0] when positions are absolute (legacy / local frame off).
     * @returns {Float64Array}
     */
    get origin() {
        const ret = wasm.meshdatajs_origin(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Get positions as Float32Array (copy to JS)
     * @returns {Float32Array}
     */
    get positions() {
        const ret = wasm.meshdatajs_positions(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * @returns {number | undefined}
     */
    get roughness() {
        const ret = wasm.meshdatajs_roughness(this.__wbg_ptr);
        return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
    }
    /**
     * Optional SurfaceColour for the "Shading" GLB-export choice — only
     * present when the file authored a distinct DiffuseColour. JS sees
     * `undefined` when absent (most files).
     * @returns {Float32Array | undefined}
     */
    get shadingColor() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.meshdatajs_shadingColor(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v1;
            if (r0 !== 0) {
                v1 = getArrayF32FromWasm0(r0, r1).slice();
                wasm.__wbindgen_export4(r0, r1 * 4, 4);
            }
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {number}
     */
    get textureHeight() {
        const ret = wasm.meshdatajs_textureHeight(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Stable texture dedup key (`IfcSurfaceTexture` express id, #1781).
     * 0 when the mesh is untextured.
     * @returns {number}
     */
    get textureId() {
        const ret = wasm.meshdatajs_textureId(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Sampler wrap for the S axis (`IfcSurfaceTexture.RepeatS`): true = repeat.
     * @returns {boolean}
     */
    get textureRepeatS() {
        const ret = wasm.meshdatajs_textureRepeatS(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Sampler wrap for the T axis (`IfcSurfaceTexture.RepeatT`): true = repeat.
     * @returns {boolean}
     */
    get textureRepeatT() {
        const ret = wasm.meshdatajs_textureRepeatT(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Decoded RGBA8 texture bytes (`width*height*4`). Empty when untextured.
     * @returns {Uint8Array}
     */
    get textureRgba() {
        const ret = wasm.meshdatajs_textureRgba(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * External image reference (`IfcImageTexture.URLReference`, #1781) for the
     * host to resolve — e.g. a sibling image inside the `.ifcZIP`. `undefined`
     * for untextured meshes and Rust-decoded blob/pixel textures.
     * @returns {string | undefined}
     */
    get textureUrl() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.meshdatajs_textureUrl(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v1;
            if (r0 !== 0) {
                v1 = getStringFromWasm0(r0, r1).slice();
                wasm.__wbindgen_export4(r0, r1 * 1, 1);
            }
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {number}
     */
    get textureWidth() {
        const ret = wasm.meshdatajs_textureWidth(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get triangle count
     * @returns {number}
     */
    get triangleCount() {
        const ret = wasm.meshdatajs_triangleCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Per-vertex texture coordinates as Float32Array (u, v pairs). Empty when
     * the mesh is untextured.
     * @returns {Float32Array}
     */
    get uvs() {
        const ret = wasm.meshdatajs_uvs(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Get vertex count
     * @returns {number}
     */
    get vertexCount() {
        const ret = wasm.meshdatajs_vertexCount(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) MeshDataJs.prototype[Symbol.dispose] = MeshDataJs.prototype.free;

/**
 * A mesh's projected footprint outline.
 *
 * Contours are closed rings in drawing 2D space (same basis as `projectTo2D`
 * in `@ifc-lite/drawing-2d`), WITHOUT a duplicated closing vertex.
 * `axisMin`/`axisMax` are the element's extent along the cut axis (world
 * units, not flip-adjusted) for band classification on the TS side.
 */
export class MeshOutlineJs {
    static __wrap(ptr) {
        const obj = Object.create(MeshOutlineJs.prototype);
        obj.__wbg_ptr = ptr;
        MeshOutlineJsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        MeshOutlineJsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_meshoutlinejs_free(ptr, 0);
    }
    /**
     * Element extent (max) along the cut axis, world units.
     * @returns {number}
     */
    get axisMax() {
        const ret = wasm.meshoutlinejs_axisMax(this.__wbg_ptr);
        return ret;
    }
    /**
     * Element extent (min) along the cut axis, world units.
     * @returns {number}
     */
    get axisMin() {
        const ret = wasm.meshoutlinejs_axisMin(this.__wbg_ptr);
        return ret;
    }
    /**
     * Ring `i` as a flat `[u0, v0, u1, v1, …]` array, or `undefined` if out of
     * range. The ring is closed implicitly (connect the last point to the
     * first).
     * @param {number} index
     * @returns {Float32Array | undefined}
     */
    contour(index) {
        const ret = wasm.meshoutlinejs_contour(this.__wbg_ptr, index);
        return takeObject(ret);
    }
    /**
     * Number of boundary rings (outer + holes).
     * @returns {number}
     */
    get contourCount() {
        const ret = wasm.meshoutlinejs_contourCount(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) MeshOutlineJs.prototype[Symbol.dispose] = MeshOutlineJs.prototype.free;

/**
 * Result of [`IfcAPI::process_geometry_batch_partitioned`]: the flat
 * MeshCollection (transparent + type geometry) and the instanced IFNS shard
 * (opaque ordinary occurrences) from ONE produce_batch. Take-once accessors so
 * the JS side moves each out without a clone.
 */
export class PartitionedBatch {
    static __wrap(ptr) {
        const obj = Object.create(PartitionedBatch.prototype);
        obj.__wbg_ptr = ptr;
        PartitionedBatchFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PartitionedBatchFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_partitionedbatch_free(ptr, 0);
    }
    /**
     * Number of occurrences routed into the instanced shard this batch. The viewer
     * folds this into its total mesh count so the count reflects ALL rendered
     * geometry (flat + instanced), not just the flat MeshCollection.
     * @returns {number}
     */
    get instancedOccurrences() {
        const ret = wasm.partitionedbatch_instancedOccurrences(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * The flat MeshCollection (transparent glass + type-product geometry).
     * Moves out — call once.
     * @returns {MeshCollection | undefined}
     */
    takeMeshes() {
        const ret = wasm.partitionedbatch_takeMeshes(this.__wbg_ptr);
        return ret === 0 ? undefined : MeshCollection.__wrap(ret);
    }
    /**
     * The instanced IFNS shard bytes (opaque ordinary occurrences). Moves out.
     * @returns {Uint8Array}
     */
    takeShard() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.partitionedbatch_takeShard(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) PartitionedBatch.prototype[Symbol.dispose] = PartitionedBatch.prototype.free;

/**
 * A collection of extracted profiles.
 */
export class ProfileCollection {
    static __wrap(ptr) {
        const obj = Object.create(ProfileCollection.prototype);
        obj.__wbg_ptr = ptr;
        ProfileCollectionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProfileCollectionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_profilecollection_free(ptr, 0);
    }
    /**
     * Get profile at `index`.  Returns `undefined` for out-of-bounds index.
     * @param {number} index
     * @returns {ProfileEntryJs | undefined}
     */
    get(index) {
        const ret = wasm.profilecollection_get(this.__wbg_ptr, index);
        return ret === 0 ? undefined : ProfileEntryJs.__wrap(ret);
    }
    /**
     * Number of profiles.
     * @returns {number}
     */
    get length() {
        const ret = wasm.profilecollection_length(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Express IDs of elements that had an `IfcExtrudedAreaSolid` (direct or
     * mapped) but whose profile could not be extracted, so they are MISSING
     * from this collection. Empty on a clean model.
     * @returns {Uint32Array}
     */
    get skippedExpressIds() {
        const ret = wasm.profilecollection_skippedExpressIds(this.__wbg_ptr);
        return takeObject(ret);
    }
}
if (Symbol.dispose) ProfileCollection.prototype[Symbol.dispose] = ProfileCollection.prototype.free;

/**
 * A single profile entry – raw 2D polygon + world transform.
 *
 * Profile points are in **local 2D profile space** (metres).
 * Apply `transform` to `[x, y, 0, 1]` to get WebGL Y-up world coordinates.
 */
export class ProfileEntryJs {
    static __wrap(ptr) {
        const obj = Object.create(ProfileEntryJs.prototype);
        obj.__wbg_ptr = ptr;
        ProfileEntryJsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProfileEntryJsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_profileentryjs_free(ptr, 0);
    }
    /**
     * Express ID of the building element.
     * @returns {number}
     */
    get expressId() {
        const ret = wasm.profileentryjs_expressId(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Extrusion depth (metres).
     * @returns {number}
     */
    get extrusionDepth() {
        const ret = wasm.profileentryjs_extrusionDepth(this.__wbg_ptr);
        return ret;
    }
    /**
     * Extrusion direction `[dx, dy, dz]` in WebGL Y-up world space (unit vector).
     * @returns {Float32Array}
     */
    get extrusionDir() {
        const ret = wasm.profileentryjs_extrusionDir(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Number of points per hole.
     * @returns {Uint32Array}
     */
    get holeCounts() {
        const ret = wasm.profileentryjs_holeCounts(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * All hole points concatenated: `[x0, y0, x1, y1, …]` (metres).
     * @returns {Float32Array}
     */
    get holePoints() {
        const ret = wasm.profileentryjs_holePoints(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * IFC type name (e.g., `"IfcWall"`).
     * @returns {string}
     */
    get ifcType() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.profileentryjs_ifcType(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Model index for multi-model federation.
     * @returns {number}
     */
    get modelIndex() {
        const ret = wasm.profileentryjs_modelIndex(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Outer boundary: flat `[x0, y0, x1, y1, …]` in local profile space (metres).
     * @returns {Float32Array}
     */
    get outerPoints() {
        const ret = wasm.profileentryjs_outerPoints(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * 4 × 4 column-major transform in WebGL Y-up world space.
     * `M * [x, y, 0, 1]ᵀ` gives the world position.
     * @returns {Float32Array}
     */
    get transform() {
        const ret = wasm.profileentryjs_transform(this.__wbg_ptr);
        return takeObject(ret);
    }
}
if (Symbol.dispose) ProfileEntryJs.prototype[Symbol.dispose] = ProfileEntryJs.prototype.free;

/**
 * The traced outline. Owns wasm memory: call `free()`.
 */
export class ScanOutlineJs {
    static __wrap(ptr) {
        const obj = Object.create(ScanOutlineJs.prototype);
        obj.__wbg_ptr = ptr;
        ScanOutlineJsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ScanOutlineJsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_scanoutlinejs_free(ptr, 0);
    }
    /**
     * Every ring's plane coordinates concatenated, `[u0, v0, u1, v1, …]`.
     * @returns {Float64Array}
     */
    coords() {
        const ret = wasm.scanoutlinejs_coords(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * What the run did: cell size, cap hits, ring counts, repairs.
     * @returns {ScanOutlineDiagnosticsJs}
     */
    diagnostics() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.scanoutlinejs_diagnostics(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Total number of rings (outer boundaries and holes).
     * @returns {number}
     */
    get ringCount() {
        const ret = wasm.scanoutlinejs_ringCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Vertex count of each ring, in `coords()` order.
     * @returns {Uint32Array}
     */
    ringLengths() {
        const ret = wasm.scanoutlinejs_ringLengths(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * The ring directly containing each ring (a hole's outer boundary, an
     * island's hole), or `-1` at top level.
     * @returns {Int32Array}
     */
    ringParents() {
        const ret = wasm.scanoutlinejs_ringParents(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Number of outer boundaries.
     * @returns {number}
     */
    get shapeCount() {
        const ret = wasm.scanoutlinejs_shapeCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Ring index at which each shape starts; entry `s` is shape `s`'s outer
     * ring and the rings up to the next entry are its holes.
     * @returns {Uint32Array}
     */
    shapeOffsets() {
        const ret = wasm.scanoutlinejs_shapeOffsets(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Every ring mapped through the plane frame, `[x0, y0, z0, …]` in
     * `coords()` order, or `undefined` when no frame was given.
     * @returns {Float64Array | undefined}
     */
    worldCoords() {
        const ret = wasm.scanoutlinejs_worldCoords(this.__wbg_ptr);
        return takeObject(ret);
    }
}
if (Symbol.dispose) ScanOutlineJs.prototype[Symbol.dispose] = ScanOutlineJs.prototype.free;

/**
 * Flat result of `simplifyMeshes`: per surviving element `i`,
 * `vertexCounts[i]` vertices and `indexCounts[i]` indices taken in order
 * from the concatenated arrays (mirrors the `exportGlbFromMeshes` wire
 * convention). `localPositions` is 1:1 with `renderPositions` (f64, file
 * units, element object frame); `localIndices` is 1:1 with `renderIndices`
 * but in the IFC frame's winding. Skipped elements are reported in
 * `skippedIds` / `skippedReasons` and must keep their original geometry.
 */
export class SimplifiedMeshes {
    static __wrap(ptr) {
        const obj = Object.create(SimplifiedMeshes.prototype);
        obj.__wbg_ptr = ptr;
        SimplifiedMeshesFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SimplifiedMeshesFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_simplifiedmeshes_free(ptr, 0);
    }
    /**
     * @returns {Uint32Array}
     */
    get cavitiesDropped() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.simplifiedmeshes_cavitiesDropped(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {Uint32Array}
     */
    get elementIds() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.simplifiedmeshes_elementIds(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {Uint32Array}
     */
    get indexCounts() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.simplifiedmeshes_indexCounts(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {Uint8Array}
     */
    get levels() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.simplifiedmeshes_levels(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU8FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 1, 1);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {Uint32Array}
     */
    get localIndices() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.simplifiedmeshes_localIndices(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {Float64Array}
     */
    get localPositions() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.simplifiedmeshes_localPositions(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {Uint32Array}
     */
    get renderIndices() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.simplifiedmeshes_renderIndices(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {Float32Array}
     */
    get renderNormals() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.simplifiedmeshes_renderNormals(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * xyz per element (frame matches the render positions' convention).
     * @returns {Float64Array}
     */
    get renderOrigins() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.simplifiedmeshes_renderOrigins(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {Float32Array}
     */
    get renderPositions() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.simplifiedmeshes_renderPositions(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {Uint32Array}
     */
    get skippedIds() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.simplifiedmeshes_skippedIds(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Skip reason per `skippedIds` entry (stable slugs:
     * `no-geometry` / `missing-placement` / `singular-placement` /
     * `empty-result` / `invalid-unit-scale`).
     * @returns {any[]}
     */
    get skippedReasons() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.simplifiedmeshes_skippedReasons(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayJsValueFromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {Uint32Array}
     */
    get trisAfter() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.simplifiedmeshes_trisAfter(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {Uint32Array}
     */
    get trisBefore() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.simplifiedmeshes_trisBefore(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * @returns {Uint32Array}
     */
    get vertexCounts() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.simplifiedmeshes_vertexCounts(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) SimplifiedMeshes.prototype[Symbol.dispose] = SimplifiedMeshes.prototype.free;

/**
 * A persistent, editable floor-plate topology. See the module docs.
 */
export class SpacePlateHandle {
    static __wrap(ptr) {
        const obj = Object.create(SpacePlateHandle.prototype);
        obj.__wbg_ptr = ptr;
        SpacePlateHandleFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SpacePlateHandleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_spaceplatehandle_free(ptr, 0);
    }
    /**
     * Author a new room from a flat ring `[x0, y0, x1, y1, …]` (no repeated
     * closing vertex). `source` `-1` marks a user-drawn room. Winding is
     * normalised to CCW; returns the new room patch. The room is its own
     * connected component — it does not merge into existing topology.
     * @param {Float64Array} coords
     * @param {number} source
     * @returns {any}
     */
    addFace(coords, source) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArrayF64ToWasm0(coords, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.spaceplatehandle_addFace(retptr, this.__wbg_ptr, ptr0, len0, source);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Bounding half-edges of a face paired with their source element —
     * `[{ edge, source }, …]` — for `IfcRelSpaceBoundary` at bake.
     * @param {number} face
     * @returns {any}
     */
    boundingElements(face) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.spaceplatehandle_boundingElements(retptr, this.__wbg_ptr, face);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Dissolve a degree-2 vertex, welding its two edges into one straight
     * edge between the neighbours — the inverse of `splitEdge`, and the
     * "delete this corner / node" affordance. Returns the rooms it changed.
     * Rejects a wall junction (degree ≥ 3) or a weld that would duplicate an
     * edge.
     * @param {number} v
     * @returns {any}
     */
    dissolveVertex(v) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.spaceplatehandle_dissolveVertex(retptr, this.__wbg_ptr, v);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Move a vertex; returns the rooms it changed. A shared wall is one edge
     * whose endpoints are shared vertices, so one drag updates both rooms.
     * @param {number} v
     * @param {number} x
     * @param {number} y
     * @returns {any}
     */
    dragVertex(v, x, y) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.spaceplatehandle_dragVertex(retptr, this.__wbg_ptr, v, x, y);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Deep-copy the plate for an undo/redo snapshot. The clone owns its own
     * heap; the caller must `.free()` it like any handle.
     * @returns {SpacePlateHandle}
     */
    duplicate() {
        const ret = wasm.spaceplatehandle_duplicate(this.__wbg_ptr);
        return SpacePlateHandle.__wrap(ret);
    }
    /**
     * Absolute area (m²) of a face.
     * @param {number} face
     * @returns {number}
     */
    faceArea(face) {
        const ret = wasm.spaceplatehandle_faceArea(this.__wbg_ptr, face);
        return ret;
    }
    /**
     * Flat outline `[x0, y0, x1, y1, …]` of a face (no repeated closing vertex).
     * @param {number} face
     * @returns {Float64Array}
     */
    faceOutline(face) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.spaceplatehandle_faceOutline(retptr, this.__wbg_ptr, face);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Nearest live vertex id to `(x, y)` within `tol`, or `undefined`.
     * @param {number} x
     * @param {number} y
     * @param {number} tol
     * @returns {number | undefined}
     */
    findVertexNear(x, y, tol) {
        const ret = wasm.spaceplatehandle_findVertexNear(this.__wbg_ptr, x, y, tol);
        return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
    }
    /**
     * FACE-BASED build: rooms are the gaps between wall footprint rectangles.
     * `rectCoords` is flat `[x0, y0, x1, y1, x2, y2, x3, y3, …]` — 8 f64 per wall
     * (its 4 plan-rectangle corners, CCW). A bounded arrangement face is a room
     * only if its centroid is outside every rectangle (a gap, not a wall
     * interior). The room outline IS the net (inner-face) area; `gapBoundary`
     * gives the centre axis (½ thickness) and the gross outer face.
     * @param {Float64Array} rect_coords
     * @param {number} snap_tolerance
     * @param {number} min_area
     * @returns {SpacePlateHandle}
     */
    static fromWallRects(rect_coords, snap_tolerance, min_area) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArrayF64ToWasm0(rect_coords, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            wasm.spaceplatehandle_fromWallRects(retptr, ptr0, len0, snap_tolerance, min_area);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return SpacePlateHandle.__wrap(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Face-based gap-room boundary as flat `[x0, y0, …]`: each edge pushed
     * OUTWARD (into the wall) by `factor × the source wall's half-thickness`.
     * `0` → net (the gap / inner faces); `1` → centre axis (½ thickness, the
     * editable node line on the wall mid); `2` → gross outer face.
     * @param {number} face
     * @param {number} factor
     * @returns {Float64Array}
     */
    gapBoundary(face, factor) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.spaceplatehandle_gapBoundary(retptr, this.__wbg_ptr, face, factor);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Remove a shared wall, unioning the two rooms it separated. Returns the
     * surviving room.
     * @param {number} edge
     * @returns {any}
     */
    mergeFaces(edge) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.spaceplatehandle_mergeFaces(retptr, this.__wbg_ptr, edge);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * The room on the far side of a half-edge (its twin's face), or
     * `undefined`. O(1) — the "who's across this wall" query.
     * @param {number} edge
     * @returns {number | undefined}
     */
    neighborAcross(edge) {
        const ret = wasm.spaceplatehandle_neighborAcross(this.__wbg_ptr, edge);
        return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
    }
    /**
     * The face outline offset to a wall boundary, as flat `[x0, y0, …]`: each
     * edge is moved by its own wall's half-thickness — inward when `inset`
     * (the net / inner face), outward otherwise (the gross / outer face).
     * Shared room↔room edges are pinned when pushing outward. Falls back to the
     * centreline outline when no offset applies — so it's always a sane ring.
     * (For a `center` boundary just use `faceOutline`.)
     * @param {number} face
     * @param {boolean} inset
     * @returns {Float64Array}
     */
    netOutline(face, inset) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.spaceplatehandle_netOutline(retptr, this.__wbg_ptr, face, inset);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayF64FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 8, 8);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Build a plate from flat wall-axis segments.
     *
     * `segCoords`: `[ax, ay, bx, by, …]` (length a multiple of 4).
     * `segSources`: one `i32` per segment, `-1` for none.
     * `segHalfThickness`: one `f64` per segment — half the wall's thickness in
     * metres, carried onto the derived edges for `netOutline`. Pass an empty
     * array (or all zeros) when thickness is unknown (centreline only).
     * `snapTolerance` / `minArea`: pass `<= 0` to take the defaults.
     * @param {Float64Array} seg_coords
     * @param {Int32Array} seg_sources
     * @param {Float64Array} seg_half_thickness
     * @param {number} snap_tolerance
     * @param {number} min_area
     */
    constructor(seg_coords, seg_sources, seg_half_thickness, snap_tolerance, min_area) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            const ptr0 = passArrayF64ToWasm0(seg_coords, wasm.__wbindgen_export);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArray32ToWasm0(seg_sources, wasm.__wbindgen_export);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passArrayF64ToWasm0(seg_half_thickness, wasm.__wbindgen_export);
            const len2 = WASM_VECTOR_LEN;
            wasm.spaceplatehandle_new(retptr, ptr0, len0, ptr1, len1, ptr2, len2, snap_tolerance, min_area);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            this.__wbg_ptr = r0;
            SpacePlateHandleFinalization.register(this, this.__wbg_ptr, this);
            return this;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Sweep the whole plate clean: remove dangling spur walls, isolated nodes,
     * and redundant collinear nodes — the "clean up orphans" / eraser action.
     * Area-neutral and idempotent. Returns how many topology elements were
     * pruned (0 = the plate was already clean); the caller re-renders via
     * `snapshot` like any other edit.
     * @returns {number}
     */
    prune() {
        const ret = wasm.spaceplatehandle_prune(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Remove a wall edge, choosing the right semantics from its two faces:
     * two real rooms → union them; a bridge / spur / outer-only wall → delete
     * it and auto-clean the orphaned inner lines and nodes it leaves; a real
     * enclosing wall (room ↔ exterior) → rejected (`BordersExterior`). This is
     * the "remove this wall and tidy up" affordance for the orphan cruft the
     * non-destructive wall arrangement leaves behind. Returns the rooms it
     * changed (empty if the edge bounded no room).
     * @param {number} edge
     * @returns {any}
     */
    removeEdge(edge) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.spaceplatehandle_removeEdge(retptr, this.__wbg_ptr, edge);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Number of live rooms.
     * @returns {number}
     */
    get roomCount() {
        const ret = wasm.spaceplatehandle_roomCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Face ids of every live room.
     * @returns {Uint32Array}
     */
    roomIds() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.spaceplatehandle_roomIds(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Set a face's floor / ceiling planes (the vertical dimension that turns a
     * 2D face into a prismatic space at bake).
     * @param {number} face
     * @param {number} floor_z
     * @param {number} ceiling_z
     * @param {boolean} non_planar
     */
    setFaceHeight(face, floor_z, ceiling_z, non_planar) {
        wasm.spaceplatehandle_setFaceHeight(this.__wbg_ptr, face, floor_z, ceiling_z, non_planar);
    }
    /**
     * All live rooms as `{ face, area, simple, outline }` patches.
     * @returns {any}
     */
    snapshot() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.spaceplatehandle_snapshot(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Insert a new vertex at `(x, y)` on edge `edge`, subdividing it (no new
     * face). Returns the new vertex id — use it as a `splitFace` endpoint to
     * cut between points that weren't existing corners. Project `(x, y)` onto
     * the edge to keep areas unchanged.
     * @param {number} edge
     * @param {number} x
     * @param {number} y
     * @returns {number}
     */
    splitEdge(edge, x, y) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.spaceplatehandle_splitEdge(retptr, this.__wbg_ptr, edge, x, y);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return r0 >>> 0;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Subdivide a face with a partition between two of its vertices. `source`
     * `-1` marks a brand-new partition (materialised as a fresh wall at bake).
     * Returns the kept face and the new face.
     * @param {number} face
     * @param {number} va
     * @param {number} vb
     * @param {number} source
     * @returns {any}
     */
    splitFace(face, va, vb, source) {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.spaceplatehandle_splitFace(retptr, this.__wbg_ptr, face, va, vb, source);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
            if (r2) {
                throw takeObject(r1);
            }
            return takeObject(r0);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) SpacePlateHandle.prototype[Symbol.dispose] = SpacePlateHandle.prototype.free;

/**
 * A 2D circle/arc for symbolic representations
 */
export class SymbolicCircle {
    static __wrap(ptr) {
        const obj = Object.create(SymbolicCircle.prototype);
        obj.__wbg_ptr = ptr;
        SymbolicCircleFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SymbolicCircleFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_symboliccircle_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get centerX() {
        const ret = wasm.symboliccircle_centerX(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get centerY() {
        const ret = wasm.symboliccircle_centerY(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get endAngle() {
        const ret = wasm.symboliccircle_endAngle(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get expressId() {
        const ret = wasm.symboliccircle_expressId(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {string}
     */
    get ifcType() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.symboliccircle_ifcType(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Check if this is a full circle
     * @returns {boolean}
     */
    get isFullCircle() {
        const ret = wasm.symboliccircle_isFullCircle(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    get radius() {
        const ret = wasm.symboliccircle_radius(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {string}
     */
    get repIdentifier() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.symboliccircle_repIdentifier(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get startAngle() {
        const ret = wasm.symboliccircle_startAngle(this.__wbg_ptr);
        return ret;
    }
    /**
     * World-Y elevation captured from the placement chain.
     * @returns {number}
     */
    get worldY() {
        const ret = wasm.symboliccircle_worldY(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) SymbolicCircle.prototype[Symbol.dispose] = SymbolicCircle.prototype.free;

/**
 * A 2D filled region (IfcAnnotationFillArea / IfcAnnotationFillAreaOccurrence).
 *
 * Stores one outer ring of 2D points plus an offset table indexing inner
 * rings (holes). Both rings are stored flat in `points` so the JS side can
 * view the buffer as one Float32Array. The optional `hatch_*` fields encode
 * IfcFillAreaStyleHatching (line spacing, primary/secondary angles, line
 * width) when the IfcStyledItem chain resolves to a hatching style; absent
 * styles render as a solid fill.
 *
 * `holes_offsets` is an inclusive-prefix array describing where each hole
 * begins. The outer ring is implicitly at `points[0..holes_offsets[0]]`
 * (or all points if `holes_offsets` is empty). Each `holes_offsets[i]` is a
 * vertex index, not a byte offset.
 */
export class SymbolicFillArea {
    static __wrap(ptr) {
        const obj = Object.create(SymbolicFillArea.prototype);
        obj.__wbg_ptr = ptr;
        SymbolicFillAreaFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SymbolicFillAreaFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_symbolicfillarea_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get expressId() {
        const ret = wasm.symbolicfillarea_expressId(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get fillA() {
        const ret = wasm.symbolicfillarea_fillA(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get fillB() {
        const ret = wasm.symbolicfillarea_fillB(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get fillG() {
        const ret = wasm.symbolicfillarea_fillG(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get fillR() {
        const ret = wasm.symbolicfillarea_fillR(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number | undefined}
     */
    get geometryItemId() {
        const ret = wasm.symbolicfillarea_geometryItemId(this.__wbg_ptr);
        return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
    }
    /**
     * @returns {boolean}
     */
    get hasHatching() {
        const ret = wasm.symbolicfillarea_hasHatching(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    get hatchAngle() {
        const ret = wasm.symbolicfillarea_hatchAngle(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get hatchAngleSecondary() {
        const ret = wasm.symbolicfillarea_hatchAngleSecondary(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get hatchLineWidth() {
        const ret = wasm.symbolicfillarea_hatchLineWidth(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get hatchSpacing() {
        const ret = wasm.symbolicfillarea_hatchSpacing(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get holeCount() {
        const ret = wasm.symbolicfillarea_holeCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Vertex indices marking the start of each hole. Empty = no holes.
     * @returns {Uint32Array}
     */
    get holesOffsets() {
        const ret = wasm.symbolicfillarea_holesOffsets(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * @returns {string}
     */
    get ifcType() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.symbolicfillarea_ifcType(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get pointCount() {
        const ret = wasm.symbolicfillarea_pointCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Flattened ring vertices.
     * @returns {Float32Array}
     */
    get points() {
        const ret = wasm.symbolicfillarea_points(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * @returns {string}
     */
    get repIdentifier() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.symbolicfillarea_repIdentifier(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get worldY() {
        const ret = wasm.symbolicfillarea_worldY(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) SymbolicFillArea.prototype[Symbol.dispose] = SymbolicFillArea.prototype.free;

/**
 * A single 2D polyline for symbolic representations (Plan, Annotation, FootPrint)
 * Points are stored as [x1, y1, x2, y2, ...] in 2D coordinates
 */
export class SymbolicPolyline {
    static __wrap(ptr) {
        const obj = Object.create(SymbolicPolyline.prototype);
        obj.__wbg_ptr = ptr;
        SymbolicPolylineFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SymbolicPolylineFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_symbolicpolyline_free(ptr, 0);
    }
    /**
     * Get express ID of the parent element
     * @returns {number}
     */
    get expressId() {
        const ret = wasm.symbolicpolyline_expressId(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get IFC type name (e.g., "IfcDoor", "IfcWindow")
     * @returns {string}
     */
    get ifcType() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.symbolicpolyline_ifcType(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Check if this is a closed loop
     * @returns {boolean}
     */
    get isClosed() {
        const ret = wasm.symbolicpolyline_isClosed(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Get number of points
     * @returns {number}
     */
    get pointCount() {
        const ret = wasm.symbolicpolyline_pointCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get 2D points as Float32Array [x1, y1, x2, y2, ...]
     * @returns {Float32Array}
     */
    get points() {
        const ret = wasm.symbolicpolyline_points(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Get representation identifier ("Plan", "Annotation", "FootPrint", "Axis")
     * @returns {string}
     */
    get repIdentifier() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.symbolicpolyline_repIdentifier(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * World-Y elevation captured from the placement chain (or first 3D
     * point's Z component). JS uses this as the canonical bucket key.
     * @returns {number}
     */
    get worldY() {
        const ret = wasm.symbolicpolyline_worldY(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) SymbolicPolyline.prototype[Symbol.dispose] = SymbolicPolyline.prototype.free;

/**
 * Collection of symbolic representations for an IFC model
 */
export class SymbolicRepresentationCollection {
    static __wrap(ptr) {
        const obj = Object.create(SymbolicRepresentationCollection.prototype);
        obj.__wbg_ptr = ptr;
        SymbolicRepresentationCollectionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SymbolicRepresentationCollectionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_symbolicrepresentationcollection_free(ptr, 0);
    }
    /**
     * Get number of circles/arcs
     * @returns {number}
     */
    get circleCount() {
        const ret = wasm.symbolicrepresentationcollection_circleCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get number of fill areas
     * @returns {number}
     */
    get fillCount() {
        const ret = wasm.symbolicrepresentationcollection_fillCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get circle at index
     * @param {number} index
     * @returns {SymbolicCircle | undefined}
     */
    getCircle(index) {
        const ret = wasm.symbolicrepresentationcollection_getCircle(this.__wbg_ptr, index);
        return ret === 0 ? undefined : SymbolicCircle.__wrap(ret);
    }
    /**
     * Get all express IDs that have symbolic representations
     * @returns {Uint32Array}
     */
    getExpressIds() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.symbolicrepresentationcollection_getExpressIds(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            var v1 = getArrayU32FromWasm0(r0, r1).slice();
            wasm.__wbindgen_export4(r0, r1 * 4, 4);
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
    /**
     * Get fill area at index.
     * @param {number} index
     * @returns {SymbolicFillArea | undefined}
     */
    getFill(index) {
        const ret = wasm.symbolicrepresentationcollection_getFill(this.__wbg_ptr, index);
        return ret === 0 ? undefined : SymbolicFillArea.__wrap(ret);
    }
    /**
     * Get polyline at index
     * @param {number} index
     * @returns {SymbolicPolyline | undefined}
     */
    getPolyline(index) {
        const ret = wasm.symbolicrepresentationcollection_getPolyline(this.__wbg_ptr, index);
        return ret === 0 ? undefined : SymbolicPolyline.__wrap(ret);
    }
    /**
     * Get text annotation at index.
     * @param {number} index
     * @returns {SymbolicText | undefined}
     */
    getText(index) {
        const ret = wasm.symbolicrepresentationcollection_getText(this.__wbg_ptr, index);
        return ret === 0 ? undefined : SymbolicText.__wrap(ret);
    }
    /**
     * Check if collection is empty. A TRUNCATED result never is, even with no
     * primitives; the reasoning and the parity test are in `symbolic_truncation.rs`.
     * @returns {boolean}
     */
    get isEmpty() {
        const ret = wasm.symbolicrepresentationcollection_isEmpty(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Get number of polylines
     * @returns {number}
     */
    get polylineCount() {
        const ret = wasm.symbolicrepresentationcollection_polylineCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get number of text annotations
     * @returns {number}
     */
    get textCount() {
        const ret = wasm.symbolicrepresentationcollection_textCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Get total count of all symbolic items
     * @returns {number}
     */
    get totalCount() {
        const ret = wasm.symbolicrepresentationcollection_totalCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Primitive count at which extraction stopped, else `undefined`.
     * @returns {number | undefined}
     */
    get truncatedAt() {
        const ret = wasm.symbolicrepresentationcollection_truncatedAt(this.__wbg_ptr);
        return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
    }
    /**
     * The bound's numeric value, when the reason has one, else `undefined`.
     * Absent for the per-item reasons, whose bound is per item and not
     * comparable with `truncatedAt`.
     * @returns {number | undefined}
     */
    get truncatedLimit() {
        const ret = wasm.symbolicrepresentationcollection_truncatedLimit(this.__wbg_ptr);
        return ret === Number.MAX_SAFE_INTEGER ? undefined : ret;
    }
    /**
     * Which bound stopped extraction, else `undefined`. One of
     * `element-count`, `output-bytes`, `item-depth`, `item-revisits`,
     * `item-cycle` — the same kebab-case strings the JSON path emits, so a
     * consumer reading either surface reads one vocabulary.
     * @returns {string | undefined}
     */
    get truncatedReason() {
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.symbolicrepresentationcollection_truncatedReason(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            let v1;
            if (r0 !== 0) {
                v1 = getStringFromWasm0(r0, r1).slice();
                wasm.__wbindgen_export4(r0, r1 * 1, 1);
            }
            return v1;
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
        }
    }
}
if (Symbol.dispose) SymbolicRepresentationCollection.prototype[Symbol.dispose] = SymbolicRepresentationCollection.prototype.free;

/**
 * A 2D text annotation (IfcTextLiteral / IfcTextLiteralWithExtent).
 *
 * Position is in the same 2D coordinate space as `SymbolicPolyline` (i.e. the
 * floor-plan / annotation overlay's local frame after applying placement +
 * RTC). The text-orientation pair `(cos, sin)` rotates the baseline from the
 * `+x` axis. Height is the IFC font height in model units, scaled by the
 * project's length-unit factor so the renderer can convert directly to world
 * units. Alignment is the IFC `BoxAlignment` string verbatim
 * (`top-left`, `center`, `bottom-right`, …) — the renderer can interpret it.
 */
export class SymbolicText {
    static __wrap(ptr) {
        const obj = Object.create(SymbolicText.prototype);
        obj.__wbg_ptr = ptr;
        SymbolicTextFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SymbolicTextFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_symbolictext_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    get alignment() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.symbolictext_alignment(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get colorA() {
        const ret = wasm.symbolictext_colorA(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get colorB() {
        const ret = wasm.symbolictext_colorB(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get colorG() {
        const ret = wasm.symbolictext_colorG(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get colorR() {
        const ret = wasm.symbolictext_colorR(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {string}
     */
    get content() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.symbolictext_content(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get dirX() {
        const ret = wasm.symbolictext_dirX(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get dirY() {
        const ret = wasm.symbolictext_dirY(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get expressId() {
        const ret = wasm.symbolictext_expressId(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    get height() {
        const ret = wasm.symbolictext_height(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {string}
     */
    get ifcType() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.symbolictext_ifcType(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    get repIdentifier() {
        let deferred1_0;
        let deferred1_1;
        try {
            const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
            wasm.symbolictext_repIdentifier(retptr, this.__wbg_ptr);
            var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
            var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
            deferred1_0 = r0;
            deferred1_1 = r1;
            return getStringFromWasm0(r0, r1);
        } finally {
            wasm.__wbindgen_add_to_stack_pointer(16);
            wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    get targetPx() {
        const ret = wasm.symbolictext_targetPx(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get worldY() {
        const ret = wasm.symbolictext_worldY(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get x() {
        const ret = wasm.symbolictext_x(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get y() {
        const ret = wasm.symbolictext_y(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) SymbolicText.prototype[Symbol.dispose] = SymbolicText.prototype.free;

/**
 * One closed solid of a split element.
 */
export class ZonePieceJs {
    static __wrap(ptr) {
        const obj = Object.create(ZonePieceJs.prototype);
        obj.__wbg_ptr = ptr;
        ZonePieceJsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ZonePieceJsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_zonepiecejs_free(ptr, 0);
    }
    /**
     * Flat triangle indices into `positions`.
     * @returns {Uint32Array}
     */
    get indices() {
        const ret = wasm.zonepiecejs_indices(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Flat `[x, y, z, ...]` in the caller's frame.
     * @returns {Float64Array}
     */
    get positions() {
        const ret = wasm.zonepiecejs_positions(this.__wbg_ptr);
        return takeObject(ret);
    }
    /**
     * Enclosed volume of this piece, cubic units of the caller's frame.
     * @returns {number}
     */
    get volume() {
        const ret = wasm.zonepiecejs_volume(this.__wbg_ptr);
        return ret;
    }
    /**
     * Index into the zone array that was passed in, or `-1` for the part of
     * the element inside no zone.
     * @returns {number}
     */
    get zoneIndex() {
        const ret = wasm.zonepiecejs_zoneIndex(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) ZonePieceJs.prototype[Symbol.dispose] = ZonePieceJs.prototype.free;

/**
 * The result of splitting one element.
 */
export class ZoneSplitJs {
    static __wrap(ptr) {
        const obj = Object.create(ZoneSplitJs.prototype);
        obj.__wbg_ptr = ptr;
        ZoneSplitJsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ZoneSplitJsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_zonesplitjs_free(ptr, 0);
    }
    /**
     * Piece `index`, or `undefined` when out of range. Each call COPIES the
     * piece out, matching the rest of this API surface.
     * @param {number} index
     * @returns {ZonePieceJs | undefined}
     */
    piece(index) {
        const ret = wasm.zonesplitjs_piece(this.__wbg_ptr, index);
        return ret === 0 ? undefined : ZonePieceJs.__wrap(ret);
    }
    /**
     * @returns {number}
     */
    get pieceCount() {
        const ret = wasm.zonesplitjs_pieceCount(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * The part of the element inside NO zone could not be built.
     *
     * Separate from `sumErrorRel` because the two have opposite fixes: a
     * raised sum means the zones overlap and want redrawing, while this means
     * real volume is MISSING from the result. A caller must refuse the split
     * outright rather than publish the zone pieces alone.
     * @returns {boolean}
     */
    get remainderFailed() {
        const ret = wasm.zonesplitjs_remainderFailed(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * How far the pieces are from summing to the whole, relative.
     *
     * The invariant #2508 puts above everything else here. Exposed rather than
     * enforced: the caller decides what to do with a split that does not add
     * up (the expected cause is zones that overlap each other), and a number
     * it can show beats a silent refusal.
     * @returns {number}
     */
    get sumErrorRel() {
        const ret = wasm.zonesplitjs_sumErrorRel(this.__wbg_ptr);
        return ret;
    }
    /**
     * Enclosed volume of the input element.
     * @returns {number}
     */
    get wholeVolume() {
        const ret = wasm.zonesplitjs_wholeVolume(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) ZoneSplitJs.prototype[Symbol.dispose] = ZoneSplitJs.prototype.free;

/**
 * Compute the intersection solid of one clashing pair.
 *
 * `positionsA` / `positionsB` are flat world-space XYZ; `indicesA` /
 * `indicesB` are flat triangle indices into their own operand.
 *
 * ```javascript
 * const solid = clashIntersectionSolid(posA, idxA, posB, idxB);
 * if (solid.isSolid) {
 *   draw(solid.positions, solid.indices, solid.volumeM3);
 * } else {
 *   keepContactMarker(solid.degenerateReason); // e.g. "no-overlap"
 * }
 * solid.free();
 * ```
 * @param {Float32Array} positions_a
 * @param {Uint32Array} indices_a
 * @param {Float32Array} positions_b
 * @param {Uint32Array} indices_b
 * @returns {ClashIntersectionSolidJs}
 */
export function clashIntersectionSolid(positions_a, indices_a, positions_b, indices_b) {
    const ptr0 = passArrayF32ToWasm0(positions_a, wasm.__wbindgen_export);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(indices_a, wasm.__wbindgen_export);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF32ToWasm0(positions_b, wasm.__wbindgen_export);
    const len2 = WASM_VECTOR_LEN;
    const ptr3 = passArray32ToWasm0(indices_b, wasm.__wbindgen_export);
    const len3 = WASM_VECTOR_LEN;
    const ret = wasm.clashIntersectionSolid(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
    return ClashIntersectionSolidJs.__wrap(ret);
}

/**
 * `a - b`, keeping EVERY disjoint remnant.
 *
 * This is the operation the existing `subtract_2d` could not stand in for: it
 * returns one shape per island, where `subtract_2d` collapses to the largest
 * (correct for a single extrusion profile, silent geometry loss anywhere else).
 *
 * `b` may hold any number of rings; they subtract as their union, so there is
 * no separate "difference against many" entry point.
 * @param {Contours2D} a
 * @param {Contours2D} b
 * @returns {Contours2D}
 */
export function difference2d(a, b) {
    _assertClass(a, Contours2D);
    _assertClass(b, Contours2D);
    const ret = wasm.difference2d(a.__wbg_ptr, b.__wbg_ptr);
    return Contours2D.__wrap(ret);
}

/**
 * Get WASM memory to allow JavaScript to create TypedArray views
 * @returns {any}
 */
export function get_memory() {
    const ret = wasm.get_memory();
    return takeObject(ret);
}

/**
 * Initialize the WASM module.
 *
 * This function is called automatically when the WASM module is loaded.
 * It sets up panic hooks for better error messages in the browser console,
 * and points core's scan diagnostics at that console too.
 */
export function init() {
    wasm.init();
}

/**
 * `a ∩ b`.
 * @param {Contours2D} a
 * @param {Contours2D} b
 * @returns {Contours2D}
 */
export function intersection2d(a, b) {
    _assertClass(a, Contours2D);
    _assertClass(b, Contours2D);
    const ret = wasm.intersection2d(a.__wbg_ptr, b.__wbg_ptr);
    return Contours2D.__wrap(ret);
}

/**
 * Compute the winding-robust 2D footprint outline of a triangle mesh.
 *
 * `positions` is flat XYZ; `indices` is flat triangle indices. `axis` is
 * 0/1/2 = x/y/z (the cut axis, WebGL Y-up). Returns `undefined` when the mesh
 * has no triangles or projects to nothing: the element has no footprint.
 *
 * THROWS when the outline was not computed: an `axis` outside 0..=2, or a
 * mesh with more valid projected triangles than the overlay budget (50 000).
 * The viewer's outline provider catches the throw and draws its TypeScript
 * silhouette for that mesh.
 *
 * ```javascript
 * const outline = meshOutline2d(positions, indices, 1, false); // axis 1 = y
 * if (outline) {
 *   for (let i = 0; i < outline.contourCount; i++) {
 *     const ring = outline.contour(i); // Float32Array of [u0, v0, u1, v1, ...]
 *   }
 *   outline.free();
 * }
 * ```
 * @param {Float32Array} positions
 * @param {Uint32Array} indices
 * @param {number} axis
 * @param {boolean} flipped
 * @returns {MeshOutlineJs | undefined}
 */
export function meshOutline2d(positions, indices, axis, flipped) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArrayF32ToWasm0(positions, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray32ToWasm0(indices, wasm.__wbindgen_export);
        const len1 = WASM_VECTOR_LEN;
        wasm.meshOutline2d(retptr, ptr0, len0, ptr1, len1, axis, flipped);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        if (r2) {
            throw takeObject(r1);
        }
        return r0 === 0 ? undefined : MeshOutlineJs.__wrap(r0);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * Resolve a ring soup into disjoint outer/hole shapes without changing the
 * area it covers (a self-union). Use it to give a hand-built set — or a
 * `meshOutline2d` result — the shape grouping the operations produce.
 * @param {Contours2D} a
 * @returns {Contours2D}
 */
export function resolve2d(a) {
    _assertClass(a, Contours2D);
    const ret = wasm.resolve2d(a.__wbg_ptr);
    return Contours2D.__wrap(ret);
}

/**
 * Install (or, with `undefined`, remove) the callback invoked at most once a
 * second while geometry work is in progress inside a WASM call. It runs
 * synchronously inside that call, so it must only do something cheap such as
 * `postMessage`, and must not call back into this module.
 * @param {Function | null} [callback]
 */
export function setGeometryProgressCallback(callback) {
    wasm.setGeometryProgressCallback(isLikeNone(callback) ? 0 : addHeapObject(callback));
}

/**
 * Split a mesh into one closed solid per zone, plus the remainder.
 *
 * `positions` is flat XYZ (f64, caller's frame), `indices` flat triangle
 * indices. `zones` is flat, SEVEN numbers per zone:
 * `[cx, cy, cz, sx, sy, sz, rotationY]`, where the sizes are FULL extents
 * (matching the viewer's `Zone.size`) and the rotation is radians about the
 * vertical axis. A trailing partial zone is ignored rather than guessed at.
 *
 * A zone becomes a PRISM (#2508 item 4) when `footprint_counts[i]` is at
 * least 3: it then takes that many `[x, z]` pairs from `footprints`, in order,
 * and uses the 7-tuple only for its vertical extent (`cy +/- sy/2`). The
 * footprint must be CONVEX; the viewer gates that on import, because a concave
 * polygon fans into overlapping triangles and would cut wrong rather than
 * fail. A count of 1 or 2 is not a polygon: it still consumes its pairs, so
 * later zones stay aligned, and leaves that zone a box. Passing empty arrays
 * keeps every zone a box.
 *
 * The caller must have established that the mesh is a closed orientable solid
 * first, exactly as it must before quoting a volume at all (#1891/#1993): a
 * clip of an open shell produces pieces whose volumes are arbitrary rather
 * than approximate.
 *
 * A triangle with an out-of-range index or a non-finite coordinate is DROPPED
 * rather than reported, matching `kernel::mesh_bridge::mesh_to_tris`, which is
 * panic-free for the same reason: the alternative is a crash deep in the
 * predicates. It does mean a malformed caller can open the surface and get
 * meaningless volumes with a plausible `sumErrorRel`, so the closure proof
 * above is the caller's responsibility and not a formality.
 *
 * Returns `undefined` when a zone parameter is non-finite, or a mesh vertex
 * or zone corner lies past ±2^128, the exact kernel's coordinate bound
 * (#7677): such a split is refused rather than answered wrongly.
 *
 * Returns `undefined` when the mesh encloses no volume (no triangles survive
 * the filter above, or the shell is degenerate): there is nothing to split,
 * and a result for it would report `pieceCount` 1, `sumErrorRel` 0 and
 * `remainderFailed` false, a perfect split of nothing. A caller that gates
 * on those numbers must treat `undefined` as "no split", not as "no error".
 *
 * ```javascript
 * const split = splitMeshByZones(positions, indices, new Float64Array([
 *   0, 0, 0, 10, 10, 10, 0,
 * ]));
 * if (!split) return; // the mesh encloses no volume
 * for (let i = 0; i < split.pieceCount; i++) {
 *   const piece = split.piece(i);
 *   // piece.zoneIndex, piece.positions, piece.indices, piece.volume
 *   piece.free();
 * }
 * split.free();
 * ```
 * @param {Float64Array} positions
 * @param {Uint32Array} indices
 * @param {Float64Array} zones
 * @param {Float64Array | null} [footprints]
 * @param {Uint32Array | null} [footprint_counts]
 * @returns {ZoneSplitJs | undefined}
 */
export function splitMeshByZones(positions, indices, zones, footprints, footprint_counts) {
    const ptr0 = passArrayF64ToWasm0(positions, wasm.__wbindgen_export);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray32ToWasm0(indices, wasm.__wbindgen_export);
    const len1 = WASM_VECTOR_LEN;
    const ptr2 = passArrayF64ToWasm0(zones, wasm.__wbindgen_export);
    const len2 = WASM_VECTOR_LEN;
    var ptr3 = isLikeNone(footprints) ? 0 : passArrayF64ToWasm0(footprints, wasm.__wbindgen_export);
    var len3 = WASM_VECTOR_LEN;
    var ptr4 = isLikeNone(footprint_counts) ? 0 : passArray32ToWasm0(footprint_counts, wasm.__wbindgen_export);
    var len4 = WASM_VECTOR_LEN;
    const ret = wasm.splitMeshByZones(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4);
    return ret === 0 ? undefined : ZoneSplitJs.__wrap(ret);
}

/**
 * Trace closed outlines from slab points given in plane coordinates.
 *
 * THROWS on invalid options or plane frame (unknown field, non-finite or
 * out-of-range value). Points that are not finite are skipped and counted.
 * @param {Float32Array} plane_xy
 * @param {ScanOutlineOptionsJs | null} [options]
 * @param {ScanOutlinePlaneFrameJs | null} [plane_frame]
 * @returns {ScanOutlineJs}
 */
export function traceScanOutline(plane_xy, options, plane_frame) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passArrayF32ToWasm0(plane_xy, wasm.__wbindgen_export);
        const len0 = WASM_VECTOR_LEN;
        wasm.traceScanOutline(retptr, ptr0, len0, isLikeNone(options) ? 0 : addHeapObject(options), isLikeNone(plane_frame) ? 0 : addHeapObject(plane_frame));
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true);
        if (r2) {
            throw takeObject(r1);
        }
        return ScanOutlineJs.__wrap(r0);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * `a ∪ b`.
 * @param {Contours2D} a
 * @param {Contours2D} b
 * @returns {Contours2D}
 */
export function union2d(a, b) {
    _assertClass(a, Contours2D);
    _assertClass(b, Contours2D);
    const ret = wasm.union2d(a.__wbg_ptr, b.__wbg_ptr);
    return Contours2D.__wrap(ret);
}

/**
 * Get the version of IFC-Lite.
 *
 * # Returns
 *
 * Version string (e.g., "0.1.0")
 *
 * # Example
 *
 * ```javascript
 * console.log(`IFC-Lite version: ${version()}`);
 * ```
 * @returns {string}
 */
export function version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.version(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred1_0 = r0;
        deferred1_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export4(deferred1_0, deferred1_1, 1);
    }
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_92b29b0548f8b746: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return addHeapObject(ret);
        },
        __wbg_Number_9a4e0ecb0fa16705: function(arg0) {
            const ret = Number(getObject(arg0));
            return ret;
        },
        __wbg_String_8564e559799eccda: function(arg0, arg1) {
            const ret = String(getObject(arg1));
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_bigint_get_as_i64_d968e41184ae354f: function(arg0, arg1) {
            const v = getObject(arg1);
            const ret = typeof(v) === 'bigint' ? v : undefined;
            getDataViewMemory0().setBigInt64(arg0 + 8 * 1, isLikeNone(ret) ? BigInt(0) : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_boolean_get_fa956cfa2d1bd751: function(arg0) {
            const v = getObject(arg0);
            const ret = typeof(v) === 'boolean' ? v : undefined;
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg___wbindgen_debug_string_c25d447a39f5578f: function(arg0, arg1) {
            const ret = debugString(getObject(arg1));
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_in_aca499c5de7ff5e5: function(arg0, arg1) {
            const ret = getObject(arg0) in getObject(arg1);
            return ret;
        },
        __wbg___wbindgen_is_bigint_2f76dc55065b4273: function(arg0) {
            const ret = typeof(getObject(arg0)) === 'bigint';
            return ret;
        },
        __wbg___wbindgen_is_null_ea9085d691f535d3: function(arg0) {
            const ret = getObject(arg0) === null;
            return ret;
        },
        __wbg___wbindgen_is_object_a27215656b807791: function(arg0) {
            const val = getObject(arg0);
            const ret = typeof(val) === 'object' && val !== null;
            return ret;
        },
        __wbg___wbindgen_is_string_ea5e6cc2e4141dfe: function(arg0) {
            const ret = typeof(getObject(arg0)) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_c05833b95a3cf397: function(arg0) {
            const ret = getObject(arg0) === undefined;
            return ret;
        },
        __wbg___wbindgen_jsval_eq_e659fcf7b0e32763: function(arg0, arg1) {
            const ret = getObject(arg0) === getObject(arg1);
            return ret;
        },
        __wbg___wbindgen_jsval_loose_eq_db4c3b15f63fc170: function(arg0, arg1) {
            const ret = getObject(arg0) == getObject(arg1);
            return ret;
        },
        __wbg___wbindgen_memory_de265df8aadd6273: function() {
            const ret = wasm.memory;
            return addHeapObject(ret);
        },
        __wbg___wbindgen_number_get_394265ed1e1b84ee: function(arg0, arg1) {
            const obj = getObject(arg1);
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_string_get_b0ca35b86a603356: function(arg0, arg1) {
            const obj = getObject(arg1);
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_344f42d3211c4765: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_call_8a2dd23819f8a60a: function() { return handleError(function (arg0, arg1) {
            const ret = getObject(arg0).call(getObject(arg1));
            return addHeapObject(ret);
        }, arguments); },
        __wbg_call_a6e5c5dce5018821: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = getObject(arg0).call(getObject(arg1), getObject(arg2));
            return addHeapObject(ret);
        }, arguments); },
        __wbg_entries_015dc610cd81ede0: function(arg0) {
            const ret = Object.entries(getObject(arg0));
            return addHeapObject(ret);
        },
        __wbg_error_a6fa202b58aa1cd3: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_export4(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_from_13e323c65fc8f464: function(arg0) {
            const ret = Array.from(getObject(arg0));
            return addHeapObject(ret);
        },
        __wbg_get_507a50627bffa49b: function(arg0, arg1) {
            const ret = getObject(arg0)[arg1 >>> 0];
            return addHeapObject(ret);
        },
        __wbg_get_78f252d074a84d0b: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(getObject(arg0), getObject(arg1));
            return addHeapObject(ret);
        }, arguments); },
        __wbg_get_unchecked_6e0ad6d2a41b06f6: function(arg0, arg1) {
            const ret = getObject(arg0)[arg1 >>> 0];
            return addHeapObject(ret);
        },
        __wbg_get_with_ref_key_6412cf3094599694: function(arg0, arg1) {
            const ret = getObject(arg0)[getObject(arg1)];
            return addHeapObject(ret);
        },
        __wbg_info_eadbe775a8e2e9eb: function(arg0) {
            console.info(getObject(arg0));
        },
        __wbg_instanceof_ArrayBuffer_4480b9e0068a8adb: function(arg0) {
            let result;
            try {
                result = getObject(arg0) instanceof ArrayBuffer;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Uint8Array_309b927aaf7a3fc7: function(arg0) {
            let result;
            try {
                result = getObject(arg0) instanceof Uint8Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_isArray_0677c962b281d01a: function(arg0) {
            const ret = Array.isArray(getObject(arg0));
            return ret;
        },
        __wbg_isSafeInteger_04f36e4056f1b851: function(arg0) {
            const ret = Number.isSafeInteger(getObject(arg0));
            return ret;
        },
        __wbg_length_1f0964f4a5e2c6d8: function(arg0) {
            const ret = getObject(arg0).length;
            return ret;
        },
        __wbg_length_370319915dc99107: function(arg0) {
            const ret = getObject(arg0).length;
            return ret;
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return addHeapObject(ret);
        },
        __wbg_new_32b398fb48b6d94a: function() {
            const ret = new Array();
            return addHeapObject(ret);
        },
        __wbg_new_7796ffc7ed656783: function() {
            const ret = new Map();
            return addHeapObject(ret);
        },
        __wbg_new_b667d279fd5aa943: function(arg0, arg1) {
            const ret = new Error(getStringFromWasm0(arg0, arg1));
            return addHeapObject(ret);
        },
        __wbg_new_cd45aabdf6073e84: function(arg0) {
            const ret = new Uint8Array(getObject(arg0));
            return addHeapObject(ret);
        },
        __wbg_new_da52cf8fe3429cb2: function() {
            const ret = new Object();
            return addHeapObject(ret);
        },
        __wbg_new_from_slice_36bac521fad54bb4: function(arg0, arg1) {
            const ret = new BigUint64Array(getArrayU64FromWasm0(arg0, arg1));
            return addHeapObject(ret);
        },
        __wbg_new_from_slice_7568ba55b4a7e81f: function(arg0, arg1) {
            const ret = new Uint32Array(getArrayU32FromWasm0(arg0, arg1));
            return addHeapObject(ret);
        },
        __wbg_new_from_slice_77cdfb7977362f3c: function(arg0, arg1) {
            const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));
            return addHeapObject(ret);
        },
        __wbg_new_from_slice_7e254b47c77fb8cc: function(arg0, arg1) {
            const ret = new Float64Array(getArrayF64FromWasm0(arg0, arg1));
            return addHeapObject(ret);
        },
        __wbg_new_from_slice_adc482e0820cc439: function(arg0, arg1) {
            const ret = new Int32Array(getArrayI32FromWasm0(arg0, arg1));
            return addHeapObject(ret);
        },
        __wbg_new_from_slice_ddf8b82c4d6af38e: function(arg0, arg1) {
            const ret = new Float32Array(getArrayF32FromWasm0(arg0, arg1));
            return addHeapObject(ret);
        },
        __wbg_new_with_length_112583d83d0cb73c: function(arg0) {
            const ret = new Float64Array(arg0 >>> 0);
            return addHeapObject(ret);
        },
        __wbg_new_with_length_e1d8c8061ed4e317: function(arg0) {
            const ret = new Float32Array(arg0 >>> 0);
            return addHeapObject(ret);
        },
        __wbg_new_with_length_f048f86e32f1515e: function(arg0) {
            const ret = new Uint32Array(arg0 >>> 0);
            return addHeapObject(ret);
        },
        __wbg_now_86c0d4ba3fa605b8: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_prototypesetcall_4770620bbe4688a0: function(arg0, arg1, arg2) {
            Uint8Array.prototype.set.call(getArrayU8FromWasm0(arg0, arg1), getObject(arg2));
        },
        __wbg_set_575dd786d51585f8: function(arg0, arg1, arg2) {
            const ret = getObject(arg0).set(getObject(arg1), getObject(arg2));
            return addHeapObject(ret);
        },
        __wbg_set_6be42768c690e380: function(arg0, arg1, arg2) {
            getObject(arg0)[takeObject(arg1)] = takeObject(arg2);
        },
        __wbg_set_8535240470bf2500: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(getObject(arg0), getObject(arg1), getObject(arg2));
            return ret;
        }, arguments); },
        __wbg_set_8a16b38e4805b298: function(arg0, arg1, arg2) {
            getObject(arg0)[arg1 >>> 0] = takeObject(arg2);
        },
        __wbg_set_index_1edd196294cd6dbf: function(arg0, arg1, arg2) {
            getObject(arg0)[arg1 >>> 0] = arg2 >>> 0;
        },
        __wbg_set_index_2eba9e8997f36eb4: function(arg0, arg1, arg2) {
            getObject(arg0)[arg1 >>> 0] = arg2;
        },
        __wbg_set_index_f15f4feb1d940b8c: function(arg0, arg1, arg2) {
            getObject(arg0)[arg1 >>> 0] = arg2;
        },
        __wbg_set_name_3bbc583faefa4193: function(arg0, arg1, arg2) {
            getObject(arg0).name = getStringFromWasm0(arg1, arg2);
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = getObject(arg1).stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_static_accessor_GLOBAL_4ef717fb391d88b7: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addHeapObject(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_8d1badc68b5a74f4: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addHeapObject(ret);
        },
        __wbg_static_accessor_SELF_146583524fe1469b: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addHeapObject(ret);
        },
        __wbg_static_accessor_WINDOW_f2829a2234d7819e: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addHeapObject(ret);
        },
        __wbg_warn_b1370d804fa3e259: function(arg0) {
            console.warn(getObject(arg0));
        },
        __wbg_warn_ef97a01ad7900eb3: function(arg0, arg1) {
            console.warn(getObject(arg0), getObject(arg1));
        },
        __wbindgen_cast_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return addHeapObject(ret);
        },
        __wbindgen_cast_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return addHeapObject(ret);
        },
        __wbindgen_cast_0000000000000003: function(arg0) {
            // Cast intrinsic for `U64 -> Externref`.
            const ret = BigInt.asUintN(64, arg0);
            return addHeapObject(ret);
        },
        __wbindgen_object_clone_ref: function(arg0) {
            const ret = getObject(arg0);
            return addHeapObject(ret);
        },
        __wbindgen_object_drop_ref: function(arg0) {
            takeObject(arg0);
        },
    };
    return {
        __proto__: null,
        "./ifc-lite_bg.js": import0,
    };
}

const AlignmentAxisJsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_alignmentaxisjs_free(ptr, 1));
const ClashIntersectionSolidJsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_clashintersectionsolidjs_free(ptr, 1));
const ClashRunResultFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_clashrunresult_free(ptr, 1));
const ClashSessionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_clashsession_free(ptr, 1));
const Contours2DFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_contours2d_free(ptr, 1));
const GridAxisCollectionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_gridaxiscollection_free(ptr, 1));
const GridAxisJsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_gridaxisjs_free(ptr, 1));
const IfcAPIFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_ifcapi_free(ptr, 1));
const LandXmlTinStreamSessionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_landxmltinstreamsession_free(ptr, 1));
const MeshCollectionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_meshcollection_free(ptr, 1));
const MeshDataJsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_meshdatajs_free(ptr, 1));
const MeshOutlineJsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_meshoutlinejs_free(ptr, 1));
const PartitionedBatchFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_partitionedbatch_free(ptr, 1));
const ProfileCollectionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_profilecollection_free(ptr, 1));
const ProfileEntryJsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_profileentryjs_free(ptr, 1));
const ScanOutlineJsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_scanoutlinejs_free(ptr, 1));
const SimplifiedMeshesFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_simplifiedmeshes_free(ptr, 1));
const SpacePlateHandleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_spaceplatehandle_free(ptr, 1));
const SymbolicCircleFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_symboliccircle_free(ptr, 1));
const SymbolicFillAreaFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_symbolicfillarea_free(ptr, 1));
const SymbolicPolylineFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_symbolicpolyline_free(ptr, 1));
const SymbolicRepresentationCollectionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_symbolicrepresentationcollection_free(ptr, 1));
const SymbolicTextFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_symbolictext_free(ptr, 1));
const ZonePieceJsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_zonepiecejs_free(ptr, 1));
const ZoneSplitJsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_zonesplitjs_free(ptr, 1));

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function addBorrowedObject(obj) {
    if (stack_pointer == 1) throw new Error('out of js stack');
    heap[--stack_pointer] = obj;
    return stack_pointer;
}

function debugString(val) {
    // primitive types
    const type = typeof val;
    if (type == 'number' || type == 'boolean' || val == null) {
        return  `${val}`;
    }
    if (type == 'string') {
        return `"${val}"`;
    }
    if (type == 'symbol') {
        const description = val.description;
        if (description == null) {
            return 'Symbol';
        } else {
            return `Symbol(${description})`;
        }
    }
    if (type == 'function') {
        const name = val.name;
        if (typeof name == 'string' && name.length > 0) {
            return `Function(${name})`;
        } else {
            return 'Function';
        }
    }
    // objects
    if (Array.isArray(val)) {
        const length = val.length;
        let debug = '[';
        if (length > 0) {
            debug += debugString(val[0]);
        }
        for(let i = 1; i < length; i++) {
            debug += ', ' + debugString(val[i]);
        }
        debug += ']';
        return debug;
    }
    // Test for built-in
    const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val));
    let className;
    if (builtInMatches && builtInMatches.length > 1) {
        className = builtInMatches[1];
    } else {
        // Failed to match the standard '[object ClassName]'
        return toString.call(val);
    }
    if (className == 'Object') {
        // we're a user defined class or Object
        // JSON.stringify avoids problems with cycles, and is generally much
        // easier than looping through ownProperties of `val`.
        try {
            return 'Object(' + JSON.stringify(val) + ')';
        } catch (_) {
            return 'Object';
        }
    }
    // errors
    if (val instanceof Error) {
        return `${val.name}: ${val.message}\n${val.stack}`;
    }
    // TODO we could test for more things here, like `Set`s and `Map`s.
    return className;
}

function dropObject(idx) {
    if (idx < 1028) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayI32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getInt32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(takeObject(mem.getUint32(i, true)));
    }
    return result;
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getBigUint64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedBigUint64ArrayMemory0 = null;
function getBigUint64ArrayMemory0() {
    if (cachedBigUint64ArrayMemory0 === null || cachedBigUint64ArrayMemory0.byteLength === 0) {
        cachedBigUint64ArrayMemory0 = new BigUint64Array(wasm.memory.buffer);
    }
    return cachedBigUint64ArrayMemory0;
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

let cachedInt32ArrayMemory0 = null;
function getInt32ArrayMemory0() {
    if (cachedInt32ArrayMemory0 === null || cachedInt32ArrayMemory0.byteLength === 0) {
        cachedInt32ArrayMemory0 = new Int32Array(wasm.memory.buffer);
    }
    return cachedInt32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getObject(idx) { return heap[idx]; }

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        wasm.__wbindgen_export3(addHeapObject(e));
    }
}

let heap = new Array(1024).fill(undefined);
heap.push(undefined, null, true, false);

let heap_next = heap.length;

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayJsValueToWasm0(array, malloc) {
    const ptr = malloc(array.length * 4, 4) >>> 0;
    const mem = getDataViewMemory0();
    for (let i = 0; i < array.length; i++) {
        mem.setUint32(ptr + 4 * i, addHeapObject(array[i]), true);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

let stack_pointer = 1024;

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedBigUint64ArrayMemory0 = null;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedInt32ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('ifc-lite_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
