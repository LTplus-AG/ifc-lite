/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * LandXML 1.2 TIN surface parser.
 *
 * The standard stores surface points as northing/easting/elevation triples
 * and faces as point-id references. This module deliberately stops at that
 * semantic boundary; renderer coordinates and f32 rebasing live in
 * `landXmlIngest.ts`.
 */

import {
  DOMParser,
  onErrorStopParsing,
  type Element as XmlElement,
} from '@xmldom/xmldom';

export interface LandXmlPoint {
  id: string;
  northing: number;
  easting: number;
  elevation: number;
}

export interface LandXmlTinSurface {
  name: string;
  points: LandXmlPoint[];
  faces: Array<readonly [string, string, string]>;
}

export interface LandXmlTinDocument {
  version: '1.2';
  units: {
    linearUnit: string;
    elevationUnit: string;
    linearScaleToMeters: number;
    elevationScaleToMeters: number;
  };
  surfaces: LandXmlTinSurface[];
  warnings: string[];
}

const UNIT_SCALE_TO_METERS: Readonly<Record<string, number>> = {
  millimeter: 0.001,
  centimeter: 0.01,
  meter: 1,
  kilometer: 1000,
  inch: 0.0254,
  foot: 0.3048,
  feet: 0.3048,
  USSurveyFoot: 1200 / 3937,
  mile: 1609.344,
  miles: 1609.344,
};

const LANDXML_12_NAMESPACE = 'http://www.landxml.org/schema/LandXML-1.2';

function elementChildren(parent: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === 1) out.push(node as XmlElement);
  }
  return out;
}

function namedChildren(parent: XmlElement, localName: string): XmlElement[] {
  return elementChildren(parent).filter(
    (child) => child.localName === localName && child.namespaceURI === parent.namespaceURI,
  );
}

function firstNamedChild(parent: XmlElement, localName: string): XmlElement | undefined {
  return namedChildren(parent, localName)[0];
}

function descendants(parent: XmlElement, localName: string): XmlElement[] {
  const out: XmlElement[] = [];
  const namespace = parent.namespaceURI;
  const visit = (element: XmlElement): void => {
    for (const child of elementChildren(element)) {
      if (child.localName === localName && child.namespaceURI === namespace) out.push(child);
      visit(child);
    }
  };
  visit(parent);
  return out;
}

function requiredAttribute(element: XmlElement, name: string, context: string): string {
  const value = element.getAttribute(name)?.trim();
  if (!value) throw new Error(`LandXML ${context} is missing required ${name}`);
  return value;
}

function positiveInteger(value: string, context: string): string {
  if (!/^\+?\d+$/.test(value)) throw new Error(`LandXML ${context} has invalid positive integer "${value}"`);
  const unsigned = value.startsWith('+') ? value.slice(1) : value;
  const canonical = unsigned.replace(/^0+/, '');
  if (!canonical) throw new Error(`LandXML ${context} has invalid positive integer "${value}"`);
  return canonical;
}

function parseFiniteTuple(text: string | null, count: number, context: string): number[] {
  const parts = (text ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length !== count) {
    throw new Error(`LandXML ${context} must contain ${count} numbers; found ${parts.length}`);
  }
  const values = parts.map(Number);
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error(`LandXML ${context} contains a non-finite number`);
  }
  return values;
}

function scaleFor(unit: string, context: string): number {
  const scale = UNIT_SCALE_TO_METERS[unit];
  if (scale === undefined) throw new Error(`Unsupported LandXML ${context} unit: ${unit}`);
  return scale;
}

function parseUnits(root: XmlElement): LandXmlTinDocument['units'] {
  const units = firstNamedChild(root, 'Units');
  if (!units) throw new Error('LandXML 1.2 document is missing Units');
  const declaration = elementChildren(units).find(
    (child) => child.namespaceURI === units.namespaceURI
      && (child.localName === 'Metric' || child.localName === 'Imperial'),
  );
  if (!declaration) throw new Error('LandXML Units must contain Metric or Imperial');
  const linearUnit = requiredAttribute(declaration, 'linearUnit', 'Units');
  // LandXML 1.2 declares `meter` as the schema default for elevationUnit on
  // both Metric and Imperial. Honour that exact default rather than guessing
  // from linearUnit.
  const elevationUnit = declaration.getAttribute('elevationUnit')?.trim() || 'meter';
  return {
    linearUnit,
    elevationUnit,
    linearScaleToMeters: scaleFor(linearUnit, 'linear'),
    elevationScaleToMeters: scaleFor(elevationUnit, 'elevation'),
  };
}

function parseSurface(surface: XmlElement): LandXmlTinSurface | null {
  const name = requiredAttribute(surface, 'name', 'Surface');
  const definition = firstNamedChild(surface, 'Definition');
  if (!definition || definition.getAttribute('surfType') !== 'TIN') return null;

  const pnts = firstNamedChild(definition, 'Pnts');
  if (!pnts) throw new Error(`LandXML TIN surface "${name}" is missing Pnts`);
  const points: LandXmlPoint[] = [];
  const pointIds = new Set<string>();
  for (const point of namedChildren(pnts, 'P')) {
    const id = positiveInteger(
      requiredAttribute(point, 'id', `surface "${name}" point`),
      `surface "${name}" point id`,
    );
    if (pointIds.has(id)) throw new Error(`LandXML surface "${name}" repeats point id ${id}`);
    const [northing, easting, elevation] = parseFiniteTuple(
      point.textContent,
      3,
      `surface "${name}" point ${id}`,
    );
    pointIds.add(id);
    points.push({ id, northing, easting, elevation });
  }
  if (points.length < 3) throw new Error(`LandXML TIN surface "${name}" needs at least 3 points`);

  const faces: Array<readonly [string, string, string]> = [];
  for (const facesElement of namedChildren(definition, 'Faces')) {
    for (const face of namedChildren(facesElement, 'F')) {
      if (face.getAttribute('i') === '1') continue;
      const rawIds = (face.textContent ?? '').trim().split(/\s+/).filter(Boolean);
      if (rawIds.length !== 3) {
        throw new Error(`LandXML TIN surface "${name}" face must reference exactly 3 points`);
      }
      const ids = rawIds.map((id) => positiveInteger(id, `surface "${name}" face point reference`));
      for (const id of ids) {
        if (!pointIds.has(id)) {
          throw new Error(`LandXML TIN surface "${name}" face references unknown point ${id}`);
        }
      }
      faces.push([ids[0], ids[1], ids[2]]);
    }
  }
  if (faces.length === 0) throw new Error(`LandXML TIN surface "${name}" has no visible faces`);
  return { name, points, faces };
}

/** Parse the LandXML 1.2 TIN subset supported by the viewer. */
export function parseLandXmlTin(xml: string): LandXmlTinDocument {
  let document;
  try {
    document = new DOMParser({ onError: onErrorStopParsing })
      .parseFromString(xml.replace(/^\uFEFF/, ''), 'application/xml');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'parse error';
    throw new Error(`Invalid LandXML XML: ${message}`);
  }
  const root = document.documentElement;
  if (!root || root.localName !== 'LandXML') throw new Error('XML document is not LandXML');

  const declaredVersion = root.getAttribute('version')?.trim();
  if (root.namespaceURI !== LANDXML_12_NAMESPACE) {
    throw new Error(`Unsupported LandXML namespace: ${root.namespaceURI || 'missing'}`);
  }
  const version = declaredVersion || '1.2';
  if (version !== '1.2') {
    throw new Error(`Unsupported LandXML version: ${version || 'missing'} (expected 1.2)`);
  }

  const warnings: string[] = [];
  const surfaces: LandXmlTinSurface[] = [];
  for (const surfaceElement of descendants(root, 'Surface')) {
    const surface = parseSurface(surfaceElement);
    if (surface) surfaces.push(surface);
    else warnings.push(`Skipped non-TIN or undefined surface "${surfaceElement.getAttribute('name') || 'unnamed'}"`);
  }
  if (surfaces.length === 0) throw new Error('LandXML document contains no renderable TIN surfaces');
  return { version: '1.2', units: parseUnits(root), surfaces, warnings };
}
