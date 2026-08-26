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

type DomNode = {
  tagName: string;
  id: string;
  className: string;
  nodeType: number;
  parentElement: DomNode | null;
  children: DomNode[];
  innerText: string;
  textContent: string;
  matches: (selector: string) => boolean;
  querySelector: (selector: string) => DomNode | null;
  querySelectorAll: (selector: string) => DomNode[];
  getAttribute: (name: string) => string | null;
  getBoundingClientRect: () => { x: number; y: number; width: number; height: number; top: number; bottom: number };
  attributes?: Record<string, string>;
};

const createDom = (root: DomNode, attributes: Record<string, string>): DomNode => {
  const descendants = (node: DomNode): DomNode[] => node.children.flatMap((child) => [child, ...descendants(child)]);
  const matches = (node: DomNode, selector: string): boolean => {
    const attribute = selector.match(/^([a-z0-9-]*)?\[([\w-]+)(?:=["']?([^\]"']+)["']?)?\]$/i);
    if (attribute) {
      const [, tag, name, value] = attribute;
      return (!tag || node.tagName.toLowerCase() === tag.toLowerCase())
        && node.getAttribute(name) !== null
        && (value === undefined || node.getAttribute(name) === value);
    }
    if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
    if (selector.startsWith('#')) return node.id === selector.slice(1);
    return node.tagName.toLowerCase() === selector.toLowerCase();
  };
  const wire = (node: DomNode): void => {
    node.matches = (selector) => matches(node, selector);
    node.querySelectorAll = (selector) => {
      if (selector === '[') throw new SyntaxError('Invalid selector');
      return descendants(node).filter((candidate) => matches(candidate, selector));
    };
    node.querySelector = (selector) => node.querySelectorAll(selector)[0] ?? null;
    node.getAttribute = (name) => attributesFor(node)[name] ?? null;
    node.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 20, top: 0, bottom: 20 });
    node.children.forEach(wire);
  };
  const attributesFor = (node: DomNode): Record<string, string> => node === root ? attributes : node.attributes ?? {};
  wire(root);
  return root;
};

const node = (tagName: string, attributes: Record<string, string> = {}, children: DomNode[] = [], text = ''): DomNode => {
  const result = {
    tagName,
    id: attributes.id ?? '',
    className: attributes.class ?? '',
    nodeType: 1,
    parentElement: null,
    children,
    innerText: text,
    textContent: text,
    matches: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    getAttribute: () => null,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 20, top: 0, bottom: 20 }),
    attributes,
  };
  children.forEach((child) => { child.parentElement = result; });
  return result;
};

const runExtractInDom = (script: string, document: DomNode & { body: DomNode; documentElement: DomNode; title: string; querySelector: DomNode['querySelector']; querySelectorAll: DomNode['querySelectorAll'] }) => {
  const window = { innerHeight: 800, innerWidth: 1280, scrollY: 0, getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }) };
  const location = { href: 'https://example.test/feed?access_token=secret#latest' };
  const CSS = { escape: (value: string) => value };
  // SAFETY: The generated extract script is evaluated with this fixture and returns the public extract envelope.
  return new Function('document', 'window', 'location', 'CSS', 'URL', `return ${script}`)(document, window, location, CSS, URL) as {
    ok: boolean;
    items: Array<{ values: Record<string, string | boolean | null | Array<string | boolean | null | { iso: string | null; label: string }>>; truncatedFields?: string[] }>;
    fieldValuesTruncated?: boolean;
    fieldsTruncated?: boolean;
    itemsTruncated?: boolean;
  };
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
    expect(extract).toContain('MAX_FIELD_VALUES');
    expect(extract).toContain('fieldValuesTruncated');
    expect(extract).toContain('entry.iso');
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

  test('executes multiple extraction against an in-memory DOM contract fixture', () => {
    const links = Array.from({ length: 102 }, (_, index) => node('a', index === 1 ? {} : {
      href: index === 0 ? '/post?access_token=secret' : `/post/${index}`,
    }, [], index === 1 ? 'Unreadable link' : `Link ${index}`));
    const times = [
      node('time', { datetime: '2026-08-26T12:00:00Z' }, [], 'noon'),
      node('time', { datetime: '2026-08-27T09:30:00Z' }, [], 'tomorrow'),
    ];
    const toggles = [
      node('button', { 'aria-pressed': 'true' }, [], 'Liked'),
      node('button', { 'aria-pressed': 'false' }, [], 'Not liked'),
      node('button', { 'aria-pressed': 'mixed' }, [], 'Unknown'),
    ];
    const article = node('article', { 'data-testid': 'post' }, [
      node('h2', {}, [], 'A long title that must be truncated'),
      ...links,
      ...times,
      ...toggles,
    ], 'A long article body');
    const documentRoot = createDom(node('html', {}, [node('body', {}, [article])]), {});
    const document = Object.assign(documentRoot, {
      body: documentRoot.children[0],
      documentElement: documentRoot,
      title: 'Feed',
    });
    const result = runExtractInDom(buildExtractScript({
      itemSelector: 'article',
      fields: [
        { name: 'links', from: 'href', selector: 'a[href]', multiple: true },
        { name: 'times', from: 'datetime', selector: 'time[datetime]', multiple: true },
        { name: 'toggles', from: 'ariaPressed', selector: '[aria-pressed]', multiple: true },
        { name: 'invalid', from: 'text', selector: '[', multiple: true },
        { name: 'invalidSingle', from: 'text', selector: '[' },
        { name: 'title', from: 'text', selector: 'h2', max: 5 },
      ],
      includeText: true,
    }), document);

    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.values.links).toEqual([
      'https://example.test/post?access_token=%5BREDACTED%5D',
      ...Array.from({ length: 99 }, (_, index) => `https://example.test/post/${index + 2}`),
    ]);
    expect(result.items[0]?.values.times).toEqual([
      { iso: '2026-08-26T12:00:00Z', label: 'noon' },
      { iso: '2026-08-27T09:30:00Z', label: 'tomorrow' },
    ]);
    expect(result.items[0]?.values.toggles).toEqual([true, false]);
    expect(result.items[0]?.values.invalid).toEqual([]);
    expect(result.items[0]?.values.invalidSingle).toBe('');
    expect(result.items[0]?.values.title).toBe('A lon');
    expect(result.items[0]?.truncatedFields).toEqual(['links', 'title']);
    expect(result.fieldValuesTruncated).toBe(true);
    expect(result.fieldsTruncated).toBe(true);
    expect('itemsTruncated' in result).toBe(false);
  });
});
