// DC document parsing + static rendering.
//
// The important design choice: we do not reimplement the pages' style
// functions (linkStyle/pillStyle/swatchStyle/cardStyle/navBarStyle/…).
// We evaluate the page's own `class Component extends DCLogic` in Node and
// call its real `renderVals()`. Every style string in the output is therefore
// produced by the same code React was running, which is what makes the
// "no visual change" claim checkable rather than aspirational.
//
// Interactive styles are precomputed for each declared state and emitted as a
// lookup table; the runtime only swaps between values the page itself
// generated.

import { matchElement, attrMap, replaceElements, decodeEntities, tagEnd } from './html.mjs';

/* ── document parsing ─────────────────────────────────────────────────── */

export function parseDcDocument(src) {
  const dc = matchElement(src, 'x-dc');
  if (!dc) throw new Error('no <x-dc> block');
  let template = src.slice(dc.innerStart, dc.innerEnd);

  let helmet = '';
  const h = matchElement(template, 'helmet');
  if (h) {
    helmet = template.slice(h.innerStart, h.innerEnd);
    template = template.slice(0, h.start) + template.slice(h.end);
  }

  const scriptEl = matchElement(src, 'script');
  let script = '';
  let propsMeta = {};
  let cursor = 0;
  for (;;) {
    const s = matchElement(src, 'script', cursor);
    if (!s) break;
    const a = attrMap(s.attrsRaw);
    if ('data-dc-script' in a) {
      script = src.slice(s.innerStart, s.innerEnd);
      if (a['data-props']) {
        try { propsMeta = JSON.parse(decodeEntities(a['data-props'])); } catch { /* optional */ }
      }
      break;
    }
    cursor = s.end;
  }
  void scriptEl;

  return { helmet: helmet.trim(), template, script, propsMeta };
}

/* ── logic evaluation ─────────────────────────────────────────────────── */

class DCLogicStub {
  constructor(props) { this.props = props || {}; }
  setState() { /* build-time: state is supplied, not mutated */ }
}

export function loadComponentClass(script, name) {
  if (!script || !script.trim()) return null;
  let Component;
  try {
    Component = new Function('DCLogic', `${script}\n;return typeof Component === 'function' ? Component : null;`)(DCLogicStub);
  } catch (e) {
    throw new Error(`${name}: could not evaluate <script data-dc-script>: ${e.message}`);
  }
  return Component;
}

/**
 * Instantiate the page component and call its real renderVals() with a
 * given props/state pair. Returns {} for components with no logic
 * (SiteFooter has an empty script block).
 */
export function renderVals(Component, props = {}, state = {}) {
  if (!Component) return {};
  const inst = new Component(props);
  inst.props = props;
  inst.state = Object.assign({}, inst.state, state);
  if (typeof inst.renderVals !== 'function') return {};
  return inst.renderVals();
}

/* ── expression evaluation ────────────────────────────────────────────── */
// The full expression surface across all five templates is: bare
// identifiers, single dotted paths (item.href), and the literals
// true/false. Anything else is a build error rather than a silent blank.

const EXPR_RE = /\{\{\s*([^}]*?)\s*\}\}/g;

function evalExpr(expr, scope, where) {
  if (expr === 'true') return true;
  if (expr === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(expr)) return Number(expr);
  const path = expr.split('.');
  if (!/^[A-Za-z_$][\w$]*$/.test(path[0])) {
    throw new Error(`${where}: unsupported expression {{ ${expr} }}`);
  }
  let v = scope;
  for (const k of path) {
    if (v == null) return undefined;
    v = v[k];
  }
  return v;
}

function hasExpr(s) { return s != null && /\{\{/.test(s); }

function interpolate(str, scope, where) {
  return str.replace(EXPR_RE, (_, e) => {
    const v = evalExpr(e.trim(), scope, where);
    return v == null ? '' : String(v);
  });
}

/** Returns the single value when the string is exactly one expression. */
function soleExpr(str) {
  const m = /^\s*\{\{\s*([^}]*?)\s*\}\}\s*$/.exec(str);
  return m ? m[1] : null;
}

/* ── template rendering ───────────────────────────────────────────────── */

export function createRenderer(opts) {
  const {
    components,     // name -> { template, Component, props, states, groups }
    hover,          // hover-class allocator
    slot,           // <image-slot> -> html
    onWarn = () => {}
  } = opts;

  const styleVariants = Object.create(null); // key -> { sig -> value }

  function recordVariants(name, comp) {
    const decl = comp.groups || {};
    for (const [group, spec] of Object.entries(decl)) {
      for (const [sig, state] of Object.entries(spec.states)) {
        const vals = renderVals(comp.Component, comp.props, state);
        for (const key of spec.keys) {
          if (!(key in vals)) {
            throw new Error(`${name}: group "${group}" declares key "${key}" but renderVals() did not return it`);
          }
          (styleVariants[key] ||= Object.create(null))[sig] = vals[key];
        }
      }
    }
  }

  function keyGroup(comp, key) {
    for (const [group, spec] of Object.entries(comp.groups || {})) {
      if (spec.keys.includes(key)) return group;
    }
    return null;
  }

  /** Rewrite the attributes of one open tag. */
  function renderAttrs(attrsRaw, scope, comp, where) {
    const out = [];
    const re = /\s+([^\s=/>]+)(?:\s*=\s*"([^"]*)")?/g;
    let m;
    let dynamicKey = null;

    while ((m = re.exec(attrsRaw))) {
      const name = m[1];
      const value = m[2];

      // Editor-only sizing hints never reach production.
      if (name === 'hint-size' || name === 'hint-placeholder-count' || name === 'hint-placeholder-val') continue;

      // style-hover -> a real CSS rule. The generated rule keeps
      // !important because that is how support.js:1583 made these win
      // against the inline style attribute; without it every hover state
      // on the site silently stops working.
      if (name === 'style-hover') {
        out.push({ kind: 'hoverClass', css: interpolate(value || '', scope, where) });
        continue;
      }

      // Event bindings become declarative hooks for the runtime.
      if (/^on[A-Z]/.test(name)) {
        const expr = soleExpr(value || '');
        if (expr) {
          out.push({ kind: 'attr', text: ` data-act="${expr}"` });
          continue;
        }
      }

      if (value !== undefined && hasExpr(value)) {
        const expr = soleExpr(value);
        if (expr) {
          const v = evalExpr(expr, scope, where);

          // Boolean attributes (disabled="{{ submitDisabled }}").
          if (typeof v === 'boolean') {
            if (name === 'disabled' || name === 'checked' || name === 'hidden') {
              if (v) out.push({ kind: 'attr', text: ` ${name}` });
              continue;
            }
          }
          if (typeof v === 'function') continue; // handler in a non-on* slot

          if (name === 'style' && styleVariants[expr]) {
            dynamicKey = expr;
          }
          out.push({ kind: 'attr', text: ` ${name}="${String(v ?? '')}"` });
          continue;
        }
        out.push({ kind: 'attr', text: ` ${name}="${interpolate(value, scope, where)}"` });
        continue;
      }

      out.push({ kind: 'attr', text: m[0] });
    }

    let text = '';
    let hoverCss = null;
    for (const piece of out) {
      if (piece.kind === 'hoverClass') hoverCss = piece.css;
      else text += piece.text;
    }
    if (hoverCss) {
      const cls = hover(hoverCss);
      // Merge into an existing class attribute rather than emitting two.
      if (/\sclass="/.test(text)) {
        text = text.replace(/\sclass="([^"]*)"/, (_, c) => ` class="${c} ${cls}"`);
      } else {
        text += ` class="${cls}"`;
      }
    }
    if (dynamicKey) {
      const g = keyGroup(comp, dynamicKey);
      text += ` data-sk="${dynamicKey}"`;
      if (g) text += ` data-sg="${g}"`;
    }
    return text;
  }

  /**
   * Add attributes to every top-level element in a fragment.
   *
   * `className` must merge into an existing class attribute rather than
   * emitting a second one: the inner render may already have attached a
   * generated hover class, and HTML parsers keep only the first `class`,
   * so a naive prepend silently drops one of the two.
   */
  function markTopLevel(fragment, { attrs = '', className = '' } = {}) {
    let out = '';
    let i = 0;
    while (i < fragment.length) {
      const lt = fragment.indexOf('<', i);
      if (lt === -1) { out += fragment.slice(i); break; }
      if (fragment.startsWith('<!--', lt)) {
        const e = fragment.indexOf('-->', lt) + 3;
        out += fragment.slice(i, e); i = e; continue;
      }
      const nameM = /^<([A-Za-z][\w-]*)/.exec(fragment.slice(lt));
      if (!nameM) { out += fragment.slice(i, lt + 1); i = lt + 1; continue; }

      const el = matchElement(fragment, nameM[1], lt);
      const { end: openEnd } = tagEnd(fragment, lt);
      let open = fragment.slice(lt, openEnd);
      if (className) {
        open = /\sclass="/.test(open)
          ? open.replace(/\sclass="([^"]*)"/, (_, c) => ` class="${c} ${className}"`)
          : open.replace(nameM[0], nameM[0] + ` class="${className}"`);
      }
      if (attrs) open = open.replace(nameM[0], nameM[0] + attrs);

      out += fragment.slice(i, lt) + open + fragment.slice(openEnd, el.end);
      i = el.end;
    }
    return out;
  }

  function render(name, templateSrc, scope, comp) {
    let src = templateSrc;

    // 1. <dc-import> -> the referenced component, rendered inline.
    src = replaceElements(src, 'dc-import', ({ attrs }) => {
      const target = components[attrs.name];
      if (!target) throw new Error(`${name}: <dc-import name="${attrs.name}"> has no component`);
      return renderComponent(attrs.name, target);
    });

    // 2. <sc-for> -> repeated children.
    src = replaceElements(src, 'sc-for', ({ attrs, inner }) => {
      const expr = soleExpr(attrs.list || '');
      const list = expr ? evalExpr(expr, scope, name) : [];
      if (!Array.isArray(list)) {
        onWarn(`${name}: <sc-for list="{{ ${expr} }}"> is not an array — rendering nothing`);
        return '';
      }
      const alias = attrs.as || 'item';
      return list
        .map((entry) => render(name, inner, Object.assign(Object.create(scope), { [alias]: entry }), comp))
        .join('');
    });

    // 3. <sc-if> -> kept, but never dropped when the condition is
    //    runtime-owned. Static-false branches are removed; runtime branches
    //    are emitted with [data-dc-hidden], which the stylesheet hides with
    //    display:none!important. Toggling an *attribute* (not inline style)
    //    is what lets the element return to its authored display:flex /
    //    display:block instead of whatever we last wrote.
    src = replaceElements(src, 'sc-if', ({ attrs, inner }) => {
      const expr = soleExpr(attrs.value || '');
      const rendered = render(name, inner, scope, comp);
      const runtime = (comp.runtimeIf || {})[expr];
      if (runtime) {
        const hidden = runtime.initial === false ? ' data-dc-hidden' : '';
        return markTopLevel(rendered, { attrs: ` data-dc-if="${expr}"${hidden}` });
      }
      const responsive = (comp.responsiveIf || {})[expr];
      if (responsive) return markTopLevel(rendered, { className: responsive });
      const v = expr ? evalExpr(expr, scope, name) : false;
      return v ? rendered : '';
    });

    // 4. <image-slot> -> static markup.
    src = replaceElements(src, 'image-slot', ({ attrs }) => slot(attrs, scope, name));

    // 5. Remaining attributes + text interpolation, tag by tag.
    let out = '';
    let i = 0;
    while (i < src.length) {
      const lt = src.indexOf('<', i);
      if (lt === -1) { out += interpolate(src.slice(i), scope, name); break; }
      out += interpolate(src.slice(i, lt), scope, name);

      if (src.startsWith('<!--', lt)) {
        const e = src.indexOf('-->', lt) + 3;
        out += src.slice(lt, e); i = e; continue;
      }
      const nameM = /^<\/?([A-Za-z][\w-]*)/.exec(src.slice(lt));
      if (!nameM) { out += '<'; i = lt + 1; continue; }
      if (src[lt + 1] === '/') {
        const e = src.indexOf('>', lt) + 1;
        out += src.slice(lt, e); i = e; continue;
      }
      const tag = nameM[1];
      // Quote-aware: Home.dc.html:50 carries an inline <svg> (with '>' and
      // '/') inside a style="" value, so indexOf('>') would cut the tag in
      // half and drop everything after it — including position:absolute.
      const { end: openEnd, selfClosing } = tagEnd(src, lt);
      const rawAttrs = src.slice(lt + 1 + tag.length, openEnd - (selfClosing ? 2 : 1));
      out += `<${tag}` + renderAttrs(rawAttrs, scope, comp, name) + (selfClosing ? ' />' : '>');
      i = openEnd;
    }
    return out;
  }

  function renderComponent(name, comp) {
    recordVariants(name, comp);
    const scope = renderVals(comp.Component, comp.props, comp.state || {});
    return render(name, comp.template, scope, comp);
  }

  return { renderComponent, styleVariants };
}
