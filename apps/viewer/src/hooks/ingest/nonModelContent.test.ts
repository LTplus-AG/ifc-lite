/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #9523: error responses saved or served as models are recognised; files a loader would open are not. */
import '@/test/setup-dom.js';
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { isInvalidInputError } from '@/lib/invalid-input-errors';
import { NON_MODEL_REASONS, nonModelContentMessage } from '@/lib/non-model-reasons';
import { afterProlog, nonModelContentReason, textStartsLikeStep } from './nonModelContent';
import { FORMAT_HEAD_BYTES } from './sourceBuffers';

/** UTF-16 bytes of `text` with a BOM. */
const utf16 = (text: string, be = false) => new Uint8Array([...(be ? [0xfe, 0xff] : [0xff, 0xfe]), ...Array.from(text).flatMap((c) => (be ? [0, c.charCodeAt(0)] : [c.charCodeAt(0), 0]))]);

const step = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;";
const reason = (body: BlobPart, name: string) => nonModelContentReason(new File([body], name));

it('#9523 recognises error responses under any model name', async () => {
  const cases: Array<[BlobPart, string, RegExp]> = [
    ['<title>403 Forbidden</title>', 'house.ifc', /HTML page/],
    ['<h1>Forbidden</h1>', 'model.ifcx', /HTML page/],
    ['<!-- login -->\n<ARTICLE>Sign in</ARTICLE>', 'model.glb', /HTML page/],
    ['<input/>', 'model.glb', /HTML page/],
    ['<!DOCTYPEhtml><p>denied</p>', 'scan.las', /HTML page/],
    [`<!DOCTYPE${' '.repeat(80)}html><h1>403</h1>`, 'model.glb', /HTML page/],
    [`<!-- ${'b'.repeat(5000)} --><html><body>Sign in</body></html>`, 'house.ifc', /HTML page/],
    ['{"error":"expired"}', 'house.ifc', /JSON response/],
    ['<!-- edge -->{"message":"Forbidden"}', 'model.ifcx', /JSON response/],
    ['{"header":{"status":403},"error":"expired"}', 'model.ifcx', /without a valid IFCX header\.ifcxVersion/],
    ['{"header":{"status":403}}', 'scan.ply', /^a JSON response, not a model$/],
    ['<!DOCTYPE html>\x00<html>Forbidden', 'a.glb', /HTML page/],
    [`<!DOCTYPE${' '.repeat(1100)}html>Access denied`, 'm.glb', /HTML page/],
    ['Error: expected ISO-10303-21 header', 'a.ifc', /neither STEP/],
    ['ISO-10303-21: Access denied', 'house.ifc', /neither STEP/],
    ['ISO-10303-210; Access denied', 'house.ifc', /neither STEP/],
    ['Isolation failure: access denied', 'a.ifc', /neither STEP/],
    ['[ERROR] token expired', 'house.ifc', /neither STEP/],
    ['/* Access denied', 'house.ifc', /neither STEP/],
    ['\uFEFF<!DOCTYPE html>\x00<html>Forbidden', 'a.glb', /HTML page/],
    [`${'\n'.repeat(5000)}<!DOCTYPE html><html>Forbidden`, 'a.glb', /HTML page/],
    [`${'\n'.repeat(5000)}{"error":"forbidden"}`, 'a.las', /JSON response/],
    [new Uint8Array([0xff, 0xfe, ...Array.from('<html>Error</html>').flatMap((c) => [c.charCodeAt(0), 0])]), 'a.glb', /HTML page/],
    ['\x1b[31mError\x1b[0m forbidden', 'house.ifc', /neither STEP/],
    ['{"header":{"ifcxVersion":null}}', 'model.ifcx', /without a valid IFCX header\.ifcxVersion/],
    ['{"header":{"version":"1"},"data":[]}', 'model.ifcx', /without a valid IFCX header\.ifcxVersion/],
    [`<!DOCTYPE${' '.repeat(300)}html>Access denied`, 'model.glb', /HTML page/],
    ['"expired"', 'scan.ply', /JSON response/],
    ['<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>', 'terrain.xml', /XML error response/],
    ['<?xml version="1.0"?><!-- s3 --><ErrorResponse/>', 'terrain.xml', /XML error response/],
    ['<ows:ExceptionReport/>', 'terrain.xml', /XML error response/],
    ['<soap:Fault/>', 'terrain.xml', /XML error response/],
    ['<ERROR><Message>Denied</Message></ERROR>', 'terrain.xml', /XML error response/],
    ['<!DOCTYPE Error [<!ENTITY x "a>b">]><Error/>', 'terrain.xml', /XML error response/],
    ['Access Denied', 'house.ifc', /neither STEP/],
    [utf16('Access denied'), 'house.ifc', /neither STEP/],
    [utf16('Access denied', true), 'house.ifc', /neither STEP/],
    [utf16('{"error":"x"}'), 'a.ifc', /JSON response/],
    [utf16('<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>'), 'a.ifc', /XML error response/],
    [utf16('{"error":"x"}'), 'a.las', /JSON response/],
    [utf16('<Error/>'), 'a.xml', /XML error response/],
    [utf16('ISO-10303-21;'), 'house.ifc', /saved as UTF-16/],
    [utf16('<html><body>Forbidden</body></html>'), 'a.ifc', /HTML page/],
    [utf16('<title>Error</title>\x1b'), 'a.ifc', /HTML page/],
    ['<title>Error</title>\x1b', 'house.ifc', /HTML page/],
    [utf16('Error: expected ISO-10303-21 header'), 'a.ifc', /neither STEP/],
    [utf16(`${' '.repeat(3000)}ISO-10303-21;`), 'spaced16.ifc', /saved as UTF-16/],
    [utf16(`/* ${'x'.repeat(3000)} */ISO-10303-21;`), 'comment16.ifc', /saved as UTF-16/],
    [new Uint8Array([0xff, 0xfe]), 'blank16.ifc', /neither STEP/],
    [utf16('  \n'), 'blank16b.ifc', /neither STEP/],
    [utf16('{"header":{"ifcxVersion":"ifcx_alpha"}}'), 'ifcx16.ifc', /neither STEP/],
    ['nope', 'pack.ifczip', /neither STEP/],
  ];
  for (const [body, name, expected] of cases) assert.match(String(await reason(body, name)), expected, `${name}: ${String(body).slice(0, 40)}`);
});

it('#9523 leaves every file a loader would open alone', async () => {
  const ifcx = readFileSync(new URL('../../../public/samples/hello-wall.ifcx', import.meta.url), 'utf8');
  const cases: Array<[BlobPart, string]> = [
    [step, 'house.ifc'],
    [`/* exported by X */\n${step}`, 'commented.ifc'],
    ['ISO 10303-21;\nHEADER;', 'spaced-iso.ifc'],
    ['ISO10303-21;\nHEADER;', 'tight-iso.ifc'],
    ['iso-10303-21;\nHEADER;', 'lower-iso.ifc'],
    [utf16('3\n1.0 2.0 3.0'), 'cloud.pts'],
    [new Uint8Array([0xff, 0xfe, 0x3c, 0x00, 0x01, 0x00, 0x02, 0x00, 0x7b, 0x00]), 'capture.splat'], // binary that starts like a UTF-16 BOM
    ['ply\nformat ascii 1.0\nelement vertex 1\n', 'renamed-ply.ifc'],
    ['VERSION 0.7\nFIELDS x y z\n', 'renamed-pcd.ifc'],
    [`${' '.repeat(5000)}${step}`, 'spaced.ifc'],
    [`${' '.repeat(64 * 1024)}${step}`, 'step-beyond-scan.ifc'],
    [zipSync({ 'model.ifc': strToU8(step) }), 'pack.ifczip'],
    [zipSync({ 'model.ifc': strToU8(step) }), 'zipped.ifc'],
    [ifcx, 'model.ifcx'],
    [ifcx, 'model.ifc'],
    [`<?xml version="1.0"?>\n<!--${'x'.repeat(5000)}-->\n<LandXML/>`, 'terrain.xml'],
    ['<?xml version="1.0"?><lx:LandXML xmlns:lx="http://www.landxml.org/schema/LandXML-1.2"/>', 'terrain.xml'],
    ...['DefaultSettings', 'Default', 'UserDefault', 'ErrorBars', 'Exceptional', 'FaultModel'].map((root): [BlobPart, string] => [`<${root}/>`, 'other.xml']),
    [new Uint8Array([0x4c, 0x41, 0x53, 0x46, 0, 0, 1, 2]), 'scan.ply'],
    [new Uint8Array([0x7b, 1, 2, 3, 0, 5, 6, 7]), 'capture.splat'],
    [new Uint8Array([0x3c, 0x61, 0x20, 0x3e, 0, 5, 6, 7]), 'binary.splat'], // binary that starts like '<a >'
    ['version 0.7\nSIZE 4 4 4\n', 'cloud.pcd'],
    ['3\n1.0 2.0 3.0\n', 'cloud.pts'],
    ['ply\nformat ascii 1.0\n', 'mesh.ply'],
    [new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]), 'model.glb'],
    ['', 'empty.pts'],
    ['{"asset":{"version":"2.0"},"meshes":[]}', 'small.gltf'],
  ];
  for (const [body, name] of cases) assert.equal(await reason(body, name), null, `${name}: ${String(body).slice(0, 40)}`);
});

it('#9523 reads no more than the 4 KiB head for an ordinary STEP, binary or text point-cloud model', async () => {
  for (const [body, name] of [[step, 'house.ifc'], [new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 9, 9]), 'model.glb'], ['ply\nformat ascii 1.0\n', 'cloud.ply'], [new Uint8Array([0x4c, 0x41, 0x53, 0x46, 0, 0]), 'scan.las']] as const) {
    const file = new File([body, ' '.repeat(100_000)], name);
    let extraReads = 0;
    const realSlice = file.slice.bind(file);
    Object.defineProperty(file, 'slice', { value: (start?: number, end?: number) => { if (!(start === 0 && end === FORMAT_HEAD_BYTES)) extraReads++; return realSlice(start, end); } });
    assert.equal(await nonModelContentReason(file), null, name);
    assert.equal(extraReads, 0, name);
  }
});

it('#9523 scans a crafted prolog linearly', () => {
  // The previous regex took 388 ms at 24 comments and doubled per comment (measured in review): 40 would not finish.
  const started = Date.now();
  assert.equal(afterProlog(`${'<!---->'.repeat(40_000)}<LandXML/>`), '<LandXML/>');
  assert.ok(Date.now() - started < 5_000, `took ${Date.now() - started} ms`);
});

it('#9523 refusals are classified as invalid input, not crashes', () => {
  for (const r of Object.values(NON_MODEL_REASONS)) {
    assert.equal(isInvalidInputError(new Error(nonModelContentMessage(r)), nonModelContentMessage(r)), true, r);
  }
});

it('#9523 textStartsLikeStep: the shared STEP rule, past whitespace and comments', () => {
  for (const text of ['ISO-10303-21;', '  /* x */ ISO-10303-21;', 'iso 10303-21;', 'ISO10303-21;', 'ISO-10303-21 /* comment */ ;']) assert.equal(textStartsLikeStep(text), true, text);
  for (const text of ['/* unterminated ISO-10303-21;', 'Isolation failure', '', 'Error: expected ISO-10303-21', 'ISO-10303-21: denied', 'ISO-10303-21']) assert.equal(textStartsLikeStep(text), false, text);
});
