/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * JUnit XML for a test run (`ifc-lite ids test --junit`), the format CI
 * systems read: one `<testsuite>` per specification, one `<testcase>` per
 * case, with `<failure>`, `<error>` or `<skipped>`.
 */

import type { CaseResult, TestRunReport } from './runner.js';

/** Code points XML 1.0 cannot carry at all (C0 controls except tab/LF/CR, U+FFFE, U+FFFF). */
function xmlChar(c: string): boolean {
  const n = c.charCodeAt(0);
  return (n >= 0x20 || n === 0x09 || n === 0x0a || n === 0x0d) && n !== 0xfffe && n !== 0xffff;
}

function esc(s: string): string {
  return [...s]
    .filter(xmlChar)
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const seconds = (ms: number) => (ms / 1000).toFixed(3);

function testcase(r: CaseResult): string {
  const open = `    <testcase classname="${esc(r.specName)}" name="${esc(r.name)}" time="${seconds(r.durationMs)}"`;
  const message = esc(r.message ?? '');
  switch (r.verdict) {
    case 'passed':
      return `${open}/>`;
    case 'failed':
      return `${open}>\n      <failure message="${message}" type="expectation">${message}</failure>\n    </testcase>`;
    case 'error':
      return `${open}>\n      <error message="${message}"/>\n    </testcase>`;
    case 'skipped':
      return `${open}>\n      <skipped message="${message}"/>\n    </testcase>`;
  }
}

export function junitXml(report: TestRunReport, options: { name?: string } = {}): string {
  const bySpec = new Map<string, CaseResult[]>();
  for (const r of report.results) bySpec.set(r.specId, [...(bySpec.get(r.specId) ?? []), r]);
  const time = report.results.reduce((t, r) => t + r.durationMs, 0);
  const s = report.summary;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${esc(options.name ?? 'IDS tests')}" tests="${s.total}" failures="${s.failed}" errors="${s.error}" skipped="${s.skipped}" time="${seconds(time)}">`,
  ];
  for (const results of bySpec.values()) {
    const n = (v: CaseResult['verdict']) => results.filter((r) => r.verdict === v).length;
    const t = results.reduce((x, r) => x + r.durationMs, 0);
    lines.push(
      `  <testsuite name="${esc(results[0].specName)}" tests="${results.length}" failures="${n('failed')}" errors="${n('error')}" skipped="${n('skipped')}" time="${seconds(t)}">`,
      ...results.map(testcase),
      '  </testsuite>',
    );
  }
  lines.push('</testsuites>', '');
  return lines.join('\n');
}
