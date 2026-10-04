/* Bucket the rendered text by the (family, weight) that will actually
 * render it, so each @font-face carries only the glyphs it needs.
 *
 * Requesting one subset per weight containing every character on the site
 * would ship the H1's 900-weight face all ~600 glyphs when it draws ten.
 * Every style on these pages is an inline `style` attribute, so a simple
 * inheritance walk is enough to attribute each character correctly.
 */

const HEADING_BOLD = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'b', 'strong', 'th']);
const SKIP = new Set(['script', 'style', 'title']);

/** CSS Fonts 4 weight matching, restricted to one family's available set. */
export function matchWeight(desired, available) {
  const list = available.slice().sort((a, b) => a - b);
  if (list.includes(desired)) return desired;
  const below = list.filter((w) => w < desired).sort((a, b) => b - a);
  const above = list.filter((w) => w > desired).sort((a, b) => a - b);
  if (desired >= 400 && desired <= 500) {
    const between = list.filter((w) => w > desired && w <= 500).sort((a, b) => a - b);
    if (between.length) return between[0];
    if (below.length) return below[0];
    return above[0];
  }
  if (desired < 400) return below.length ? below[0] : above[0];
  return above.length ? above[0] : below[0];
}

function readStyle(attrs) {
  const m = /\sstyle="([^"]*)"/i.exec(attrs);
  return m ? m[1] : '';
}

export function bucketGlyphs(html, opts) {
  const { sansWeights, serifWeights, sansName, serifName } = opts;
  const buckets = new Map(); // "family|weight" -> Set<string>
  const stack = [{ family: 'sans', weight: 400, skip: false }];

  const add = (ctx, text) => {
    if (ctx.skip) return;
    const avail = ctx.family === 'serif' ? serifWeights : sansWeights;
    const weight = matchWeight(ctx.weight, avail);
    const name = ctx.family === 'serif' ? serifName : sansName;
    const key = name + '|' + weight;
    let set = buckets.get(key);
    if (!set) { set = new Set(); buckets.set(key, set); }
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp < 0x20) continue;
      set.add(ch);
    }
  };

  const decode = (s) => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) { add(stack[stack.length - 1], decode(html.slice(i))); break; }
    if (lt > i) add(stack[stack.length - 1], decode(html.slice(i, lt)));

    if (html.startsWith('<!--', lt)) { i = html.indexOf('-->', lt) + 3; continue; }

    const closing = html[lt + 1] === '/';
    const nameM = /^<\/?([A-Za-z][\w-]*)/.exec(html.slice(lt));
    if (!nameM) { i = lt + 1; continue; }
    const tag = nameM[1].toLowerCase();

    // Find the tag's '>' while skipping quoted attribute values.
    let j = lt + 1, quote = null, gt = -1;
    while (j < html.length) {
      const c = html[j];
      if (quote) { if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') { gt = j; break; }
      j++;
    }
    if (gt === -1) break;

    if (closing) {
      if (stack.length > 1) stack.pop();
      i = gt + 1;
      continue;
    }

    const attrs = html.slice(lt + 1 + tag.length, gt);
    const selfClosing = html[gt - 1] === '/' ||
      ['img', 'br', 'hr', 'input', 'meta', 'link', 'source'].includes(tag);

    const parent = stack[stack.length - 1];
    const style = readStyle(attrs);
    let family = parent.family;
    let weight = parent.weight;

    if (/font-family\s*:/i.test(style)) {
      if (/Noto\s+Serif\s+SC/i.test(style)) family = 'serif';
      else if (/Noto\s+Sans\s+SC/i.test(style)) family = 'sans';
      else if (/font-family\s*:\s*inherit/i.test(style)) family = parent.family;
    }
    const wm = /font-weight\s*:\s*(\d{3}|bold|normal)/i.exec(style);
    if (wm) {
      weight = wm[1] === 'bold' ? 700 : wm[1] === 'normal' ? 400 : parseInt(wm[1], 10);
    } else if (HEADING_BOLD.has(tag)) {
      weight = 700;
    }

    const ctx = { family, weight, skip: parent.skip || SKIP.has(tag) };

    // Attribute-sourced text that still renders: placeholders and values.
    for (const re of [/\splaceholder="([^"]*)"/i, /\svalue="([^"]*)"/i, /\salt="([^"]*)"/i]) {
      const am = re.exec(attrs);
      if (am && am[1]) add(ctx, decode(am[1]));
    }

    if (!selfClosing) stack.push(ctx);
    i = gt + 1;
  }

  return buckets;
}
