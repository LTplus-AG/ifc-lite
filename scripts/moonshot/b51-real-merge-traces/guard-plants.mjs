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
    why: 'a term supplied by the operator from outside the repository',
    build: () => ({ finding: 'an ordinary sentence about the measurement' }),
    forbidden: ['an ordinary sentence about the measurement'],
  },
];

/** The single artifact the red run drives through the real write path. */
export const RED_PLANTED_ARTIFACT = { note: 'user-985690' };
