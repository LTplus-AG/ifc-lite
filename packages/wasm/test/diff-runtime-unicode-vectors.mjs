/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #8042: inputs only. Expectations come from the executing runtime's independent
// TS engine, never a Unicode-17-only golden file. Reusable by packed consumers.
// Latin capitals added in Unicode 16/17 and the complete Beria Erfe cased set:
// https://www.unicode.org/Public/17.0.0/ucd/UnicodeData.txt
export const casePairs = [
  [0x0264, 0xa7cb], [0x019b, 0xa7dc], [0xa7cd, 0xa7cc], [0xa7db, 0xa7da],
  [0xa7cf, 0xa7ce], [0xa7d3, 0xa7d2], [0xa7d5, 0xa7d4],
  ...Array.from({ length: 25 }, (_, index) => [0x16ebb + index, 0x16ea0 + index]),
  [0x00df, 0x0053], // Expansion: SS, deliberately not the single capital S.
].map(([lower, upper]) => [String.fromCodePoint(lower), String.fromCodePoint(upper)]);

export function unicodeRow(key, ifcType, min = 0, max = 1) {
  return { key, ifcType, dataHash: key, geometryHash: key,
    aabb: { min: [min, 0, 0], max: [max, 1, 1] }, volume: max - min, ref: null };
}

export function unicodeCases(lower, upper) {
  const normalize = value => value.trim().toUpperCase();
  const equal = normalize(lower) === normalize(upper);
  const anchor = normalize(lower) === 'IFCWALL' || normalize(upper) === 'IFCWALL' ? 'IfcDoor' : 'IfcWall';
  const options = { scope: 'both', matchUnpairedByContent: true, detectSuccessors: true };
  const base = [unicodeRow('b', anchor)], head = [unicodeRow('h', upper)];
  const splitHead = [unicodeRow('z', upper, 0, 0.5), unicodeRow('a', upper, 0.5, 1)];
  return [
    { name: 'key model normalization', base: [unicodeRow('same', lower)], head: [],
      options: { excludeTypes: [upper] }, deleted: equal ? 0 : 1 },
    { name: 'key option normalization', base: [unicodeRow('same', upper)], head: [],
      options: { excludeTypes: [lower] }, deleted: equal ? 0 : 1 },
    { name: 'default successor family normalization', base: [unicodeRow('b', lower)], head,
      options, successors: equal ? 1 : 0 },
    { name: 'successor canonical fixed point', base, head,
      options: { ...options, classFamilies: [[lower, anchor]] }, successors: equal ? 1 : 0 },
    { name: 'successor member', base, head,
      options: { ...options, classFamilies: [[anchor, lower]] }, successors: equal ? 1 : 0 },
    { name: 'first family wins', base, head,
      options: { ...options, classFamilies: [['Other', lower], [anchor, upper]] }, successors: equal ? 0 : 1 },
    { name: 'reversed family precedence', base, head,
      options: { ...options, classFamilies: [[anchor, upper], ['Other', lower]] }, successors: 1 },
    { name: 'successor crossClass', base: [unicodeRow('b', lower)], head,
      options: { ...options, classFamilies: [[anchor, lower, upper]] }, successors: 1, crossClass: !equal },
    { name: 'split canonical fixed point', base, head: splitHead,
      options: { ...options, detectSplitMerge: true, classFamilies: [[lower, anchor]] }, splits: equal ? 1 : 0 },
    { name: 'default split family normalization', base: [unicodeRow('b', lower)], head: splitHead,
      options: { ...options, detectSplitMerge: true }, splits: equal ? 1 : 0 },
    { name: 'split crossClass', base: [unicodeRow('b', lower)], head: splitHead,
      options: { ...options, detectSplitMerge: true, classFamilies: [[anchor, lower, upper]] }, splits: 1, crossClass: !equal },
  ];
}
