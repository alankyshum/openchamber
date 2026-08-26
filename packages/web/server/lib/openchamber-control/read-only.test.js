import { describe, expect, test } from 'bun:test';
import {
  OPENCHAMBER_BROWSER_MUTATING_ACTIONS,
  OPENCHAMBER_BROWSER_READ_ACTIONS,
} from './actions.js';

describe('read-only browser capability boundary', () => {
  test('the CLI-facing allowlist contains no mutating capability', () => {
    expect(OPENCHAMBER_BROWSER_READ_ACTIONS.filter((action) =>
      OPENCHAMBER_BROWSER_MUTATING_ACTIONS.includes(action))).toEqual([]);
  });

  test('the known mutations are not read actions', () => {
    for (const action of ['browser.click', 'browser.type', 'browser.capture']) {
      expect(OPENCHAMBER_BROWSER_READ_ACTIONS).not.toContain(action);
    }
  });
});
