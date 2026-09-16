/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import '@/test/setup-dom.js';
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Drawing2D } from '@ifc-lite/drawing-2d';
import { cleanup, render } from '@/test/render.js';
import { useViewerStore } from '@/store';
import { useSectionViewpointCapture } from '@/hooks/bcf/useSectionViewpointCapture';
import { BCFTopicDetail } from './BCFTopicDetail.js';
import { BCFViewpointCaptureButtons } from './BCFViewpointCaptureButtons.js';

// #4802: "Capture 2D" was clipped off the default-width sidebar, and its disabled
// reason lived only in a `title` on a pointer-events-none button, so nobody saw it.

const initial = useViewerStore.getState();
beforeEach(() => useViewerStore.setState(initial, true));
afterEach(cleanup);

function capture2DButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('button[aria-label="Capture current 2D section as viewpoint"]');
  assert.ok(button, 'Capture 2D button must render');
  return button;
}

/** The hint a user reads: the rendered line the button is described by. */
function visibleReason(container: HTMLElement): string | null {
  const id = capture2DButton(container).getAttribute('aria-describedby');
  if (!id) return null;
  const hint = [...container.querySelectorAll('p')].find((node) => node.id === id);
  assert.ok(hint, 'aria-describedby must point at a rendered hint line');
  return hint.textContent;
}

function ConnectedButtons(): React.ReactElement {
  const { disabledReason, capture } = useSectionViewpointCapture(async () => null);
  return <BCFViewpointCaptureButtons onCapture3D={() => {}} onCapture2D={() => void capture()} capture2DBlockReason={disabledReason} />;
}

describe('Capture 2D disabled reason (#4802)', () => {
  it('shows the store-derived reason as visible text under the disabled button', () => {
    let container = render(<ConnectedButtons />);
    assert.equal(capture2DButton(container).disabled, true);
    assert.equal(visibleReason(container), 'Open the 2D section panel to capture it.');
    cleanup();

    useViewerStore.setState({ drawing2DPanelVisible: true, drawing2DStatus: 'generating' });
    container = render(<ConnectedButtons />);
    assert.equal(visibleReason(container), 'The 2D section is still generating.');
    cleanup();

    useViewerStore.setState({
      drawing2DPanelVisible: true,
      drawing2DStatus: 'ready',
      drawing2D: {} as Drawing2D,
      textAnnotation2DEditing: 'text-1',
    });
    container = render(<ConnectedButtons />);
    assert.equal(visibleReason(container), 'Finish editing text in the 2D section first.');
    cleanup();

    useViewerStore.setState({
      textAnnotation2DEditing: null,
      sectionPlane: {
        ...useViewerStore.getState().sectionPlane,
        custom: { normal: [1, 0, 0], distance: 0, pickedAt: [0, 0, 0], tangent: [0, 1, 0], bitangent: [0, 0, 1] },
      },
    });
    container = render(<ConnectedButtons />);
    assert.equal(visibleReason(container), 'Custom section planes cannot be captured in 2D yet.');
  });

  it('puts the hover reason on a wrapper, since a disabled button gets no pointer events', () => {
    const container = render(
      <BCFViewpointCaptureButtons onCapture3D={() => {}} onCapture2D={() => {}} capture2DBlockReason="The 2D section is still generating." />,
    );
    const button = capture2DButton(container);
    assert.equal(button.getAttribute('title'), null, 'a title on the disabled button itself never shows');
    assert.equal(button.parentElement?.getAttribute('title'), 'The 2D section is still generating.');
  });

  it('drops the hint and enables the button when capture can run', () => {
    const container = render(<BCFViewpointCaptureButtons onCapture3D={() => {}} onCapture2D={() => {}} capture2DBlockReason={null} />);
    assert.equal(capture2DButton(container).disabled, false);
    assert.equal(visibleReason(container), null);
    assert.equal(container.querySelector('p'), null);
  });
});

describe('Viewpoints header layout (#4802)', () => {
  it('stacks the capture buttons under the label in a wrapping row', () => {
    const container = render(
      <BCFTopicDetail
        topic={{ guid: 't', title: 'Topic', creationDate: '2026-01-01T00:00:00Z', comments: [], viewpoints: [] }}
        onBack={() => {}}
        onEditTopic={() => {}}
        onAddComment={() => {}}
        onAddViewpoint={() => {}}
        onAddSectionViewpoint={() => {}}
        sectionViewpointBlockReason={null}
        onActivateViewpoint={() => {}}
        onDeleteViewpoint={() => {}}
        onUpdateStatus={() => {}}
        onZoomToTopic={() => {}}
        canZoomToTopic={false}
        onDeleteTopic={() => {}}
        selectionCount={0}
        hasIsolation={false}
        hasHiddenEntities={false}
      />,
    );
    const heading = [...container.querySelectorAll('h4')].find((node) => node.textContent === 'Viewpoints');
    assert.ok(heading, 'Viewpoints heading must render');
    // happy-dom cannot measure overflow; assert the structure that prevents it.
    assert.equal(heading.parentElement?.classList.contains('flex'), false, 'label and buttons must not share one no-wrap flex row');
    const row = capture2DButton(container).closest('.flex-wrap');
    assert.ok(row, 'the capture buttons row must wrap');
    assert.equal(row.contains(heading), false, 'the buttons row sits under the label, not beside it');
    assert.ok(row.textContent?.includes('Capture 3D'), 'both capture buttons share the wrapping row');
  });
});
