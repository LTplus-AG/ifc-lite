/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #2934 follow-up: INIT's `config` payload (the published `EmbedConfig` type)
 * only ever applied `.theme`. `applyInitConfig` is the fix, tested here in
 * isolation from the postMessage plumbing handler.test.ts already covers.
 */

import { describe, expect, it, vi } from 'vitest';
import { applyInitConfig } from './initConfig.js';

function makeActuators() {
  return {
    setTheme: vi.fn(),
    setInteractionMode: vi.fn(),
    setBackgroundColor: vi.fn(),
    setOverlays: vi.fn(),
  };
}

describe('applyInitConfig', () => {
  it('does nothing when config is undefined', () => {
    const actuators = makeActuators();
    applyInitConfig(undefined, actuators);
    expect(actuators.setTheme).not.toHaveBeenCalled();
    expect(actuators.setInteractionMode).not.toHaveBeenCalled();
    expect(actuators.setBackgroundColor).not.toHaveBeenCalled();
    expect(actuators.setOverlays).not.toHaveBeenCalled();
  });

  it('does nothing when config is an empty object', () => {
    const actuators = makeActuators();
    applyInitConfig({}, actuators);
    expect(actuators.setTheme).not.toHaveBeenCalled();
    expect(actuators.setInteractionMode).not.toHaveBeenCalled();
    expect(actuators.setBackgroundColor).not.toHaveBeenCalled();
    expect(actuators.setOverlays).not.toHaveBeenCalled();
  });

  it('applies theme via setTheme', () => {
    const actuators = makeActuators();
    applyInitConfig({ theme: 'dark' }, actuators);
    expect(actuators.setTheme).toHaveBeenCalledWith('dark');
  });

  it('applies bg via setBackgroundColor, the same actuator SET_THEME uses', () => {
    const actuators = makeActuators();
    applyInitConfig({ bg: '00ff00' }, actuators);
    expect(actuators.setBackgroundColor).toHaveBeenCalledWith('00ff00');
  });

  it('applies controls via setInteractionMode, the same actuator ?controls= uses', () => {
    const actuators = makeActuators();
    applyInitConfig({ controls: 'orbit' }, actuators);
    expect(actuators.setInteractionMode).toHaveBeenCalledWith('orbit');
  });

  it('merges hideAxis/hideScale/hideTypes into one setOverlays call', () => {
    const actuators = makeActuators();
    applyInitConfig({ hideAxis: true, hideScale: false, hideTypes: ['IfcSpace', 'IfcOpeningElement'] }, actuators);
    expect(actuators.setOverlays).toHaveBeenCalledTimes(1);
    expect(actuators.setOverlays).toHaveBeenCalledWith({
      hideAxis: true,
      hideScale: false,
      hideTypes: ['IfcSpace', 'IfcOpeningElement'],
    });
  });

  it('calls setOverlays when only ONE of the three overlay fields is present', () => {
    const actuators = makeActuators();
    applyInitConfig({ hideAxis: true }, actuators);
    expect(actuators.setOverlays).toHaveBeenCalledWith({ hideAxis: true, hideScale: undefined, hideTypes: undefined });
  });

  it('applies every field of a fully-populated config in one call', () => {
    const actuators = makeActuators();
    applyInitConfig(
      { theme: 'light', bg: '112233', controls: 'none', hideAxis: true, hideScale: true, hideTypes: ['IfcWall'] },
      actuators,
    );
    expect(actuators.setTheme).toHaveBeenCalledWith('light');
    expect(actuators.setBackgroundColor).toHaveBeenCalledWith('112233');
    expect(actuators.setInteractionMode).toHaveBeenCalledWith('none');
    expect(actuators.setOverlays).toHaveBeenCalledWith({ hideAxis: true, hideScale: true, hideTypes: ['IfcWall'] });
  });
});
