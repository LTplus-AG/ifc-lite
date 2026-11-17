/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// Browser acceptance tooling only; never part of the viewer runtime.
export function collectPageErrors(page, report) {
  page.on('pageerror', error => report.errors.push(String(error)));
}

export function createWorkflowVerdict(locale) {
  const expectedChecks = Object.freeze([
    'render-device-health', 'hierarchy-properties', 'measurement', 'section',
    'ids-findings-export', 'narrow-layout', 'locale-settings', 'locale-persistence',
    'locale-english-settings', `locale-${locale}-CH-negotiation`,
  ]);
  function workflowFailed(report) {
    if (report.mode !== 'acceptance' || report.diagnostic || report.fatal
      || !Array.isArray(report.errors) || report.errors.length
      || !Array.isArray(report.checks)) return true;
    const names = report.checks.map(check => check?.name);
    return names.length !== expectedChecks.length
      || new Set(names).size !== expectedChecks.length
      || expectedChecks.some(name => !names.includes(name))
      || report.checks.some(check => check?.status !== 'pass');
  }
  return { expectedChecks, workflowFailed };
}
