/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRuleSetFile } from '@ifc-lite/rules';
import { SAMPLE_RULES_PROPOSAL, json } from '@/test/check-authoring-fixture';
import { parseRulesProposal, ruleSetForSave } from './rules-proposal';
import { describeRequirement } from './describe-rule';

const rules = SAMPLE_RULES_PROPOSAL.ruleSet.rules;
const withRules = (next: unknown[]) => json({ ...SAMPLE_RULES_PROPOSAL, ruleSet: { ...SAMPLE_RULES_PROPOSAL.ruleSet, rules: next } });

// #6915: the reviewed rules are exactly the native rule set; nothing the native parser would ignore gets through.
test('rules proposals are native rule sets; ignored or non-native fields are refused with the path', () => {
  const proposal = parseRulesProposal(json(SAMPLE_RULES_PROPOSAL));
  assert.equal(proposal.ruleSet.rules.length, 2);
  assert.equal(describeRequirement(proposal.ruleSet.rules[0].requirement), 'property Pset_WallCommon.FireRating isSet');
  assert.equal(describeRequirement(proposal.ruleSet.rules[1].requirement), 'unique name');
  assert.throws(() => parseRulesProposal(withRules([{ ...rules[0], owner: 'QA' }])), /Unsupported rule field\(s\) ruleSet\.rules\[0\]\.owner/);
  assert.throws(() => parseRulesProposal(withRules([{ ...rules[0], requirement: { kind: 'geometry', clearance: 0.9 } }])), /Native rule set refused it/);
  assert.throws(() => parseRulesProposal(withRules([rules[0], { ...rules[1], id: rules[0].id }])), /Rule ids must be distinct/);
  assert.throws(() => parseRulesProposal(withRules([])), /at least one rule/);
  assert.throws(() => parseRulesProposal(json({ ...SAMPLE_RULES_PROPOSAL, ruleSet: { ...SAMPLE_RULES_PROPOSAL.ruleSet, targets: { modelFingerprints: ['x'] } } })),
    /targets is chosen in the native editor/);
  assert.throws(() => parseRulesProposal(json({ ...SAMPLE_RULES_PROPOSAL, extra: 1 })), /unsupported field\(s\) extra/);
});

test('the saved rule set keeps unsupported requirements and reopens through the native parser', () => {
  const file = ruleSetForSave(parseRulesProposal(json(SAMPLE_RULES_PROPOSAL)));
  const reopened = parseRuleSetFile(JSON.parse(JSON.stringify(file)));
  assert.ok(reopened.ok);
  assert.match(reopened.file.description ?? '', /1\. Walls between flats achieve 53 dB airborne sound insulation \(acoustic performance needs a test certificate; Walls state a fire rating\)/);
  assert.match(reopened.file.rules[0].description ?? '', /53 dB/);
  assert.equal(reopened.file.rules[1].description, undefined);
});
