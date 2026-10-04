// Quote-aware HTML scanning.
//
// We deliberately do NOT round-trip the templates through a DOM parser.
// Home.dc.html:59-62 relies on there being *no* whitespace between
// inline-block <span> elements — a serializer that re-indents would insert
// text nodes and add word-spacing, changing layout. So every transform here
// is a precise splice into the original source string; anything we don't
// touch survives byte-for-byte.
//
// The scanner must also be quote-aware: Home.dc.html:50 carries a whole
// inline <svg> (with '<', '>' and '/') inside a style="" attribute value.
// A scanner that just hunts for the next '>' would cut the tag in half.

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr'
]);

/**
 * Find the index of the '>' that closes the tag starting at `open`
 * (which must point at the '<'). Skips over quoted attribute values.
 * Returns { end, selfClosing } where `end` is the index AFTER '>'.
 */
export function tagEnd(src, open) {
  let i = open + 1;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '>') {
      const selfClosing = src[i - 1] === '/';
      return { end: i + 1, selfClosing };
    }
    i++;
  }
  throw new Error(`unterminated tag at offset ${open}`);
}

/**
 * Parse a raw attribute string (everything between the tag name and '>').
 * Preserves original case and order. Values are returned raw (still
 * HTML-escaped) because we mostly splice them straight back out.
 */
export function parseAttrs(raw) {
  const attrs = [];
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(raw))) {
    const value = m[2] !== undefined ? m[2]
      : m[3] !== undefined ? m[3]
        : m[4] !== undefined ? m[4]
          : null;
    attrs.push({ name: m[1], value, raw: m[0] });
  }
  return attrs;
}

export function attrMap(raw) {
  const out = Object.create(null);
  for (const a of parseAttrs(raw)) out[a.name] = a.value;
  return out;
}

/**
 * Locate the next element with the given tag name at or after `from`,
 * including its matching close tag (nesting-aware — Home.dc.html nests
 * <sc-for> inside <sc-for>).
 *
 * Returns null when there is no further match, otherwise:
 *   { start, innerStart, innerEnd, end, attrsRaw, selfClosing }
 * where [start,end) spans the whole element and [innerStart,innerEnd)
 * spans its children.
 */
export function matchElement(src, tagName, from = 0) {
  const openRe = new RegExp(`<${tagName}(?=[\\s/>])`, 'gi');
  openRe.lastIndex = from;
  const m = openRe.exec(src);
  if (!m) return null;

  const start = m.index;
  const { end: openEnd, selfClosing } = tagEnd(src, start);
  const attrsRaw = src.slice(start + 1 + tagName.length, openEnd - (selfClosing ? 2 : 1));

  if (selfClosing || VOID_TAGS.has(tagName.toLowerCase())) {
    return { start, innerStart: openEnd, innerEnd: openEnd, end: openEnd, attrsRaw, selfClosing: true };
  }

  // Walk forward counting same-name opens/closes so nested elements pair up.
  let depth = 1;
  let i = openEnd;
  const scanRe = new RegExp(`<(/?)${tagName}(?=[\\s/>])`, 'gi');
  while (depth > 0) {
    scanRe.lastIndex = i;
    const s = scanRe.exec(src);
    if (!s) throw new Error(`unclosed <${tagName}> at offset ${start}`);
    if (s[1] === '/') {
      depth--;
      if (depth === 0) {
        const closeEnd = src.indexOf('>', s.index) + 1;
        return {
          start, innerStart: openEnd, innerEnd: s.index,
          end: closeEnd, attrsRaw, selfClosing: false
        };
      }
      i = src.indexOf('>', s.index) + 1;
    } else {
      const t = tagEnd(src, s.index);
      if (!t.selfClosing) depth++;
      i = t.end;
    }
  }
  return null;
}

/** Replace every element with `tagName` using `fn(match) -> string`. */
export function replaceElements(src, tagName, fn) {
  let out = src;
  let cursor = 0;
  for (;;) {
    const el = matchElement(out, tagName, cursor);
    if (!el) return out;
    const inner = out.slice(el.innerStart, el.innerEnd);
    const replacement = fn({
      attrs: attrMap(el.attrsRaw),
      attrsRaw: el.attrsRaw,
      inner,
      outer: out.slice(el.start, el.end)
    });
    out = out.slice(0, el.start) + replacement + out.slice(el.end);
    cursor = el.start + replacement.length;
  }
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
