/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, expect, expectTypeOf } from 'vitest';
import JSZip from 'jszip';
import { unwrapIfcZipWithResources, type IfcZipContents } from './ifczip.js';
import { IfcParser } from './index.js';

const STEP = "ISO-10303-21;\nHEADER;FILE_SCHEMA(('IFC4'));ENDSEC;\nDATA;\n#1=IFCWALL('0lF5j7cVb4wg1BM4WLtT33',$,'Shared wall',$,$,$,$,$,.NOTDEFINED.);\nENDSEC;END-ISO-10303-21;";
function shared(bytes: Uint8Array): SharedArrayBuffer {
  const source = new SharedArrayBuffer(bytes.byteLength);
  new Uint8Array(source).set(bytes);
  return source;
}
async function archive(entries: Record<string, string>): Promise<ArrayBuffer> {
  const zip = new JSZip();
  for (const [path, text] of Object.entries(entries)) zip.file(path, text);
  return zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE' });
}

describe('shared source ownership (#6537)', () => {
  it('retains the same ordinary source and existing ArrayBuffer result type', async () => {
    const source = new TextEncoder().encode(STEP).buffer;
    const result = await unwrapIfcZipWithResources(source);
    expectTypeOf(result).toEqualTypeOf<IfcZipContents>();
    expect(result.model).toBe(source);
    expect(result.originalResources.size).toBe(0);
  });

  it('retains plain SAB bytes through real main-thread fallback parsing', async () => {
    const source = shared(new TextEncoder().encode(STEP));
    const result = await unwrapIfcZipWithResources(source);
    expectTypeOf(result.model).toEqualTypeOf<ArrayBuffer | SharedArrayBuffer>();
    expect(result.model).toBe(source);
    const store = await new IfcParser().parseColumnar(result.model, { disableWorkerScan: true });
    expect(store.entities.getName(1)).toBe('Shared wall');
    expect(store.source.slice(0, source.byteLength).buffer).toBe(source);
  });

  it('extracts model and resources from a SAB archive, never returning archive bytes as model', async () => {
    const source = shared(new Uint8Array(await archive({ 'Models/model.ifc': STEP, 'Models/Textures/brick.png': 'image bytes' })));
    const result = await unwrapIfcZipWithResources(source);
    expect(result.model).toBeInstanceOf(ArrayBuffer);
    expect(result.model).not.toBe(source);
    expect(new TextDecoder().decode(result.model)).toBe(STEP);
    expect(result.modelPath).toBe('Models/model.ifc');
    expect(new TextDecoder().decode(result.originalResources.get('Models/Textures/brick.png'))).toBe('image bytes');
    const store = await new IfcParser().parseColumnar(result.model, { disableWorkerScan: true });
    expect(store.entities.getName(1)).toBe('Shared wall');
  });

  it('keeps archive ambiguity and extraction limits on shared input', async () => {
    const duplicate = shared(new Uint8Array(await archive({ 'a.ifc': STEP, 'b.ifc': STEP })));
    await expect(unwrapIfcZipWithResources(duplicate)).rejects.toThrow(/2 model files/);
    const compressed = shared(new Uint8Array(await archive({ 'a.ifc': STEP.repeat(4) })));
    await expect(unwrapIfcZipWithResources(compressed, 32)).rejects.toThrow(/over the .* limit/);
  });
});
