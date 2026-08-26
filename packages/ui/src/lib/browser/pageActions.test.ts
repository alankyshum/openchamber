import { describe, expect, test } from 'bun:test';

import {
  buildClickScript,
  buildExtractScript,
  buildInspectScript,
  buildScrollScript,
  buildScrollWithinScript,
  buildSnapshotScript,
  buildTypeScript,
} from './pageActions';

/**
 * These scripts are source text evaluated inside another page: nothing
 * type-checks them, and a value interpolated without escaping either breaks the
 * script or runs as code.
 */
const parses = (source: string): boolean => {
  try {
    new Function(source);
    return true;
  } catch {
    return false;
  }
};

describe('page action scripts', () => {
  test('every script parses', () => {
    expect(parses(buildSnapshotScript())).toBe(true);
    expect(parses(buildSnapshotScript({ selector: '#main' }))).toBe(true);
    expect(parses(buildExtractScript({ itemSelector: 'article', fields: [{ name: 'body', from: 'text' }] }))).toBe(true);
    expect(parses(buildClickScript({ selector: '#save' }))).toBe(true);
    expect(parses(buildClickScript({ text: 'Save' }))).toBe(true);
    expect(parses(buildTypeScript({ selector: '#q', value: 'hello', submit: true }))).toBe(true);
    expect(parses(buildInspectScript({ selector: '#save' }))).toBe(true);
    expect(parses(buildScrollScript({ direction: 'bottom' }))).toBe(true);
    expect(parses(buildScrollScript({ selector: 'footer' }))).toBe(true);
    expect(parses(buildScrollWithinScript({ selector: '.feed', direction: 'down' }))).toBe(true);
  });

  test('a hostile selector is embedded as data, not as code', () => {
    const hostile = `'); window.__owned = true; ('`;
    const script = buildClickScript({ selector: hostile });
    expect(parses(script)).toBe(true);
    // Present only inside a quoted literal: that is what makes it inert.
    expect(script).toContain(JSON.stringify(hostile));
  });

  test('a typed value is embedded as data too', () => {
    const value = '"); alert(1); ("';
    const script = buildTypeScript({ selector: '#q', value, submit: false });
    expect(parses(script)).toBe(true);
    expect(script).toContain(JSON.stringify(value));
  });

  test('whitespace regexes survive interpolation', () => {
    // A doubled backslash here would produce a literal backslash-s and match
    // nothing, silently collapsing no whitespace at all.
    expect(buildSnapshotScript()).toContain('replace(/\\s+/g');
  });

  test('scrolling asks for instant behaviour, not the page preference', () => {
    // A page with scroll-behavior: smooth would otherwise still be animating
    // when the position is read.
    expect(buildScrollScript({ direction: 'bottom' })).toContain("behavior: 'instant'");
    expect(buildScrollScript({ selector: 'footer' })).toContain("behavior: 'instant'");
  });

  test('a scoped snapshot reads only the subtree it was given', () => {
    const script = buildSnapshotScript({ selector: '#changelog' });
    expect(script).toContain('"#changelog"');
    expect(script).toContain('root.querySelectorAll');
  });

  test('inner scrolling is bounded and reports growth', () => {
    const script = buildScrollWithinScript({ selector: '.feed', direction: 'down', rounds: 8, settleMs: 100 });
    expect(script).toContain('MAX_SCROLL_ROUNDS');
    expect(script).toContain('heightBefore');
    expect(script).toContain('grew');
    expect(script).toContain("behavior: 'instant'");
  });

  test('extraction is declarative and bounded', () => {
    const script = buildExtractScript({
      selector: '#feed',
      itemSelector: 'article',
      fields: [{ name: 'body', from: 'text', max: 1000 }],
      max: 100,
      includeText: true,
    });
    expect(script).toContain('MAX_TOTAL_CHARS');
    expect(script).toContain('accessibleName');
    expect(script).not.toContain('innerHTML');
    expect(script).not.toContain('outerHTML');
    expect(script).not.toContain('.click(');
    expect(script).not.toContain('dispatchEvent');
  });

  test('read output preserves body text and marks every truncation boundary', () => {
    const snapshot = buildSnapshotScript();
    const extract = buildExtractScript({
      itemSelector: 'article',
      fields: [{ name: 'body', from: 'text', max: 10 }, { name: 'url', from: 'href' }],
      includeText: true,
    });
    expect(snapshot).toContain('var text = body;');
    expect(snapshot).not.toContain('replace(/\\n{3,}/g');
    expect(extract).toContain('truncatedFields');
    expect(extract).toContain('omittedFields');
    expect(extract).toContain('budgetExhausted');
    expect(extract).toContain('textTruncated');
    expect(extract).toContain('var fieldCost =');
    expect(extract).toContain('budget + entryCost + fieldCost');
  });

  test('redacts URL metadata without rewriting ordinary attribute values', () => {
    const script = buildExtractScript({
      itemSelector: 'a',
      fields: [
        { name: 'href', from: 'href' },
        { name: 'data', from: 'attr', attr: 'data-label' },
      ],
    });
    expect(script).toContain('redactUrl');
    expect(script).toContain('return text;');
    expect(script).toContain('ordinary relative URLs');
    expect(script).not.toContain('innerHTML');
    expect(script).not.toContain('document.cookie');
  });
});
