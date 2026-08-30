/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * `getForEntity`/`getQuantitiesForEntity`'s shared helper for entities that
 * carry two (or more) base property/quantity sets sharing a name (a type
 * pset and an occurrence pset, say). A mutation key
 * (`${entityId}:${setName}:${memberName}`) has no identity past the set
 * NAME, so it can't tell apart which instance a SET/DELETE on an existing
 * member, or a brand-new member, was meant for. Both must still land on
 * exactly ONE instance: the FIRST one (in base-set order) whose own base
 * members already carry that name -- matching the "first match across the
 * sequence wins" read semantics `findPropertyInSets`/
 * `PropertyTable.getProperty` already use for same-named reads (#3468). A
 * member that exists on NO instance yet (a genuinely new property/quantity)
 * is claimed by the first instance of that set name, same as a brand-new
 * set would be.
 *
 * One implementation, parameterised over the set/member shapes, backs both
 * the property and quantity paths -- they are one mechanism (a name-only
 * mutation key over possibly-repeated set names) and must agree; a
 * property-only or quantity-only copy would drift the same way the pset and
 * qset paths themselves drifted before this file existed.
 */

export interface SetClaims<S> {
  /** `${setName}:${memberName}` -> the base set instance that owns edits to it. */
  readonly claimingInstanceForMember: Map<string, S>;
  /** `setName` -> the first base set instance carrying that name. */
  readonly firstInstanceOfSetName: Map<string, S>;
}

export function computeSetClaims<S extends { name: string }>(
  sets: readonly S[],
  membersOf: (set: S) => readonly { name: string }[],
): SetClaims<S> {
  const claimingInstanceForMember = new Map<string, S>();
  const firstInstanceOfSetName = new Map<string, S>();
  for (const set of sets) {
    if (!firstInstanceOfSetName.has(set.name)) {
      firstInstanceOfSetName.set(set.name, set);
    }
    for (const member of membersOf(set)) {
      const claimKey = `${set.name}:${member.name}`;
      if (!claimingInstanceForMember.has(claimKey)) {
        claimingInstanceForMember.set(claimKey, set);
      }
    }
  }
  return { claimingInstanceForMember, firstInstanceOfSetName };
}

/**
 * The mutated member list for ONE base set instance: its own members with
 * SET/DELETE applied only where this instance is the claiming one for that
 * name, plus any genuinely-new member this instance claims as the first
 * instance of its set name.
 *
 * @param memberKey builds the mutation-map key, e.g. `propertyKey`/`quantityKey`.
 * @param applySet builds the output row for an own member a SET mutation targets.
 * @param passthrough builds the output row for an own member with no mutation
 *   applied here (either unmutated, or mutated on a sibling instance instead).
 * @param buildNew builds the output row for a brand-new member this instance claims.
 */
export function mutatedMembersForInstance<
  S extends { name: string },
  M extends { name: string },
  Mut extends { operation: 'SET' | 'DELETE' },
  Out extends { name: string },
>(
  entityId: number,
  set: S,
  members: readonly M[],
  claims: SetClaims<S>,
  mutations: ReadonlyMap<string, Mut>,
  entityMemberKeys: ReadonlySet<string> | undefined,
  memberKey: (entityId: number, setName: string, memberName: string) => string,
  applySet: (member: M, mutation: Mut) => Out,
  passthrough: (member: M) => Out,
  buildNew: (name: string, mutation: Mut) => Out,
): Out[] {
  const { claimingInstanceForMember, firstInstanceOfSetName } = claims;

  const mutatedMembers: Out[] = [];
  for (const member of members) {
    const isClaimingInstance = claimingInstanceForMember.get(`${set.name}:${member.name}`) === set;
    if (!isClaimingInstance) {
      mutatedMembers.push(passthrough(member));
      continue;
    }

    const key = memberKey(entityId, set.name, member.name);
    const mutation = mutations.get(key);
    if (mutation) {
      if (mutation.operation === 'DELETE') continue;
      mutatedMembers.push(applySet(member, mutation));
    } else {
      mutatedMembers.push(passthrough(member));
    }
  }

  // New members (never present on any same-named base instance) land on
  // the first instance of this set name only, and only when no OTHER
  // same-named instance already owns that name in its own base members
  // (that member isn't new at all, just claimed by the sibling above).
  if (firstInstanceOfSetName.get(set.name) === set && entityMemberKeys) {
    const setPrefix = `${entityId}:${set.name}:`;
    for (const key of entityMemberKeys) {
      if (!key.startsWith(setPrefix)) continue;
      const mutation = mutations.get(key);
      if (!mutation || mutation.operation !== 'SET') continue;
      const memberName = key.slice(setPrefix.length);
      if (claimingInstanceForMember.has(`${set.name}:${memberName}`)) continue; // owned by a sibling instance's own member
      if (!mutatedMembers.some(m => m.name === memberName)) {
        mutatedMembers.push(buildNew(memberName, mutation));
      }
    }
  }

  return mutatedMembers;
}
