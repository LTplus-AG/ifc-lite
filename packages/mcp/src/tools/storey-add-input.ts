/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { AddStoreyParams } from '@ifc-lite/create';

/** Plan and apply resolve the same absolute or relative add request (#9352). */
export function storeyAddInput(
  input: Record<string, unknown>,
  suggest: (reference: number, side: 'above' | 'below') => { Name: string; Elevation: number },
): AddStoreyParams {
  const reference = input.reference_storey_express_id as number | undefined;
  let Name = input.Name as string | undefined, Elevation = input.Elevation as number | undefined;
  if (Name === undefined || Elevation === undefined) {
    if (reference === undefined) throw new Error('Give Name and Elevation, or reference_storey_express_id and side');
    const proposed = suggest(reference, (input.side as 'above' | 'below' | undefined) ?? 'above');
    Name ??= proposed.Name;
    Elevation ??= proposed.Elevation;
  }
  return { Name, Elevation, referenceStoreyId: reference,
    Description: input.Description as string | undefined, LongName: input.LongName as string | undefined,
    GlobalId: input.GlobalId as string | undefined, buildingId: input.building_express_id as number | undefined };
}
