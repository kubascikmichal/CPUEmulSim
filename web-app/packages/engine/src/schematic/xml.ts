/**
 * Minimal XML DOM for `.schx` files: a parser (enough for any well-formed document the original
 * or a user could produce) and a serializer reproducing JDOM2 `Format.getPrettyFormat()` output
 * (2-space indent, CRLF line separators, trimmed text, `<empty />` elements).
 */

export class XmlElement {
  readonly attributes = new Map<string, string>();
  readonly children: XmlElement[] = [];
  text = '';

  constructor(readonly name: string) {}

  getChild(name: string): XmlElement | null {
    return this.children.find((c) => c.name === name) ?? null;
  }

  getChildren(name: string): XmlElement[] {
    return this.children.filter((c) => c.name === name);
  }

  /** JDOM `getChildText`: text of the child or null if missing. */
  getChildText(name: string): string | null {
    const c = this.getChild(name);
    return c === null ? null : c.text;
  }

  getAttributeValue(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): this {
    this.attributes.set(name, value);
    return this;
  }

  addContent(content: XmlElement | string): this {
    if (typeof content === 'string') this.text += content;
    else this.children.push(content);
    return this;
  }
}

export class XmlParseError extends Error {
  override name = 'JDOMException';
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.substring(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.substring(1), 10));
    if (e in ENTITIES) return ENTITIES[e];
    throw new XmlParseError('Undefined entity ' + m);
  });
}

/** Parses a document and returns its root element. */
export function parseXml(text: string): XmlElement {
  let i = 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  const fail = (msg: string): never => {
    throw new XmlParseError(msg + ' at ' + i);
  };

  if (text.charCodeAt(0) === 0xfeff) i = 1;

  while (i < text.length) {
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i);
      if (end < 0) fail('Unterminated processing instruction');
      i = end + 2;
    } else if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i);
      if (end < 0) fail('Unterminated comment');
      i = end + 3;
    } else if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i);
      if (end < 0) fail('Unterminated CDATA');
      if (stack.length === 0) fail('CDATA outside root');
      stack[stack.length - 1].text += text.substring(i + 9, end);
      i = end + 3;
    } else if (text.startsWith('<!', i)) {
      const end = text.indexOf('>', i);
      if (end < 0) fail('Unterminated declaration');
      i = end + 1;
    } else if (text.startsWith('</', i)) {
      const end = text.indexOf('>', i);
      if (end < 0) fail('Unterminated end tag');
      const name = text.substring(i + 2, end).trim();
      const open = stack.pop();
      if (open === undefined || open.name !== name) fail('Mismatched end tag ' + name);
      i = end + 1;
    } else if (text[i] === '<') {
      const m = /^<([A-Za-z_:][\w:.-]*)/.exec(text.substring(i, i + 256));
      if (m === null) fail('Invalid tag');
      const el = new XmlElement(m![1]);
      i += m![0].length;
      for (;;) {
        while (/\s/.test(text[i] ?? '')) i++;
        if (text.startsWith('/>', i)) {
          i += 2;
          attach(el);
          break;
        }
        if (text[i] === '>') {
          i++;
          attach(el);
          stack.push(el);
          break;
        }
        const am = /^([A-Za-z_:][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/.exec(text.substring(i));
        if (am === null) fail('Invalid attribute');
        if (el.attributes.has(am![1])) fail('Duplicate attribute ' + am![1]);
        el.attributes.set(am![1], decode(normalizeAttr(am![3] ?? am![4])));
        i += am![0].length;
      }
    } else {
      const next = text.indexOf('<', i);
      const end = next < 0 ? text.length : next;
      const chunk = text.substring(i, end);
      if (stack.length > 0) stack[stack.length - 1].text += decode(chunk);
      else if (chunk.trim() !== '') fail('Text outside root');
      i = end;
    }
  }
  if (stack.length > 0) fail('Unclosed element ' + stack[stack.length - 1].name);
  if (root === null) fail('No root element');
  return root!;

  function attach(el: XmlElement): void {
    if (stack.length === 0) {
      if (root !== null) fail('Multiple roots');
      root = el;
    } else {
      stack[stack.length - 1].children.push(el);
    }
  }
}

/** XML attribute value normalisation: literal whitespace chars become spaces. */
function normalizeAttr(s: string): string {
  return s.replace(/[\t\n\r]/g, ' ');
}

const NL = '\r\n';

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r/g, '&#xD;');
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\t/g, '&#x9;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;');
}

/** JDOM2 XMLOutputter with `Format.getPrettyFormat()` (UTF-8). */
export function serializeXml(root: XmlElement): string {
  let out = '<?xml version="1.0" encoding="UTF-8"?>' + NL;
  out += element(root, '');
  return out;

  function element(el: XmlElement, indent: string): string {
    let s = indent + '<' + el.name;
    for (const [k, v] of el.attributes) s += ' ' + k + '="' + escapeAttr(v) + '"';
    const text = el.text.trim();
    if (el.children.length === 0 && text === '') return s + ' />' + NL;
    if (el.children.length === 0) return s + '>' + escapeText(text) + '</' + el.name + '>' + NL;
    s += '>' + NL;
    for (const c of el.children) s += element(c, indent + '  ');
    return s + indent + '</' + el.name + '>' + NL;
  }
}
