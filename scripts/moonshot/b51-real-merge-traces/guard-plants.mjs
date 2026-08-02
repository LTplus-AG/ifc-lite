/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * PLANTED IDENTIFIERS, IN THEIR OWN FILE ON PURPOSE.
 *
 * Net 1 of the guard accounts a string for by finding it in a declared set of
 * committed source files. This file is deliberately NOT in that set, because
 * everything in it is material the guard is supposed to reject: if it were in
 * the corpus, the guard would account for every plant as "text this bet's own
 * source contains" and the proof would pass by construction while proving
 * nothing. Keeping the plants out of the corpus is what makes the proof a
 * proof.
 *
 * (This is not hypothetical. The first revision of these cases lived inside
 * run.mjs, which IS in the corpus, and every case came back clean on net 1.)
 *
 * The tokens below are not real user data. Two are shaped after material seen
 * in a local demo room log, chosen because they are the realistic forms; the
 * digits and names are invented. Nothing here is a real person, room, project
 * or file.
 */

/**
 * Each case names the net it must trip. A case caught only by the OTHER net is
 * a FAILED case: the two nets are supposed to be independent, and B5.2's
 * lesson is precisely that two lines of defence sharing one hole are one line
 * of defence.
 */
export const GUARD_CASES = [
  {
    id: 'g1',
    net: 1,
    why: 'a session user identifier in a value position',
    build: () => ({ note: 'user-985690' }),
  },
  {
    id: 'g2',
    net: 1,
    why: 'the same identifier as an object KEY, which a value-only scan misses',
    build: () => ({ 'user-985690': 1 }),
  },
  {
    id: 'g3',
    net: 1,
    why: 'a compressed IFC GlobalId',
    build: () => ({ globalId: '2O2Fr$t4X7Zf8NOew3FLOH' }),
  },
  {
    id: 'g4',
    net: 1,
    why: 'an absolute filesystem path naming a model file',
    build: () => ({ source: '/Users/example/projects/tower-north.ifc' }),
  },
  {
    id: 'g5',
    net: 1,
    why: 'a second-precision wall-clock timestamp, which pins an edit to a person',
    build: () => ({ at: '2026-05-02T09:22:17.798Z' }),
  },
  {
    id: 'g6',
    net: 1,
    why: 'an authored element name -- the case that has no pattern and defeats every denylist',
    build: () => ({ label: 'Kitchen partition 749 renamed by Anna' }),
  },
  {
    id: 'g7',
    net: 1,
    why: 'a room identifier, which in this deployment doubles as a project path',
    build: () => ({ room: 'project-abc/model.ifcx' }),
  },
  {
    id: 'g8',
    net: 2,
    why:
      'a term supplied by the operator from outside the repository. The phrase is deliberately one ' +
      'net 1 accounts for -- it is verbatim in the guard corpus -- so this case exercises net 2 ' +
      'ALONE. If it tripped net 1 as well it would prove nothing about net 2 being an independent ' +
      'line of defence.',
    build: () => ({ finding: 'the synthetic schedule generator' }),
    forbidden: ['the synthetic schedule generator'],
  },
  {
    id: 'g9',
    net: 1,
    why:
      'an authored model name assembled ENTIRELY out of words the corpus already contains -- ' +
      'the third variant of this program\'s recurring blindness, after a regex that lost quote ' +
      'parity and an allowlist that matched on appearance. Every word here occurs in the guard\'s ' +
      'own source; the phrase does not. A provenance test that asks about words instead of about ' +
      'the string passes this, and net 2 only stops it if the operator happened to list this exact ' +
      'phrase, which for a name nobody anticipated is exactly what does not happen.',
    build: () => ({ model: 'Main Building' }),
  },
  {
    id: 'g10',
    net: 1,
    why:
      'a BARE single-token authored name in a value -- the fourth variant of the same blindness. ' +
      'The allowlist carried a dotted-field-path shape whose dotted tail was optional, so one ' +
      'alphanumeric word matched it and was accounted for by appearance alone. An element name, ' +
      'a project codename or a short user handle is exactly one word.',
    build: () => ({ label: 'Riverbend' }),
  },
  {
    id: 'g11',
    net: 1,
    why:
      'the same bare token in a KEY position, which is the half of an artifact a value-only scan ' +
      'never reaches. Planted separately from g10 because the key path and the value path are ' +
      'different lines of code and the field-path shape covered both.',
    build: () => ({ Zellweger: 3 }),
  },
  {
    id: 'g12',
    net: 1,
    why:
      'a DOTTED two-part authored name. This is the case that decides between narrowing the ' +
      'field-path shape and deleting it: requiring at least one separator, the obvious repair, ' +
      'still admits this string. A rule about what a name resembles cannot be narrowed into a ' +
      'rule about where it came from.',
    build: () => ({ contact: 'Marlen.Zellweger' }),
  },
  {
    id: 'g13',
    net: 1,
    why:
      'a room identifier shaped like an in-repository file path. The allowlist had a shape for ' +
      'repository paths, and a room id in this deployment is a slash-separated project and model ' +
      'name, so a room whose first segment happens to be a repository directory name was ' +
      'accounted for by that shape.',
    build: () => ({ room: 'apps/Riverbend-Nordturm' }),
  },
  {
    id: 'g14',
    net: 2,
    why:
      'an operator-supplied term containing a double quote. Net 2 searched only the output of ' +
      'JSON.stringify, where such a term appears escaped, so the raw substring test could not ' +
      'find it -- a quoted nickname inside a model or room name is an ordinary thing to list. ' +
      'Like g8 the phrase is verbatim in the guard corpus, so net 1 accounts for it and the case ' +
      'exercises net 2 ALONE.',
    build: () => ({ finding: '"looks like an identifier"' }),
    forbidden: ['"looks like an identifier"'],
  },
];

/** The single artifact the red run drives through the real write path. */
export const RED_PLANTED_ARTIFACT = { note: 'user-985690' };
