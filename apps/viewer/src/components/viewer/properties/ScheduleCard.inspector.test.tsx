/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #8802 R2: the inspector cards share one table system (`inspector-ui.tsx`).
 * The recolour pass took the coloured content frame off every sibling card;
 * the schedule card's tasks render as the same key/value rows, unframed.
 */

import '@/test/setup-dom.js';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, render } from '@/test/render.js';
import { ScheduleCard } from './ScheduleCard.js';

afterEach(cleanup);

function mountCard(): HTMLElement {
  return render(
    <ScheduleCard
      scheduleData={{
        tasks: [{
          expressId: 1, globalId: 'task1', name: 'Foundations', isMilestone: false, predefinedType: 'CONSTRUCTION',
          childGlobalIds: [], productGlobalIds: ['g1'], productExpressIds: [1], controllingScheduleGlobalIds: ['ws1'],
          taskTime: { scheduleStart: '2024-01-01T00:00:00', scheduleFinish: '2024-02-01T00:00:00', completion: 40 },
        }],
        workSchedules: [{ globalId: 'ws1', name: 'Main schedule' }],
        sequences: [],
        hasSchedule: true,
      } as never}
      selectedExpressId={1}
      selectedGlobalId="g1"
      isGenerated={false}
    />,
  );
}

describe('ScheduleCard uses the inspector rows (#8802)', () => {
  it('renders each task field as an inspector key/value row', () => {
    const rows = [...mountCard().querySelectorAll('.inspector-kv')].map((row) => row.firstElementChild?.textContent ?? '');
    assert.deepEqual(rows, ['Start', 'Finish', 'Complete', 'Schedule']);
  });

  it('draws no coloured frame or divider inside the card', () => {
    const coloured = [...mountCard().querySelectorAll('*')]
      .map((el) => el.getAttribute('class') ?? '')
      .filter((cls) => /(?:^|\s)(?:border-t-2|(?:border|divide|bg)-(?:sky|blue|emerald)-)/.test(cls));
    assert.deepEqual(coloured, []);
  });
});
