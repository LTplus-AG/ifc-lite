/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Math utilities for 3D transformations
 */

import type { Vec3, Mat4 } from './types.js';

/**
 * Squared length below which `cross(up, viewDir)` is treated as degenerate in
 * {@link MathUtils.lookAt}. 1e-12 means a right axis shorter than 1e-6, i.e.
 * a unit `up` within a microradian of the view direction — orders of
 * magnitude tighter than any pose the navigation code produces (the ViewCube
 * top preset deliberately stops 0.01 rad off the pole), so the fallback only
 * ever replaces a basis that carries no usable orientation.
 */
const DEGENERATE_UP_LEN_SQ = 1e-12;

export class MathUtils {
    /**
     * Create identity matrix
     */
    static identity(): Mat4 {
        const m = new Float32Array(16);
        m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
        return { m };
    }

    /**
     * Create perspective projection matrix
     */
    static perspective(fov: number, aspect: number, near: number, far: number): Mat4 {
        const f = 1.0 / Math.tan(fov / 2);
        const nf = 1 / (near - far);

        const m = new Float32Array(16);
        m[0] = f / aspect;
        m[5] = f;
        m[10] = (far + near) * nf;
        m[11] = -1;
        m[14] = (2 * far * near) * nf;
        return { m };
    }

    /**
     * Create orthographic projection matrix (reverse-Z)
     * Uses same reverse-Z convention as perspective for consistent depth buffer behavior.
     * Depth range: near=1.0, far=0.0 (inverted)
     */
    static orthographicReverseZ(left: number, right: number, bottom: number, top: number, near: number, far: number): Mat4 {
        const m = new Float32Array(16);
        const lr = 1 / (left - right);
        const bt = 1 / (bottom - top);
        // Reverse-Z: swap near and far for depth mapping
        const nf = 1 / (far - near);

        m[0] = -2 * lr;
        m[5] = -2 * bt;
        m[10] = nf;              // Reverse-Z: maps far=0, near=1
        m[12] = (left + right) * lr;
        m[13] = (top + bottom) * bt;
        m[14] = far * nf;        // Reverse-Z offset
        m[15] = 1;
        return { m };
    }

    /**
     * Create reverse-Z perspective projection matrix
     * Reverse-Z distributes depth precision more evenly, eliminating Z-fighting
     * at far distances. Depth range: near=1.0, far=0.0 (inverted)
     */
    static perspectiveReverseZ(fov: number, aspect: number, near: number, far: number): Mat4 {
        const f = 1.0 / Math.tan(fov / 2);
        // For reverse-Z: near and far are swapped conceptually
        // We use infinite far plane approximation: far = infinity
        // This gives maximum precision across the entire range
        const m = new Float32Array(16);
        m[0] = f / aspect;
        m[5] = f;
        m[10] = 0.0;  // Reverse-Z: maps to 0.0 at far plane
        m[11] = -1;
        m[14] = near;  // Reverse-Z: maps to 1.0 at near plane
        return { m };
    }

    /**
     * Create look-at view matrix.
     *
     * Degenerate inputs are absorbed rather than propagated (#2441): a view
     * direction parallel to `up` (a plan/soffit pose, a Y-dominant auto-fit,
     * an externally authored BCF viewpoint) leaves `cross(up, viewDir)` at
     * zero length, and normalizing that used to write NaN into all sixteen
     * components — the viewport then drew nothing at all. The same held for
     * a zero-length `up` and for `eye === target`. Both now fall back to a
     * stable basis, so this function always returns a finite matrix.
     */
    static lookAt(eye: Vec3, target: Vec3, up: Vec3): Mat4 {
        let zx = eye.x - target.x;
        let zy = eye.y - target.y;
        let zz = eye.z - target.z;
        let zLenSq = zx * zx + zy * zy + zz * zz;
        if (!(zLenSq > 0)) {
            // eye coincides with target: there is no view direction to derive.
            // Look down -Z, the identity-camera convention.
            zx = 0; zy = 0; zz = 1; zLenSq = 1;
        }
        const len = 1 / Math.sqrt(zLenSq);
        const z0 = zx * len;
        const z1 = zy * len;
        const z2 = zz * len;

        let xx = up.y * z2 - up.z * z1;
        let xy = up.z * z0 - up.x * z2;
        let xz = up.x * z1 - up.y * z0;
        let xLenSq = xx * xx + xy * xy + xz * xz;
        if (!(xLenSq > DEGENERATE_UP_LEN_SQ)) {
            // `up` is parallel to the view direction (or zero-length), so it
            // carries no orientation. Substitute a hint that does: world Y
            // keeps the horizon level for any view direction that is not
            // itself vertical, and a vertical view (a plan or soffit pose)
            // falls back to -Z, which puts the same edge of the model at the
            // top of the screen as the ViewCube's top preset. Either way the
            // substitute is at least 30 degrees off the view direction, so
            // the basis is well conditioned and the choice is deterministic.
            const uy = Math.abs(z1) < 0.5 ? 1 : 0;
            const uz = uy === 1 ? 0 : -1;
            xx = uy * z2 - uz * z1;
            xy = uz * z0;
            xz = -uy * z0;
            xLenSq = xx * xx + xy * xy + xz * xz;
        }
        const len2 = 1 / Math.sqrt(xLenSq);
        const x0 = xx * len2;
        const x1 = xy * len2;
        const x2 = xz * len2;

        const y0 = z1 * x2 - z2 * x1;
        const y1 = z2 * x0 - z0 * x2;
        const y2 = z0 * x1 - z1 * x0;

        const m = new Float32Array(16);
        m[0] = x0; m[1] = y0; m[2] = z0; m[3] = 0;
        m[4] = x1; m[5] = y1; m[6] = z1; m[7] = 0;
        m[8] = x2; m[9] = y2; m[10] = z2; m[11] = 0;
        m[12] = -(x0 * eye.x + x1 * eye.y + x2 * eye.z);
        m[13] = -(y0 * eye.x + y1 * eye.y + y2 * eye.z);
        m[14] = -(z0 * eye.x + z1 * eye.y + z2 * eye.z);
        m[15] = 1;
        return { m };
    }

    /**
     * Multiply matrices
     */
    static multiply(a: Mat4, b: Mat4): Mat4 {
        const out = new Float32Array(16);
        const a00 = a.m[0], a01 = a.m[1], a02 = a.m[2], a03 = a.m[3];
        const a10 = a.m[4], a11 = a.m[5], a12 = a.m[6], a13 = a.m[7];
        const a20 = a.m[8], a21 = a.m[9], a22 = a.m[10], a23 = a.m[11];
        const a30 = a.m[12], a31 = a.m[13], a32 = a.m[14], a33 = a.m[15];

        const b00 = b.m[0], b01 = b.m[1], b02 = b.m[2], b03 = b.m[3];
        const b10 = b.m[4], b11 = b.m[5], b12 = b.m[6], b13 = b.m[7];
        const b20 = b.m[8], b21 = b.m[9], b22 = b.m[10], b23 = b.m[11];
        const b30 = b.m[12], b31 = b.m[13], b32 = b.m[14], b33 = b.m[15];

        out[0] = b00 * a00 + b01 * a10 + b02 * a20 + b03 * a30;
        out[1] = b00 * a01 + b01 * a11 + b02 * a21 + b03 * a31;
        out[2] = b00 * a02 + b01 * a12 + b02 * a22 + b03 * a32;
        out[3] = b00 * a03 + b01 * a13 + b02 * a23 + b03 * a33;
        out[4] = b10 * a00 + b11 * a10 + b12 * a20 + b13 * a30;
        out[5] = b10 * a01 + b11 * a11 + b12 * a21 + b13 * a31;
        out[6] = b10 * a02 + b11 * a12 + b12 * a22 + b13 * a32;
        out[7] = b10 * a03 + b11 * a13 + b12 * a23 + b13 * a33;
        out[8] = b20 * a00 + b21 * a10 + b22 * a20 + b23 * a30;
        out[9] = b20 * a01 + b21 * a11 + b22 * a21 + b23 * a31;
        out[10] = b20 * a02 + b21 * a12 + b22 * a22 + b23 * a32;
        out[11] = b20 * a03 + b21 * a13 + b22 * a23 + b23 * a33;
        out[12] = b30 * a00 + b31 * a10 + b32 * a20 + b33 * a30;
        out[13] = b30 * a01 + b31 * a11 + b32 * a21 + b33 * a31;
        out[14] = b30 * a02 + b31 * a12 + b32 * a22 + b33 * a32;
        out[15] = b30 * a03 + b31 * a13 + b32 * a23 + b33 * a33;

        return { m: out };
    }

    /**
     * Invert a 4x4 matrix
     */
    static invert(a: Mat4): Mat4 | null {
        const m = a.m;
        const out = new Float32Array(16);

        const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
        const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
        const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
        const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];

        const b00 = a00 * a11 - a01 * a10;
        const b01 = a00 * a12 - a02 * a10;
        const b02 = a00 * a13 - a03 * a10;
        const b03 = a01 * a12 - a02 * a11;
        const b04 = a01 * a13 - a03 * a11;
        const b05 = a02 * a13 - a03 * a12;
        const b06 = a20 * a31 - a21 * a30;
        const b07 = a20 * a32 - a22 * a30;
        const b08 = a20 * a33 - a23 * a30;
        const b09 = a21 * a32 - a22 * a31;
        const b10 = a21 * a33 - a23 * a31;
        const b11 = a22 * a33 - a23 * a32;

        let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
        if (!det) return null;
        det = 1.0 / det;

        out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
        out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
        out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
        out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
        out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
        out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
        out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
        out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
        out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
        out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
        out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
        out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
        out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
        out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
        out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
        out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;

        return { m: out };
    }

    /**
     * Transform vec3 by matrix (as point, w=1)
     */
    static transformPoint(m: Mat4, p: Vec3): Vec3 {
        const x = m.m[0] * p.x + m.m[4] * p.y + m.m[8] * p.z + m.m[12];
        const y = m.m[1] * p.x + m.m[5] * p.y + m.m[9] * p.z + m.m[13];
        const z = m.m[2] * p.x + m.m[6] * p.y + m.m[10] * p.z + m.m[14];
        const w = m.m[3] * p.x + m.m[7] * p.y + m.m[11] * p.z + m.m[15];
        return { x: x / w, y: y / w, z: z / w };
    }

    /**
     * Subtract vectors
     */
    static subtract(a: Vec3, b: Vec3): Vec3 {
        return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
    }

    /**
     * Normalize vector
     */
    static normalize(v: Vec3): Vec3 {
        const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
        if (len < 1e-10) return { x: 0, y: 0, z: 0 };
        return { x: v.x / len, y: v.y / len, z: v.z / len };
    }

    /**
     * Dot product
     */
    static dot(a: Vec3, b: Vec3): number {
        return a.x * b.x + a.y * b.y + a.z * b.z;
    }

    /**
     * Cross product
     */
    static cross(a: Vec3, b: Vec3): Vec3 {
        return {
            x: a.y * b.z - a.z * b.y,
            y: a.z * b.x - a.x * b.z,
            z: a.x * b.y - a.y * b.x,
        };
    }
}
