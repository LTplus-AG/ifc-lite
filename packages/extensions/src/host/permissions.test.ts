/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';
import { parseCapability } from '../capability/parse.js';
import { capabilitiesToPermissions } from './permissions.js';

function p(raw: string) {
  const r = parseCapability(raw);
  if (!r.ok) throw new Error(r.errors[0].message);
  return r.value;
}

describe('capabilitiesToPermissions — empty', () => {
  it('returns conservative defaults (everything false except lens)', () => {
    const perms = capabilitiesToPermissions([]);
    expect(perms).toEqual({
      model: false,
      query: false,
      viewer: false,
      mutate: false,
      store: false,
      lens: true,
      export: false,
      files: false,
    });
  });
});

describe('capabilitiesToPermissions — model', () => {
  it('model.read enables query + model', () => {
    const perms = capabilitiesToPermissions([p('model.read')]);
    expect(perms.model).toBe(true);
    expect(perms.query).toBe(true);
    expect(perms.mutate).toBe(false);
    expect(perms.store).toBe(false);
  });

  it('model.mutate enables mutate (and implies read)', () => {
    const perms = capabilitiesToPermissions([p('model.mutate:Pset_*.*')]);
    expect(perms.mutate).toBe(true);
    expect(perms.model).toBe(true);
    expect(perms.query).toBe(true);
    expect(perms.store).toBe(false);
  });

  it('model.create enables store', () => {
    const perms = capabilitiesToPermissions([p('model.create')]);
    expect(perms.store).toBe(true);
    expect(perms.model).toBe(true);
  });

  it('model.delete enables store', () => {
    const perms = capabilitiesToPermissions([p('model.delete')]);
    expect(perms.store).toBe(true);
  });

  it('multiple model capabilities combine', () => {
    const perms = capabilitiesToPermissions([p('model.read'), p('model.mutate:*'), p('model.create')]);
    expect(perms.model).toBe(true);
    expect(perms.query).toBe(true);
    expect(perms.mutate).toBe(true);
    expect(perms.store).toBe(true);
  });
});

describe('capabilitiesToPermissions — viewer', () => {
  it('any viewer capability enables viewer', () => {
    expect(capabilitiesToPermissions([p('viewer.read')]).viewer).toBe(true);
    expect(capabilitiesToPermissions([p('viewer.colorize')]).viewer).toBe(true);
    expect(capabilitiesToPermissions([p('viewer.fly')]).viewer).toBe(true);
    expect(capabilitiesToPermissions([p('viewer.section')]).viewer).toBe(true);
  });
});

describe('capabilitiesToPermissions — export', () => {
  it('any export.create enables export + files', () => {
    const perms = capabilitiesToPermissions([p('export.create:csv')]);
    expect(perms.export).toBe(true);
    expect(perms.files).toBe(true);
  });
});

describe('capabilitiesToPermissions — out-of-scope scopes', () => {
  it('storage.local does not flip any sandbox flag', () => {
    const perms = capabilitiesToPermissions([p('storage.local')]);
    expect(perms.model).toBe(false);
    expect(perms.export).toBe(false);
    expect(perms.viewer).toBe(false);
  });

  it('network.fetch does not flip any sandbox flag', () => {
    const perms = capabilitiesToPermissions([p('network.fetch:example.com')]);
    expect(perms.model).toBe(false);
    expect(perms.export).toBe(false);
  });

  it('ui.* does not flip any sandbox flag', () => {
    const perms = capabilitiesToPermissions([p('ui.dock')]);
    expect(perms.model).toBe(false);
    expect(perms.viewer).toBe(false);
  });

  it('command.invoke does not flip any sandbox flag', () => {
    const perms = capabilitiesToPermissions([p('command.invoke:*')]);
    expect(perms.model).toBe(false);
  });
});

describe('capabilitiesToPermissions — lens default', () => {
  it('lens is always true (metadata)', () => {
    expect(capabilitiesToPermissions([]).lens).toBe(true);
    expect(capabilitiesToPermissions([p('model.read')]).lens).toBe(true);
  });
});
