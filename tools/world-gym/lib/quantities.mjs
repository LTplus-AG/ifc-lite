/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Shared quantity math for World Gym families.
 *
 * Each function returns the exact numbers used to author the geometry AND
 * the IfcElementQuantity set attached to that element, so the embedded Qto
 * and the labeler's ground truth can never drift from one another - they
 * are the same numbers, computed once.
 */

/** Wall: rectangular extrusion Length x Height, Width = thickness. */
export function wallQuantities(length, height, thickness) {
  const grossArea = length * height;
  const grossVolume = grossArea * thickness;
  return {
    length,
    height,
    width: thickness,
    grossSideArea: grossArea,
    grossVolume,
    qset: {
      Name: 'GymQuantities',
      Quantities: [
        { Name: 'Length', Value: length, Kind: 'IfcQuantityLength' },
        { Name: 'Height', Value: height, Kind: 'IfcQuantityLength' },
        { Name: 'Width', Value: thickness, Kind: 'IfcQuantityLength' },
        { Name: 'GrossSideArea', Value: grossArea, Kind: 'IfcQuantityArea' },
        { Name: 'GrossVolume', Value: grossVolume, Kind: 'IfcQuantityVolume' },
      ],
    },
  };
}

/** Slab: rectangular footprint Width x Depth, extruded by Thickness. */
export function slabQuantities(width, depth, thickness) {
  const grossArea = width * depth;
  const grossVolume = grossArea * thickness;
  return {
    width,
    depth,
    thickness,
    grossArea,
    grossVolume,
    qset: {
      Name: 'GymQuantities',
      Quantities: [
        { Name: 'GrossArea', Value: grossArea, Kind: 'IfcQuantityArea' },
        { Name: 'GrossVolume', Value: grossVolume, Kind: 'IfcQuantityVolume' },
      ],
    },
  };
}

/** Column: rectangular cross-section Width x Depth, extruded by Height. */
export function columnQuantities(width, depth, height) {
  const crossSectionArea = width * depth;
  const grossVolume = crossSectionArea * height;
  return {
    width,
    depth,
    height,
    crossSectionArea,
    grossVolume,
    qset: {
      Name: 'GymQuantities',
      Quantities: [
        { Name: 'Length', Value: height, Kind: 'IfcQuantityLength' },
        { Name: 'CrossSectionArea', Value: crossSectionArea, Kind: 'IfcQuantityArea' },
        { Name: 'GrossVolume', Value: grossVolume, Kind: 'IfcQuantityVolume' },
      ],
    },
  };
}

/** Beam: rectangular cross-section Width x Height, extruded by Length. */
export function beamQuantities(width, height, length) {
  const crossSectionArea = width * height;
  const grossVolume = crossSectionArea * length;
  return {
    width,
    height,
    length,
    crossSectionArea,
    grossVolume,
    qset: {
      Name: 'GymQuantities',
      Quantities: [
        { Name: 'Length', Value: length, Kind: 'IfcQuantityLength' },
        { Name: 'CrossSectionArea', Value: crossSectionArea, Kind: 'IfcQuantityArea' },
        { Name: 'GrossVolume', Value: grossVolume, Kind: 'IfcQuantityVolume' },
      ],
    },
  };
}

/** Space (room): rectangular footprint Width x Depth, Height clear height. */
export function spaceQuantities(width, depth, height) {
  const netFloorArea = width * depth;
  const netVolume = netFloorArea * height;
  return {
    width,
    depth,
    height,
    netFloorArea,
    netVolume,
    qset: {
      Name: 'GymQuantities',
      Quantities: [
        { Name: 'NetFloorArea', Value: netFloorArea, Kind: 'IfcQuantityArea' },
        { Name: 'Height', Value: height, Kind: 'IfcQuantityLength' },
        { Name: 'NetVolume', Value: netVolume, Kind: 'IfcQuantityVolume' },
      ],
    },
  };
}

/** Accumulate a running totals object in place: totals[key] += value for every key in delta. */
export function accumulate(totals, delta) {
  for (const [key, value] of Object.entries(delta)) {
    totals[key] = (totals[key] ?? 0) + value;
  }
  return totals;
}
