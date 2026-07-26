/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Build the actual IFC model for a numeric design vector, mirroring
 * carbon-model.mjs exactly. Uses @ifc-lite/create's built dist (this
 * script is not a workspace package, so it reaches into sibling dist/
 * directly, same pattern as scripts/moonshot/g0-certificate-demo.mjs).
 *
 * Returns { content, mapping } where mapping is a list of
 * { expressId, key, ifcType, material } aligned with the parametric
 * element keys of carbon-model.mjs, so kernel-computed mesh volumes can
 * be compared element by element against the closed-form volumes.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WINDOWS_LONG, WINDOWS_SHORT, FILL_INSET, windowFractions } from './carbon-model.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '../../..');

const { IfcCreator } = await import(
  path.join(REPO_ROOT, 'packages/create/dist/index.js')
);
const { generateIfcGuid } = await import(
  path.join(REPO_ROOT, 'packages/encoding/dist/index.js')
);

const BEAM_GAP = 0.05;

// ============================================================================
// Seeded deterministic builds (certified-optimization raw-hash commitment)
// ============================================================================

/**
 * Names the exact seeded-build recipe below. A verifier that sees this spec
 * in a chain's endpoint reproduces the RAW file bytes from
 * (finalParams, guidSeed, timestampMs) alone; any change to the recipe
 * (PRNG, seed hashing, GUID derivation) must mint a new spec name so old
 * chains fail fast instead of mis-verifying.
 */
export const SEEDED_BUILD_SPEC = 'diff-spike-ifc-seeded-v1';

/** FNV-1a hash of a string seed to a uint32 (same construction as tools/world-gym/lib/rng.mjs). */
function hashSeed(input) {
  let h = 0x811c9dc5;
  const s = String(input);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG - `() => float in [0,1)`. */
function mulberry32(seedUint32) {
  let a = seedUint32 >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The `buildIfc` determinism argument for a seeded certified build:
 * GlobalIds drawn from `@ifc-lite/encoding`'s `generateIfcGuid(random)`
 * over a mulberry32 stream seeded from `guidSeed`, header/owner-history
 * pinned to `timestampMs`. Pure function of its inputs - the raw file
 * bytes of `buildIfc(x, seededBuildOptions(...))` are re-derivable by any
 * verifier holding (x, guidSeed, timestampMs).
 */
export function seededBuildOptions(guidSeed, timestampMs) {
  const random = mulberry32(hashSeed(guidSeed));
  return {
    Timestamp: timestampMs,
    GuidSource: () => generateIfcGuid(random),
  };
}

/**
 * @param {number[]} x design vector in PARAMS order
 * @param {{ Timestamp?: number, GuidSource?: () => string }} [determinism]
 *   optional IfcCreator determinism pins (ProjectParams.Timestamp /
 *   ProjectParams.GuidSource) - pass both to make the output bytes a pure
 *   function of `x`; omit for wall-clock/CSPRNG defaults.
 * @returns {{ content: string, mapping: Array<{expressId:number,key:string,ifcType:string,material:string}> }}
 */
export function buildIfc(x, determinism = {}) {
  const [Lx, Ly, h1, h2, h3, tw, ts, tr, wwL, wh, sill, dw, dh,
    cw, cd, bw, bh, tp, wwS, gt, fw, fd, fh, dt] = x;

  const creator = new IfcCreator({
    Name: 'diff-spike parametric building',
    Schema: 'IFC4',
    Author: 'M3 differentiability spike',
    ...(determinism.Timestamp !== undefined ? { Timestamp: determinism.Timestamp } : {}),
    ...(determinism.GuidSource !== undefined ? { GuidSource: determinism.GuidSource } : {}),
  });

  const mapping = [];
  const track = (expressId, key, ifcType, material) => {
    mapping.push({ expressId, key, ifcType, material });
    creator.addIfcMaterial(expressId, { Name: material });
  };

  const storeyHeights = [h1, h2, h3];
  const elevations = [0, h1, h1 + h2];
  let groundStoreyId = 0;

  for (let s = 0; s < 3; s++) {
    const h = storeyHeights[s];
    const H = h - ts;
    const storeyId = creator.addIfcBuildingStorey({
      Name: `Storey ${s + 1}`,
      Elevation: elevations[s],
    });
    if (s === 0) groundStoreyId = storeyId;

    // Floor slab over the outer footprint, storey-local z in [0, ts].
    const slabId = creator.addIfcSlab(storeyId, {
      Name: `Slab S${s + 1}`,
      Position: [-tw / 2, -tw / 2, 0],
      Width: Lx + tw,
      Depth: Ly + tw,
      Thickness: ts,
    });
    track(slabId, `slab-s${s}`, 'IfcSlab', 'Concrete');

    // Long facades: south (y=0) and north (y=Ly), full length Lx.
    // Each wall is authored with its FULL-SIZE openings; the hosted
    // fills below are inset by FILL_INSET and create a second, nested
    // opening fully contained in the full-size one, so the net cut
    // volume equals the full-size opening exactly (union of nested
    // boxes) while the fill panel never touches the host wall.
    for (const side of ['south', 'north']) {
      const y = side === 'south' ? 0 : Ly;
      const isEntrance = s === 0 && side === 'south';
      const fracs = windowFractions(WINDOWS_LONG);
      const wallOpenings = fracs.map((f, i) =>
        isEntrance && i === 1
          ? { Name: 'Entrance opening', Width: dw, Height: dh, Position: [f * Lx, 0, 0] }
          : { Name: `Window opening ${i}`, Width: wwL, Height: wh, Position: [f * Lx, 0, sill] });
      const wallId = creator.addIfcWall(storeyId, {
        Name: `Wall ${side} S${s + 1}`,
        Start: [0, y, ts],
        End: [Lx, y, ts],
        Thickness: tw,
        Height: H,
        Openings: wallOpenings,
      });
      track(wallId, `wall-${side}-s${s}`, 'IfcWall', 'Brick');

      for (let i = 0; i < fracs.length; i++) {
        const along = fracs[i] * Lx;
        if (isEntrance && i === 1) {
          const doorId = creator.addIfcWallDoor(wallId, {
            Name: 'Entrance door',
            Position: [along, 0, 0],
            Width: dw - 2 * FILL_INSET,
            Height: dh - FILL_INSET,
            Thickness: dt,
          });
          track(doorId, 'door-entrance', 'IfcDoor', 'Timber');
        } else {
          const winId = creator.addIfcWallWindow(wallId, {
            Name: `Window ${side} S${s + 1}-${i}`,
            Position: [along, 0, sill + FILL_INSET],
            Width: wwL - 2 * FILL_INSET,
            Height: wh - 2 * FILL_INSET,
            Thickness: gt,
          });
          track(winId, `win-${side}-s${s}-${i}`, 'IfcWindow', 'Glass');
        }
      }
    }

    // Short facades: west (x=0) and east (x=Lx), trimmed to Ly - tw so
    // corners touch the long walls without penetrating them.
    const shortLen = Ly - tw;
    for (const side of ['west', 'east']) {
      const xw = side === 'west' ? 0 : Lx;
      const fracs = windowFractions(WINDOWS_SHORT);
      const wallId = creator.addIfcWall(storeyId, {
        Name: `Wall ${side} S${s + 1}`,
        Start: [xw, tw / 2, ts],
        End: [xw, Ly - tw / 2, ts],
        Thickness: tw,
        Height: H,
        Openings: fracs.map((f, i) => ({
          Name: `Window opening ${i}`,
          Width: wwS,
          Height: wh,
          Position: [f * shortLen, 0, sill],
        })),
      });
      track(wallId, `wall-${side}-s${s}`, 'IfcWall', 'Brick');

      for (let i = 0; i < fracs.length; i++) {
        const winId = creator.addIfcWallWindow(wallId, {
          Name: `Window ${side} S${s + 1}-${i}`,
          Position: [fracs[i] * shortLen, 0, sill + FILL_INSET],
          Width: wwS - 2 * FILL_INSET,
          Height: wh - 2 * FILL_INSET,
          Thickness: gt,
        });
        track(winId, `win-${side}-s${s}-${i}`, 'IfcWindow', 'Glass');
      }
    }

    // Interior partition along Y at x = Lx/2, with one centred door.
    const partId = creator.addIfcWall(storeyId, {
      Name: `Partition S${s + 1}`,
      Start: [Lx / 2, tw / 2, ts],
      End: [Lx / 2, Ly - tw / 2, ts],
      Thickness: tp,
      Height: H,
      Openings: [{ Name: 'Partition door opening', Width: dw, Height: dh, Position: [shortLen / 2, 0, 0] }],
    });
    track(partId, `partition-s${s}`, 'IfcWall', 'Gypsum');
    const partDoorId = creator.addIfcWallDoor(partId, {
      Name: `Partition door S${s + 1}`,
      Position: [shortLen / 2, 0, 0],
      Width: dw - 2 * FILL_INSET,
      Height: dh - FILL_INSET,
      Thickness: dt,
    });
    track(partDoorId, `door-part-s${s}`, 'IfcDoor', 'Timber');

    // Columns on the (1/3, 2/3) grid, sitting on the slab.
    const colXs = [Lx / 3, (2 * Lx) / 3];
    const colYs = [Ly / 3, (2 * Ly) / 3];
    let colIdx = 0;
    for (const cx of colXs) {
      for (const cy of colYs) {
        const colId = creator.addIfcColumn(storeyId, {
          Name: `Column S${s + 1}-${colIdx}`,
          Position: [cx, cy, ts],
          Width: cw,
          Depth: cd,
          Height: H,
        });
        track(colId, `col-s${s}-${colIdx}`, 'IfcColumn', 'Concrete');
        colIdx += 1;
      }
    }

    // Beams along Y between the column faces on each column line.
    // Axis z keeps the whole cross-section clear of the slab above and
    // of the columns' tops regardless of section orientation.
    const beamZ = h - 0.02 - Math.max(bw, bh) / 2;
    const y0 = Ly / 3 + cd / 2 + BEAM_GAP;
    const y1 = (2 * Ly) / 3 - cd / 2 - BEAM_GAP;
    for (let i = 0; i < 2; i++) {
      const bx = colXs[i];
      const beamId = creator.addIfcBeam(storeyId, {
        Name: `Beam S${s + 1}-${i}`,
        Start: [bx, y0, beamZ],
        End: [bx, y1, beamZ],
        Width: bw,
        Height: bh,
      });
      track(beamId, `beam-s${s}-${i}`, 'IfcBeam', 'Concrete');
    }
  }

  // Roof level.
  const roofStoreyId = creator.addIfcBuildingStorey({
    Name: 'Roof level',
    Elevation: h1 + h2 + h3,
  });
  const roofId = creator.addIfcRoof(roofStoreyId, {
    Name: 'Roof',
    Position: [-tw / 2, -tw / 2, 0],
    Width: Lx + tw,
    Depth: Ly + tw,
    Thickness: tr,
  });
  track(roofId, 'roof', 'IfcRoof', 'Concrete');

  // Footings under the ground-storey columns (world coordinates,
  // top face at z = 0 = underside of the ground slab).
  const fXs = [Lx / 3, (2 * Lx) / 3];
  const fYs = [Ly / 3, (2 * Ly) / 3];
  let fIdx = 0;
  for (const fx of fXs) {
    for (const fy of fYs) {
      const footId = creator.addIfcFooting(groundStoreyId, {
        Name: `Footing ${fIdx}`,
        Position: [fx, fy, 0],
        Width: fw,
        Depth: fd,
        Height: fh,
      });
      track(footId, `footing-${fIdx}`, 'IfcFooting', 'Concrete');
      fIdx += 1;
    }
  }

  const result = creator.toIfc();
  return { content: result.content, mapping, stats: result.stats };
}
