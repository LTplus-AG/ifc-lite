/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { DEFAULT_PROFILE, profileToDictionary, type ProfileDefinition } from '@ifc-lite/semantic';
import { SemanticProfileControls } from '@/components/viewer/SemanticProfileControls';
import { render, type as input, click, cleanup } from '@/test/render';

afterEach(cleanup);
test('charter #6643: neutral dictionary import projects supported fields and keeps unsupported source relations visible', () => {
  const profiles: ProfileDefinition[] = []; const errors: string[] = [];
  const dictionary = profileToDictionary(DEFAULT_PROFILE, [{ relation: 'https://example.org/relationship', target: 'https://example.org/evidence' }]);
  const serialized = JSON.stringify(dictionary, null, 2);
  const ui = render(<SemanticProfileControls profile={DEFAULT_PROFILE} onProfile={profile => profiles.push(profile)} onError={error => errors.push(error)} />);
  const textarea = ui.querySelector('textarea'); assert.ok(textarea);
  input(textarea, serialized);
  const button = [...ui.querySelectorAll('button')].find(element => element.textContent === 'Use neutral dictionary'); assert.ok(button);
  click(button);
  assert.deepEqual(errors, []);
  // The portable JSON dictionary omits undefined optional members.
  assert.deepEqual(profiles, [JSON.parse(JSON.stringify(DEFAULT_PROFILE))]);
  assert.equal(textarea.value, serialized);
  assert.ok(ui.textContent?.includes('Unsupported relation 1 retained in raw dictionary'));
  assert.ok(ui.textContent?.includes('generated profiles contain the supported subset'));
});
test('charter #6643: neutral dictionary import rejects unknown configuration and malformed envelopes without changing the active profile', () => {
  const profiles: ProfileDefinition[] = []; const errors: string[] = [];
  const ui = render(<SemanticProfileControls profile={DEFAULT_PROFILE} onProfile={profile => profiles.push(profile)} onError={error => errors.push(error)} />);
  const textarea = ui.querySelector('textarea'); assert.ok(textarea);
  const button = [...ui.querySelectorAll('button')].find(element => element.textContent === 'Use neutral dictionary'); assert.ok(button);
  input(textarea, JSON.stringify({ ...profileToDictionary(DEFAULT_PROFILE), bearer: 'must-not-persist' })); click(button);
  input(textarea, JSON.stringify({ id: 'urn:dictionary', properties: [] })); click(button);
  assert.equal(profiles.length, 0); assert.equal(errors.length, 2);
  assert.match(errors[0], /Unsupported neutral dictionary member/); assert.match(errors[1], /dictionary envelope/);
});


test('#8554 bSDD search and profile import use the same-origin proxy', async () => {
  const originalFetch = globalThis.fetch;
  const requests: URL[] = []; const profiles: ProfileDefinition[] = []; const errors: string[] = [];
  const uri = 'https://identifier.buildingsmart.org/uri/buildingsmart/ifc/4.3/class/IfcWindow';
  globalThis.fetch = async request => {
    assert.equal(typeof request, 'string');
    const url = new URL(String(request), 'https://viewer.example'); requests.push(url);
    assert.equal(url.origin, 'https://viewer.example');
    if (url.pathname === '/api/bsdd/api/Class/Search/v1') {
      assert.equal(url.searchParams.get('SearchText'), 'IfcWindow');
      return Response.json({ classes: [{ uri, code: 'IfcWindow', name: 'Window', dictionaryUri: 'https://example.org/dictionary' }] });
    }
    assert.equal(url.pathname, '/api/bsdd/api/Class/v1');
    assert.equal(url.searchParams.get('Uri'), uri);
    return Response.json({ uri, code: 'IfcWindow', name: 'Window', classProperties: [
      { name: 'IsExternal', propertyUri: 'https://example.org/IsExternal', dataType: 'Boolean' },
    ] });
  };
  try {
    const ui = render(<SemanticProfileControls profile={DEFAULT_PROFILE} onProfile={profile => profiles.push(profile)} onError={error => errors.push(error)} />);
    input(ui.querySelector('input')!, 'IfcWindow');
    await act(async () => { click([...ui.querySelectorAll('button')].find(button => button.textContent === 'Search bSDD and choose a class')!); });
    const result = [...ui.querySelectorAll('li button')][0]; assert.ok(result);
    await act(async () => { click(result); });
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 2);
    assert.equal(profiles.length, 1);
    assert.equal(profiles[0].fields.IsExternal.kind, 'boolean');
    assert.equal(profiles[0].types.IfcWindow.iri, uri);
  } finally { globalThis.fetch = originalFetch; }
});
