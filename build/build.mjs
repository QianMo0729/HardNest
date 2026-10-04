#!/usr/bin/env node
/* Production build: .dc.html editing sources -> static, self-contained dist.
 *
 * Removes from the shipped page: React + ReactDOM (unpkg.com), support.js,
 * image-slot.js, the duplicate fetch(location.href), the per-page
 * dc-import fetches, the productData.js dynamic import, the
 * .image-slots.state.json request, and the Google Fonts stylesheet.
 * The editing sources are untouched.
 */

import { readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync, constants as zc } from 'node:zlib';

import { parseDcDocument, loadComponentClass, createRenderer } from './lib/dc.mjs';
import { matchElement, attrMap } from './lib/html.mjs';
import { buildLogo, buildIcons, extractSlots, slotMarkup, SLOT_CSS, hashName, LOGO_RATIO } from './lib/assets.mjs';
import { buildFonts } from './lib/fonts.mjs';
import { bucketGlyphs } from './lib/glyphs.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = path.join(ROOT, 'Hardnest官网');
const OUT = path.join(ROOT, 'dist');
const ASSETS = path.join(OUT, 'assets');
const RUNTIME = path.join(ROOT, 'build', 'runtime');

const SKIP_FONTS = process.argv.includes('--no-fonts');
const SPRITES = process.argv.includes('--particle-sprites');

const SANS = 'Noto Sans SC';
const SERIF = 'Noto Serif SC';
const SANS_WEIGHTS = [300, 400, 500, 700, 900];
const SERIF_WEIGHTS = [500, 700, 900];

/* Page URL map. Every href in the sources points at *.dc.html; those are
   rewritten once, at the end, so the editing sources keep working as-is. */
const PAGES = [
  { name: 'Home', src: 'Home.dc.html', out: 'index.html', nav: 'home', runtime: 'home.js', title: 'Hardnest · 滚塑一体成型人宠共居家具' },
  { name: 'Products', src: 'Products.dc.html', out: 'products.html', nav: 'products', runtime: 'products.js', title: '产品 · Hardnest' },
  { name: 'BrandStory', src: 'BrandStory.dc.html', out: 'brand-story.html', nav: 'story', runtime: 'story.js', title: '品牌故事 · Hardnest' },
  { name: 'Contact', src: 'Contact.dc.html', out: 'contact.html', nav: 'contact', runtime: 'contact.js', title: '联系我们 · Hardnest' }
];
const URL_MAP = Object.fromEntries(PAGES.map((p) => [p.src, p.out]));

/* Reproduced verbatim from support.js:132 — the pages render with it today. */
const FULL_PAGE_CSS = 'html,body{height:100%;margin:0}#dc-root,#dc-root>.sc-host{height:100%}';

/* The production-relevant half of support.js BASE_CSS (the rest styles
   editor placeholders and error overlays that no longer exist). */
const PRINT_CSS = `@media print{@page{margin:0.5cm}figure,table{break-inside:avoid}
#dc-root,#dc-root>.sc-host{height:auto}
*,*::before,*::after{print-color-adjust:exact;-webkit-print-color-adjust:exact;
backdrop-filter:none !important;-webkit-backdrop-filter:none !important;
animation-delay:-99s !important;animation-duration:.001s !important;
animation-iteration-count:1 !important;animation-fill-mode:both !important;
animation-play-state:running !important;transition-duration:0s !important}}`;

const GENERATED_CSS = `
[data-dc-hidden]{display:none !important}
@media (max-width:860px){.dc-wide{display:none !important}}
@media not all and (max-width:860px){.dc-narrow{display:none !important}}
`.trim();

const warnings = [];
const warn = (m) => { warnings.push(m); };

/* ── style-hover -> real CSS ──────────────────────────────────────────── */
// support.js:1583 wrapped these in !important so they beat the element's own
// inline style attribute. Drop that and every hover state on the site stops
// working while the unhovered rendering still looks perfect.
function importantify(css) {
  return css.split(';').map((d) => {
    const t = d.trim();
    if (!t) return '';
    return /!important\s*$/.test(t) ? t : t + ' !important';
  }).filter(Boolean).join(';');
}

function hoverAllocator() {
  const cache = new Map();
  const rules = [];
  let n = 0;
  const alloc = (css) => {
    if (cache.has(css)) return cache.get(css);
    const cls = 'scp' + (n++).toString(36);
    rules.push(`.${cls}:hover{${importantify(css)}}`);
    cache.set(css, cls);
    return cls;
  };
  alloc.rules = rules;
  return alloc;
}

/* ── source loading ───────────────────────────────────────────────────── */
async function loadComponent(file, name) {
  const raw = await readFile(path.join(SRC, file), 'utf8');
  const doc = parseDcDocument(raw);
  return { name, ...doc, Component: loadComponentClass(doc.script, name) };
}

function helmetParts(helmet) {
  let style = '';
  let cursor = 0;
  for (;;) {
    const s = matchElement(helmet, 'style', cursor);
    if (!s) break;
    style += helmet.slice(s.innerStart, s.innerEnd);
    cursor = s.end;
  }
  return { style: style.trim() };
}

/* ── main ─────────────────────────────────────────────────────────────── */
async function main() {
  const t0 = Date.now();
  await cleanDist();
  await mkdir(ASSETS, { recursive: true });

  /* Product data comes straight from the module the page imports at
     runtime, so editing productData.js still flows through the build. */
  const { products } = await import(
    'file://' + path.join(SRC, 'productData.js').replace(/\\/g, '/')
  );
  const homeProducts = products.map((p, i) => ({
    ...p,
    index: '0' + (i + 1),
    href: `Products.dc.html#${p.id}`,
    imgHint: `拖入产品图：${p.name} · ${p.category}`
  }));

  const nav = await loadComponent('SiteNav.dc.html', 'SiteNav');
  const footer = await loadComponent('SiteFooter.dc.html', 'SiteFooter');

  /* Images. There is no sidecar in the repo yet, so every slot renders as
     an empty frame; the build says so loudly rather than shipping the
     editor's "drop an image here" chrome to production. */
  const slotData = await extractSlots(path.join(SRC, '.image-slots.state.json'), ASSETS);
  if (!slotData.present) {
    warn('.image-slots.state.json is missing — all <image-slot> slots render as empty frames. ' +
      'Drop images in the editor, then rebuild.');
  }

  const logo = await buildLogo(path.join(SRC, 'assets', 'logo-mark-dark.png'), ASSETS);
  const icons = await buildIcons(path.join(SRC, 'assets', 'logo-mark-dark.png'), ASSETS);

  /* Product photo revealed at the end of the BrandStory scene. A plain
     <img> in the template; hashed and rewritten here like the logo. */
  let productImg = null;
  try {
    productImg = await emit('story-reveal-sofa.jpg',
      await readFile(path.join(SRC, 'assets', 'story-reveal-sofa.jpg')));
  } catch {
    warn('assets/story-reveal-sofa.jpg missing — the BrandStory reveal card will 404');
  }

  const pageOutputs = [];
  const glyphBuckets = new Map();

  for (const page of PAGES) {
    const comp = await loadComponent(page.src, page.name);
    const hover = hoverAllocator();
    let eagerSlots = page.name === 'Home' ? 1 : 0; // hero image only

    const components = {
      SiteNav: {
        ...nav,
        props: { active: page.nav },
        groups: {
          nav: {
            keys: ['navBarStyle'],
            states: {
              'false|false': { scrolled: false, hidden: false },
              'true|false': { scrolled: true, hidden: false },
              'false|true': { scrolled: false, hidden: true },
              'true|true': { scrolled: true, hidden: true }
            }
          }
        },
        responsiveIf: { showDesktopNav: 'dc-wide', showMobileToggle: 'dc-narrow' },
        runtimeIf: { mobileOpen: { initial: false } }
      },
      SiteFooter: { ...footer, props: {} },
      [page.name]: {
        ...comp,
        props: {},
        state: page.name === 'Home' ? { products: homeProducts } : {},
        groups: componentGroups(page.name),
        runtimeIf: componentRuntimeIf(page.name)
      }
    };

    const renderer = createRenderer({
      components,
      hover,
      onWarn: warn,
      slot: (attrs, scope) => {
        /* Slot ids can sit inside an <sc-for> loop (Home's product cards use
           id="home-card-{{ item.id }}"). Attribute interpolation happens in a
           later pass, so resolve the id here against the loop scope — the
           sidecar stores the concrete id the editing runtime saw. */
        const id = (attrs.id || '').replace(/\{\{\s*([\w$]+(?:\.[\w$]+)*)\s*\}\}/g, (_, p) => {
          let v = scope;
          for (const k of p.split('.')) { if (v == null) return ''; v = v[k]; }
          return v == null ? '' : String(v);
        });
        const slot = slotData.slots[id];
        const eager = eagerSlots-- > 0;
        return slotMarkup({ ...attrs, id }, slot, { eager, showPlaceholder: false });
      }
    });

    let body = renderer.renderComponent(page.name, components[page.name]);

    /* Scroll progress bar: width -> transform.
       transform-origin is pinned to the left edge and the base width goes
       to 100% so scaleX(f) covers exactly the same pixels width:f*100%
       did. The transition is retargeted to `transform` with the identical
       0.1s linear timing, preserving the smoothing the original had from
       re-triggering a transition on every scroll frame. */
    body = body.replace(
      /(<div id="scroll-progress" style=")([^"]*)(")/,
      (_, a, style, b) => {
        const next = style
          .replace(/width:0%;/, 'width:100%;transform:scaleX(0);transform-origin:0 50%;')
          .replace(/transition:width 0\.1s linear;/, 'transition:transform 0.1s linear;');
        if (next === style) warn('scroll-progress inline style did not match the expected shape');
        return a + next + b;
      }
    );

    /* Logo: 1180x776 -> 170x112, with the layout ratio pinned in CSS so the
       nav/footer flex rows lay out to the same fractional pixel. */
    body = body.replace(
      /<img src="assets\/logo-mark-dark\.png"([^>]*?)style="([^"]*)"([^>]*)>/g,
      (_, pre, style, post) =>
        `<img src="assets/${logo.name}"${pre}width="${logo.width}" height="${logo.height}" decoding="async" ` +
        `style="${style}aspect-ratio:${LOGO_RATIO[0]}/${LOGO_RATIO[1]};"${post}>`
    );

    if (productImg) {
      body = body.replace(
        /src="assets\/story-reveal-sofa\.jpg"/g,
        `src="assets/${productImg}"`
      );
    }

    const { style: pageStyle } = helmetParts(comp.helmet);

    glyphBuckets.set(page.name, bucketGlyphs(body, {
      sansWeights: SANS_WEIGHTS, serifWeights: SERIF_WEIGHTS,
      sansName: SANS, serifName: SERIF
    }));

    pageOutputs.push({ page, body, pageStyle, hoverRules: hover.rules, variants: renderer.styleVariants });
  }

  /* ── fonts ──────────────────────────────────────────────────────────── */
  const merged = new Map();
  for (const buckets of glyphBuckets.values()) {
    for (const [key, set] of buckets) {
      if (!merged.has(key)) merged.set(key, new Set());
      const target = merged.get(key);
      for (const ch of set) target.add(ch);
    }
  }

  let fontCss = '';
  let fontStats = { faces: 0, bytes: 0, files: [] };
  if (SKIP_FONTS) {
    warn('--no-fonts: falling back to the third-party Google Fonts stylesheet. ' +
      'This build is for fast iteration only — do not deploy it.');
  } else {
    const built = await buildFonts(merged, { [SANS]: SANS, [SERIF]: SERIF }, ASSETS);
    fontCss = built.css;
    fontStats = { ...built.stats, files: built.files };
  }
  const fontCssName = fontCss ? await emit('fonts.css', Buffer.from(fontCss, 'utf8')) : null;

  /* ── runtime ────────────────────────────────────────────────────────── */
  const core = await readFile(path.join(RUNTIME, 'core.js'), 'utf8');
  const navJs = await readFile(path.join(RUNTIME, 'nav.js'), 'utf8');
  /* The BrandStory scene is a classic script shared with the editing page;
     inlining it ahead of the page module keeps production dependency-free. */
  const storyScene = await readFile(path.join(SRC, 'story-scene.js'), 'utf8');
  const runtimeNames = {};
  for (const page of PAGES) {
    const mod = await readFile(path.join(RUNTIME, page.runtime), 'utf8');
    const js = [core, navJs, ...(page.name === 'BrandStory' ? [storyScene] : []), mod].join('\n');
    runtimeNames[page.name] = await emit(`app-${page.name.toLowerCase()}.js`, Buffer.from(js, 'utf8'));
  }

  /* ── page emission ──────────────────────────────────────────────────── */
  const report = [];
  for (const { page, body, pageStyle, hoverRules, variants } of pageOutputs) {
    const css = [
      FULL_PAGE_CSS,
      PRINT_CSS,
      pageStyle,
      SLOT_CSS,
      GENERATED_CSS,
      hoverRules.join('\n')
    ].filter(Boolean).join('\n');
    const cssName = await emit(`page-${page.name.toLowerCase()}.css`, Buffer.from(css, 'utf8'));

    const cfg = { progressTransform: true, particleSprites: SPRITES };
    const head = [
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      `<title>${page.title}</title>`,
      `<link rel="icon" type="image/png" sizes="64x64" href="assets/${icons.favicon.name}">`,
      `<link rel="apple-touch-icon" sizes="180x180" href="assets/${icons.apple.name}">`,
      fontCssName
        ? `<link rel="stylesheet" href="assets/${fontCssName}">`
        : '<link rel="preconnect" href="https://fonts.googleapis.com">\n' +
          '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous">\n' +
          '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@300;400;500;700;900&family=Noto+Serif+SC:wght@500;700;900&display=swap">',
      `<link rel="stylesheet" href="assets/${cssName}">`
    ].filter(Boolean).join('\n');

    let html =
      '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n' + head + '\n</head>\n<body>\n' +
      '<div id="dc-root"><div class="sc-host">\n' + body + '\n</div></div>\n' +
      `<script>window.__DCV=${JSON.stringify(variants)};window.__DCCFG=${JSON.stringify(cfg)};</script>\n` +
      `<script src="assets/${runtimeNames[page.name]}" defer></script>\n` +
      '</body>\n</html>\n';

    // Editing-source URLs -> production URLs, preserving ?query and #hash.
    html = html.replace(/(href=")([A-Za-z]+\.dc\.html)([^"]*)(")/g,
      (m, a, file, rest, b) => (URL_MAP[file] ? a + URL_MAP[file] + rest + b : m));

    const left = html.match(/[A-Za-z]+\.dc\.html/g);
    if (left) warn(`${page.out}: unrewritten source links: ${[...new Set(left)].join(', ')}`);

    const buf = Buffer.from(html, 'utf8');
    await writeFile(path.join(OUT, page.out), buf);
    await compress(path.join(OUT, page.out), buf);
    report.push({ file: page.out, bytes: buf.length });
  }

  /* ── report ─────────────────────────────────────────────────────────── */
  const assetFiles = await readdir(ASSETS);
  const totalAssets = (await Promise.all(
    assetFiles.filter((f) => !/\.(br|gz)$/.test(f))
      .map(async (f) => (await readFile(path.join(ASSETS, f))).length)
  )).reduce((a, b) => a + b, 0);

  console.log('\n  Hardnest production build');
  console.log('  ' + '─'.repeat(58));
  for (const r of report) console.log(`  ${r.file.padEnd(20)} ${kb(r.bytes).padStart(10)}`);
  console.log('  ' + '─'.repeat(58));
  console.log(`  logo        ${kb(logo.originalBytes)} -> ${kb(logo.bytes)}  (${logo.natural.join('x')} -> ${logo.width}x${logo.height})`);
  console.log(`  fonts       ${fontStats.faces} faces, ${kb(fontStats.bytes)} across ${fontStats.files.length} files`);
  console.log(`  assets      ${kb(totalAssets)} total`);
  console.log(`  excluded    logo-mark.png (unreferenced), Logo.jpg (unreferenced),`);
  console.log(`              support.js (69 KB), image-slot.js (65 KB), *.dc.html sources`);
  console.log(`  third-party requests removed: unpkg.com x2, fonts.googleapis.com, fonts.gstatic.com`);
  console.log(`  built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  if (warnings.length) {
    console.log('\n  Warnings');
    for (const w of warnings) console.log('   ! ' + w);
  }
  console.log('');
}

function componentGroups(name) {
  if (name === 'Products') {
    const sec = { keys: ['pillYanStyle', 'pillXueStyle', 'pillJieStyle', 'pillWanStyle'], states: {} };
    for (const id of ['p-yan', 'p-xue', 'p-jie', 'p-wan']) sec.states[id] = { activeSection: id };
    const groups = {
      sec,
      /* Sticky filter bar: top 74px while the nav is visible, 0 once the
         nav hides — keeps it glued to the viewport top instead of hanging
         in mid-air. */
      subnav: { keys: ['subnavStyle'], states: { false: { navHidden: false }, true: { navHidden: true } } }
    };
    for (const [key, pid] of [['yan', 'p-yan'], ['xue', 'p-xue'], ['jie', 'p-jie'], ['wan', 'p-wan']]) {
      groups[pid] = {
        keys: [0, 1, 2].map((i) => `${key}Swatch${i}Style`),
        states: { 0: { selected: { [pid]: 0 } }, 1: { selected: { [pid]: 1 } }, 2: { selected: { [pid]: 2 } } }
      };
    }
    return groups;
  }
  if (name === 'Contact') {
    return {
      identity: {
        keys: ['cardCustomerStyle', 'cardDealerStyle', 'cardMediaStyle'],
        states: {
          个人用户: { identity: '个人用户' },
          经销商加盟: { identity: '经销商加盟' },
          媒体合作: { identity: '媒体合作' }
        }
      },
      submit: {
        keys: ['submitStyle'],
        states: { true: { name: 'x', contact: 'x' }, false: { name: '', contact: '' } }
      }
    };
  }
  return {};
}

function componentRuntimeIf(name) {
  if (name === 'Contact') {
    return { submitted: { initial: false }, notSubmitted: { initial: true } };
  }
  return {};
}

/* OneDrive keeps a transient handle on freshly written files, so removing
   the directory itself intermittently fails with EBUSY. Emptying it in
   place, with a couple of retries, is enough and is idempotent. */
async function cleanDist() {
  if (!existsSync(OUT)) return;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      for (const entry of await readdir(OUT, { withFileTypes: true })) {
        await rm(path.join(OUT, entry.name), { recursive: true, force: true });
      }
      return;
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }
}

async function emit(name, buf) {
  const hashed = hashName(buf, name);
  const full = path.join(ASSETS, hashed);
  await writeFile(full, buf);
  await compress(full, buf);
  return hashed;
}

const COMPRESSIBLE = /\.(html|css|js|json|svg|txt|xml)$/;
async function compress(file, buf) {
  if (!COMPRESSIBLE.test(file)) return;
  await writeFile(file + '.br', brotliCompressSync(buf, {
    params: {
      [zc.BROTLI_PARAM_QUALITY]: 11,
      [zc.BROTLI_PARAM_SIZE_HINT]: buf.length
    }
  }));
  await writeFile(file + '.gz', gzipSync(buf, { level: 9 }));
}

const kb = (n) => (n / 1024).toFixed(1) + ' KB';

main().catch((e) => {
  console.error('\n  build failed:', e.message);
  console.error(e.stack);
  process.exit(1);
});
