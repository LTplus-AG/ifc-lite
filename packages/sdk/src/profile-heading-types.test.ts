/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** #6232 D5: public parameter assignability is a compile-time compatibility
 * contract. Root typecheck and the oracle's typecheck observer verify these
 * against SDK source; the CLI fixture proves actual saved IFC/native geometry. */
import { expectTypeOf, it } from 'vitest';
import type { ProfiledBeamInStoreParams, ProfiledColumnInStoreParams,
  ProfiledMemberInStoreParams } from '@ifc-lite/create';
import type { StoreNamespace } from './namespaces/store.js';
import type { AddBeamInStoreParams, AddColumnInStoreParams,
  AddMemberInStoreParams, StoreBackendMethods } from './types.js';

// Existing public rectangular interfaces remain valid interface bases.
interface RectangularColumnConsumer extends AddColumnInStoreParams { Name: string }
interface RectangularBeamConsumer extends AddBeamInStoreParams { Name: string }
interface RectangularMemberConsumer extends AddMemberInStoreParams { Name: string }

it('#6232 accepts canonical profiled columns in both public method contracts', () => {
  expectTypeOf<ProfiledColumnInStoreParams>().toExtend<Parameters<StoreBackendMethods['addColumn']>[2]>();
  expectTypeOf<ProfiledColumnInStoreParams>().toExtend<Parameters<StoreNamespace['addColumn']>[2]>();
  expectTypeOf<RectangularColumnConsumer>().toExtend<Parameters<StoreNamespace['addColumn']>[2]>();
  expectTypeOf<AddColumnInStoreParams['RefDirection']>().toEqualTypeOf<[number, number, number] | undefined>();
});

it('#6232 accepts canonical profiled beams and existing rectangular consumers', () => {
  expectTypeOf<ProfiledBeamInStoreParams>().toExtend<Parameters<StoreBackendMethods['addBeam']>[2]>();
  expectTypeOf<ProfiledBeamInStoreParams>().toExtend<Parameters<StoreNamespace['addBeam']>[2]>();
  expectTypeOf<RectangularBeamConsumer>().toExtend<Parameters<StoreNamespace['addBeam']>[2]>();
});

it('#6232 accepts canonical profiled members and existing rectangular consumers', () => {
  expectTypeOf<ProfiledMemberInStoreParams>().toExtend<Parameters<StoreBackendMethods['addMember']>[2]>();
  expectTypeOf<ProfiledMemberInStoreParams>().toExtend<Parameters<StoreNamespace['addMember']>[2]>();
  expectTypeOf<RectangularMemberConsumer>().toExtend<Parameters<StoreNamespace['addMember']>[2]>();
});
