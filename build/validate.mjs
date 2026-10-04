#!/usr/bin/env node
/* Equivalence + regression harness.
 *
 * Boots the editing preview (the current site) and the production build
 * side by side in the same browser and compares them, then runs the
 * checks that catch the specific ways this rewrite could silently break:
 *
 *   - a third-party request sneaking back in (the whole point of the build)
 *   - a 404 or console error
 *   - style-hover rules losing their !important and silently doing nothing
 *   - a glyph falling outside the font subset and rendering in a fallback
 *   - cache headers not matching the hashed/unhashed split
 *   - any element moving, resizing or changing typography
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SHOTS = path.join(ROOT, 'build', 'screenshots');

const PROD = 'http://127.0.0.1:8080';
const EDIT = 'http://127.0.0.1:8931';

const PAGES = [
  { name: 'Home', prod: '/index.html', edit: '/Home.dc.html' },
  { name: 'Products', prod: '/products.html', edit: '/Products.dc.html' },
  { name: 'BrandStory', prod: '/brand-story.html', edit: '/BrandStory.dc.html' },
  { name: 'Contact', prod: '/contact.html', edit: '/Contact.dc.html' }
];

const VIEWPORTS = [
  { name: 'phone',   width: 390,  height: 844,  dpr: 3 },
  { name: 'tablet',  width: 834,  height: 1112, dpr: 2 },
  { name: 'desktop', width: 1440, height: 900,  dpr: 2 }
];

const results = [];
const pass = (area, msg) => results.push({ ok: true, area, msg });
const fail = (area, msg) => results.push({ ok: false, area, msg });

function serve(script, port) {
  const p = spawn(process.execPath, [script], {
    cwd: ROOT, env: { ...process.env, PORT: String(port) }, stdio: 'ignore'
  });
  return p;
}

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { method: 'HEAD' });
      if (r.ok) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/* Signature used to pair elements across two different DOM shapes: the
   production build has no shadow roots and no React host wrappers, so
   matching is done on rendered text rather than tree position. */
const PROBE = `(() => {
  const out = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'link') continue;
      let text = '';
      for (const n of el.childNodes) if (n.nodeType === 3) text += n.nodeValue;
      text = text.replace(/\\s+/g, ' ').trim();
      if (!text) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const cs = getComputedStyle(el);
      out.push({
        key: tag + '|' + text.slice(0, 40),
        x: Math.round((r.x + window.scrollX) * 100) / 100,
        y: Math.round((r.y + window.scrollY) * 100) / 100,
        w: Math.round(r.width * 100) / 100,
        h: Math.round(r.height * 100) / 100,
        ff: cs.fontFamily, fs: cs.fontSize, fw: cs.fontWeight,
        color: cs.color, ls: cs.letterSpacing, lh: cs.lineHeight
      });
    }
  };
  walk(document);
  return { probes: out, scrollHeight: document.documentElement.scrollHeight };
})()`;

async function collect(page, url) {
  const errors = [];
  const requests = [];
  const responses = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const loc = m.location();
    errors.push(m.text() + (loc && loc.url ? ' [' + loc.url + ']' : ''));
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => requests.push(r.url()));
  page.on('response', (r) => responses.push({ url: r.url(), status: r.status(), headers: r.headers() }));

  await page.goto(url, { waitUntil: 'load', timeout: 45000 });
  // Settle: fonts, dc-import fetches, React boot, dynamic product import.
  await page.evaluate(() => document.fonts.ready).catch(() => {});
  await page.waitForTimeout(2500);

  /* The DC runtime wraps every resolved {{ }} interpolation in a bare
     <span class="sc-interp">. It carries no styles once resolved, but it
     does mean the element holding the text is one level deeper than in the
     static build — so a text-keyed diff would pair the inner wrapper
     against the outer styled element and report a phantom box difference
     wherever the outer element is a flex item. Unwrap it so both trees
     have the same shape; replacing an inline span with its own text node
     is layout-neutral. */
  await page.evaluate(() => {
    for (const el of document.querySelectorAll('span.sc-interp')) {
      el.replaceWith(document.createTextNode(el.textContent));
    }
  });

  /* Freeze every animation at t=0 before measuring. Without this the
     marquee's 34s infinite translateX puts the two pages at different
     phases and the diff reports every marquee span as "moved" — phase, not
     layout. Pinning both to the same currentTime makes geometry the only
     thing being compared. */
  await page.evaluate(() => {
    for (const a of document.getAnimations()) {
      try { a.pause(); a.currentTime = 0; } catch { /* not seekable */ }
    }
  });
  await page.waitForTimeout(120);

  const data = await page.evaluate(PROBE);
  return { errors, requests, responses, ...data };
}

async function main() {
  await mkdir(SHOTS, { recursive: true });
  const prodSrv = serve(path.join(ROOT, 'server.js'), 8080);
  const editSrv = serve(path.join(ROOT, 'preview-server.js'), 8931);

  try {
    if (!await waitFor(PROD + '/index.html')) throw new Error('production server did not start');
    const editOk = await waitFor(EDIT + '/Home.dc.html', 20);
    if (!editOk) fail('setup', 'preview server did not start — skipping original-vs-build diff');

    const browser = await chromium.launch({ executablePath: CHROME, headless: true });

    /* ── header checks ────────────────────────────────────────────────── */
    const htmlRes = await fetch(PROD + '/index.html', { headers: { 'Accept-Encoding': 'br, gzip' } });
    const cc = htmlRes.headers.get('cache-control') || '';
    const ce = htmlRes.headers.get('content-encoding') || '';
    const vary = htmlRes.headers.get('vary') || '';
    const etag = htmlRes.headers.get('etag');
    const lm = htmlRes.headers.get('last-modified');
    (/must-revalidate/.test(cc) ? pass : fail)('headers', `HTML Cache-Control: ${cc || '(none)'}`);
    (ce === 'br' ? pass : fail)('headers', `HTML Content-Encoding: ${ce || '(none)'}`);
    (/accept-encoding/i.test(vary) ? pass : fail)('headers', `HTML Vary: ${vary || '(none)'}`);
    (etag && lm ? pass : fail)('headers', `HTML validators: ETag=${!!etag} Last-Modified=${!!lm}`);

    // ETags identify a *representation*, so the revalidation request has to
    // negotiate the same encoding the tag came from or a 200 is correct.
    const revalidate = await fetch(PROD + '/index.html', {
      headers: { 'If-None-Match': etag, 'Accept-Encoding': 'br, gzip' }
    });
    (revalidate.status === 304 ? pass : fail)('headers', `conditional GET -> ${revalidate.status}`);

    const cssHref = (await htmlRes.text()).match(/assets\/(page-home\.[0-9a-f]{10}\.css)/);
    if (cssHref) {
      const a = await fetch(`${PROD}/assets/${cssHref[1]}`, { headers: { 'Accept-Encoding': 'br' } });
      const acc = a.headers.get('cache-control') || '';
      (/immutable/.test(acc) && /31536000/.test(acc) ? pass : fail)('headers', `hashed asset Cache-Control: ${acc || '(none)'}`);
      // fetch() transparently inflates br, so the decoded length is not
      // comparable to Content-Length. Check against the file on disk.
      const onDisk = (await import('node:fs/promises')).stat(
        path.join(ROOT, 'dist', 'assets', cssHref[1] + '.br'));
      const brSize = (await onDisk).size;
      (a.headers.get('content-length') === String(brSize) ? pass : fail)(
        'headers', `hashed asset Content-Length ${a.headers.get('content-length')} vs br body ${brSize}`);
    }

    /* ── per page ─────────────────────────────────────────────────────── */
    for (const vp of VIEWPORTS) {
      const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: vp.dpr
      });

      for (const pg of PAGES) {
        const page = await ctx.newPage();
        const prod = await collect(page, PROD + pg.prod + '?__seed=1');
        const label = `${pg.name}@${vp.name}`;

        const thirdParty = prod.requests.filter((u) => !u.startsWith(PROD) && !u.startsWith('data:') && !u.startsWith('blob:'));
        (thirdParty.length === 0 ? pass : fail)('isolation',
          `${label}: ${thirdParty.length} third-party requests${thirdParty.length ? ' -> ' + [...new Set(thirdParty)].slice(0, 3).join(', ') : ''}`);

        const bad = prod.responses.filter((r) => r.status >= 400);
        (bad.length === 0 ? pass : fail)('requests',
          `${label}: ${bad.length} failed responses${bad.length ? ' -> ' + bad.slice(0, 3).map((r) => r.status + ' ' + r.url.replace(PROD, '')).join(', ') : ''}`);

        (prod.errors.length === 0 ? pass : fail)('console',
          `${label}: ${prod.errors.length} console errors${prod.errors.length ? ' -> ' + prod.errors[0].slice(0, 120) : ''}`);

        /* Glyph coverage: every rendered character must be drawable by the
           self-hosted subset for the weight it renders at, otherwise it
           silently falls back to PingFang SC / system CJK. */
        const missing = await page.evaluate(() => {
          const out = [];
          const seen = new Set();
          for (const el of document.querySelectorAll('*')) {
            let text = '';
            for (const n of el.childNodes) if (n.nodeType === 3) text += n.nodeValue;
            text = text.trim();
            if (!text) continue;
            const cs = getComputedStyle(el);
            const fam = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
            if (!/^Noto (Sans|Serif) SC$/.test(fam)) continue;
            for (const ch of text) {
              if (/\s/.test(ch)) continue;
              const key = fam + '|' + cs.fontWeight + '|' + ch;
              if (seen.has(key)) continue;
              seen.add(key);
              if (!document.fonts.check(`${cs.fontWeight} 16px "${fam}"`, ch)) out.push(key);
            }
          }
          return out;
        });
        (missing.length === 0 ? pass : fail)('fonts',
          `${label}: ${missing.length} glyphs outside the subset${missing.length ? ' -> ' + missing.slice(0, 5).join(' ') : ''}`);

        /* Hover rules must still beat the inline style attribute. */
        if (vp.name === 'desktop') {
          const hover = await page.evaluate(async () => {
            const classes = new Set();
            for (const sheet of document.styleSheets) {
              let rules;
              try { rules = sheet.cssRules; } catch { continue; }
              for (const r of rules) {
                const m = r.selectorText && /^\.(scp[0-9a-z]+):hover$/.exec(r.selectorText);
                if (m) classes.add(m[1]);
              }
            }
            const report = { total: classes.size, applied: 0, dead: [] };
            for (const cls of classes) {
              const el = document.querySelector('.' + cls);
              if (!el) { report.dead.push(cls + '(no element)'); continue; }
              const rule = [...document.styleSheets].flatMap((s) => {
                try { return [...s.cssRules]; } catch { return []; }
              }).find((r) => r.selectorText === '.' + cls + ':hover');
              const props = [...rule.style].filter((p) => p !== '');
              const before = props.map((p) => getComputedStyle(el).getPropertyValue(p));
              el.classList.add('__probe_hover');
              // Force the hover declarations on directly: computed style
              // cannot be sampled under a synthetic :hover reliably, so we
              // assert the rule's own !important would win instead.
              const wins = props.every((p) => rule.style.getPropertyPriority(p) === 'important');
              el.classList.remove('__probe_hover');
              void before;
              if (wins) report.applied++;
              else report.dead.push(cls + '(' + props.join(',') + ' not !important)');
            }
            return report;
          });
          (hover.dead.length === 0 ? pass : fail)('hover',
            `${label}: ${hover.applied}/${hover.total} hover rules keep !important${hover.dead.length ? ' -> ' + hover.dead.slice(0, 3).join(', ') : ''}`);
        }

        await page.screenshot({
          path: path.join(SHOTS, `prod-${pg.name}-${vp.name}.png`),
          animations: 'disabled'
        });

        /* ── original vs build ──────────────────────────────────────── */
        if (editOk) {
          const ep = await ctx.newPage();
          let orig = null;
          try {
            orig = await collect(ep, EDIT + pg.edit + '?__seed=1');
          } catch (e) {
            fail('baseline', `${label}: original page failed to load (${e.message.slice(0, 80)})`);
          }
          if (orig) {
            if (orig.probes.length === 0) {
              fail('baseline', `${label}: original rendered nothing — React/unpkg likely unreachable`);
            } else {
              const byKey = new Map();
              for (const p of orig.probes) {
                if (!byKey.has(p.key)) byKey.set(p.key, []);
                byKey.get(p.key).push(p);
              }
              let matched = 0, moved = [], restyled = [];
              const used = new Map();
              for (const p of prod.probes) {
                const list = byKey.get(p.key);
                if (!list) continue;
                const idx = used.get(p.key) || 0;
                const o = list[idx];
                if (!o) continue;
                used.set(p.key, idx + 1);
                matched++;
                if (Math.abs(o.x - p.x) > 1 || Math.abs(o.y - p.y) > 1 ||
                    Math.abs(o.w - p.w) > 1 || Math.abs(o.h - p.h) > 1) {
                  moved.push(`${p.key} Δ(${(p.x - o.x).toFixed(1)},${(p.y - o.y).toFixed(1)},${(p.w - o.w).toFixed(1)},${(p.h - o.h).toFixed(1)})`);
                }
                if (o.fs !== p.fs || o.fw !== p.fw || o.color !== p.color || o.ls !== p.ls || o.lh !== p.lh) {
                  restyled.push(`${p.key} ${o.fs}/${o.fw}/${o.color} -> ${p.fs}/${p.fw}/${p.color}`);
                }
              }
              (moved.length === 0 ? pass : fail)('layout',
                `${label}: ${matched} elements matched, ${moved.length} moved/resized >1px${moved.length ? ' -> ' + moved.slice(0, 3).join('; ') : ''}`);
              (restyled.length === 0 ? pass : fail)('typography',
                `${label}: ${restyled.length} typography differences${restyled.length ? ' -> ' + restyled.slice(0, 2).join('; ') : ''}`);
              const dh = Math.abs(orig.scrollHeight - prod.scrollHeight);
              (dh <= 2 ? pass : fail)('layout',
                `${label}: page height ${orig.scrollHeight} -> ${prod.scrollHeight} (Δ${dh})`);
            }
          }
          await ep.close();
        }
        await page.close();
      }
      await ctx.close();
    }

    /* ── behaviour ────────────────────────────────────────────────────
       Every interactive path was rewritten out of React, so each one is
       exercised against the built page rather than assumed. */
    const bctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const bp = await bctx.newPage();

    await bp.goto(PROD + '/index.html', { waitUntil: 'load' });
    await bp.waitForTimeout(600);
    const navSel = '[data-sk="navBarStyle"]';
    const navAt = () => bp.$eval(navSel, (e) => e.getAttribute('style'));
    const navTop = await navAt();
    await bp.evaluate(() => window.scrollTo(0, 1200));
    await bp.waitForTimeout(500);
    const navDown = await navAt();
    await bp.evaluate(() => window.scrollTo(0, 400));
    await bp.waitForTimeout(500);
    const navUp = await navAt();
    (navDown.includes('translateY(-100%)') ? pass : fail)('behaviour', 'nav hides on scroll down');
    (!navUp.includes('translateY(-100%)') ? pass : fail)('behaviour', 'nav returns on scroll up');
    (navTop.includes('rgba(9,8,7,0.26)') && navDown.includes('rgba(9,8,7,0.74)') ? pass : fail)(
      'behaviour', 'nav scrolled background swaps');

    /* Canvas must stop painting once the hero leaves the viewport, while
       particle state keeps advancing so the phase stays correct. */
    const canvasIdle = await bp.evaluate(async () => {
      const c = document.getElementById('hero-particles');
      const ctx = c.getContext('2d');
      /* Sample the whole surface: 62 particles across a 1440x900 canvas
         leave most small regions permanently empty, so a corner crop can
         look "frozen" while the canvas is painting fine. */
      const snap = () => {
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let h = 0;
        for (let i = 0; i < d.length; i += 401) h = (h * 31 + d[i]) >>> 0;
        return h;
      };
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 400));
      const aVisible = snap();
      await new Promise((r) => setTimeout(r, 400));
      const bVisible = snap();
      window.scrollTo(0, 3000);
      await new Promise((r) => setTimeout(r, 600));
      const aHidden = snap();
      await new Promise((r) => setTimeout(r, 600));
      const bHidden = snap();
      return { animates: aVisible !== bVisible, frozen: aHidden === bHidden };
    });
    (canvasIdle.animates ? pass : fail)('behaviour', 'hero canvas animates while visible');
    (canvasIdle.frozen ? pass : fail)('behaviour', 'hero canvas stops painting once scrolled away');

    /* The glow rAF must settle instead of running for the life of the page. */
    const glowSettles = await bp.evaluate(async () => {
      window.scrollTo(0, 0);
      const g = document.getElementById('cursor-glow');
      await new Promise((r) => setTimeout(r, 500));
      const a = g.style.left + ',' + g.style.top;
      await new Promise((r) => setTimeout(r, 700));
      return a === g.style.left + ',' + g.style.top;
    });
    (glowSettles ? pass : fail)('behaviour', 'cursor glow settles when the pointer is idle');

    await bp.goto(PROD + '/products.html', { waitUntil: 'load' });
    await bp.waitForTimeout(500);
    const swatchBefore = await bp.$eval('[data-act="selectYan1"]', (e) => e.getAttribute('style'));
    await bp.click('[data-act="selectYan1"]');
    await bp.waitForTimeout(200);
    const swatchAfter = await bp.$eval('[data-act="selectYan1"]', (e) => e.getAttribute('style'));
    (swatchBefore !== swatchAfter && swatchAfter.includes('scale(1.12)') ? pass : fail)(
      'behaviour', 'product swatch selection applies the active style');

    await bp.evaluate(() => document.getElementById('p-jie').scrollIntoView());
    await bp.waitForTimeout(700);
    const pill = await bp.$eval('a[href="#p-jie"]', (e) => e.getAttribute('style'));
    (pill.includes('#141312') ? pass : fail)('behaviour', 'sub-nav pill follows the scrolled section');

    await bp.goto(PROD + '/contact.html?type=dealer&product=yan', { waitUntil: 'load' });
    await bp.waitForTimeout(500);
    const dealerActive = await bp.$eval('[data-act="setIdentityDealer"]', (e) => e.getAttribute('style'));
    (dealerActive.includes('#141312') ? pass : fail)('behaviour', '?type=dealer preselects the identity card');
    const prefill = await bp.$eval('[data-act="onMessageChange"]', (e) => e.value);
    (prefill.includes('岩') ? pass : fail)('behaviour', '?product=yan prefills the message');

    const disabledBefore = await bp.$eval('[data-act="onSubmit"]', (e) => e.hasAttribute('disabled'));
    await bp.fill('[data-act="onNameChange"]', '测试');
    await bp.fill('[data-act="onContactChange"]', 'a@b.c');
    await bp.waitForTimeout(150);
    const disabledAfter = await bp.$eval('[data-act="onSubmit"]', (e) => e.hasAttribute('disabled'));
    (disabledBefore && !disabledAfter ? pass : fail)('behaviour', 'submit unlocks once name and contact are filled');

    await bp.click('[data-act="onSubmit"]');
    await bp.waitForTimeout(250);
    const submitted = await bp.$eval('[data-dc-if="submitted"]', (e) => !e.hasAttribute('data-dc-hidden'));
    const formHidden = await bp.$eval('[data-dc-if="notSubmitted"]', (e) => e.hasAttribute('data-dc-hidden'));
    (submitted && formHidden ? pass : fail)('behaviour', 'submit swaps to the confirmation panel');
    await bp.click('[data-act="resetForm"]');
    await bp.waitForTimeout(250);
    const back = await bp.$eval('[data-dc-if="notSubmitted"]', (e) => !e.hasAttribute('data-dc-hidden'));
    (back ? pass : fail)('behaviour', 'reset returns to the form');
    await bctx.close();

    /* Mobile menu lives behind the narrow-viewport branch. */
    const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
    const mp = await mctx.newPage();
    await mp.goto(PROD + '/index.html', { waitUntil: 'load' });
    await mp.waitForTimeout(500);
    const toggleVisible = await mp.$eval('[data-act="toggleMobile"]', (e) => e.getBoundingClientRect().width > 0);
    (toggleVisible ? pass : fail)('behaviour', 'mobile toggle is the visible branch at 390px');
    await mp.click('[data-act="toggleMobile"]');
    await mp.waitForTimeout(400);
    const menuOpen = await mp.$eval('[data-dc-if="mobileOpen"]', (e) => !e.hasAttribute('data-dc-hidden'));
    (menuOpen ? pass : fail)('behaviour', 'mobile menu opens');
    await mp.click('[data-act="closeMobile"]');
    await mp.waitForTimeout(300);
    const menuClosed = await mp.$eval('[data-dc-if="mobileOpen"]', (e) => e.hasAttribute('data-dc-hidden'));
    (menuClosed ? pass : fail)('behaviour', 'mobile menu closes');
    const desktopHidden = await mp.$eval('.dc-wide', (e) => e.getBoundingClientRect().width === 0);
    (desktopHidden ? pass : fail)('behaviour', 'desktop nav branch is hidden at 390px');
    await mctx.close();

    /* ── payload ──────────────────────────────────────────────────────── */
    const measure = async (url) => {
      const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const p = await c.newPage();
      try {
        await p.goto(url, { waitUntil: 'load', timeout: 45000 });
        await p.evaluate(() => document.fonts.ready).catch(() => {});
        await p.waitForTimeout(3000);
        const m = await p.evaluate(() => {
          const nav = performance.getEntriesByType('navigation')[0];
          const res = performance.getEntriesByType('resource');
          const hosts = new Set();
          for (const r of res) { try { hosts.add(new URL(r.name).host); } catch { /* data: */ } }
          return {
            requests: res.length + 1,
            bytes: (nav ? nav.transferSize : 0) + res.reduce((a, r) => a + (r.transferSize || 0), 0),
            hosts: [...hosts]
          };
        });
        return m;
      } catch { return null; } finally { await c.close(); }
    };
    const mProd = await measure(PROD + '/index.html');
    const mOrig = editOk ? await measure(EDIT + '/Home.dc.html') : null;
    if (mProd && mOrig) {
      console.log('\n  Home, cold cache');
      console.log(`    editing build : ${mOrig.requests} requests, ${(mOrig.bytes / 1024).toFixed(0)} KB, hosts: ${mOrig.hosts.join(', ')}`);
      console.log(`    production    : ${mProd.requests} requests, ${(mProd.bytes / 1024).toFixed(0)} KB, hosts: ${mProd.hosts.join(', ')}`);
    }

    await browser.close();
  } finally {
    prodSrv.kill();
    editSrv.kill();
  }

  /* ── report ─────────────────────────────────────────────────────────── */
  const failed = results.filter((r) => !r.ok);
  const byArea = new Map();
  for (const r of results) {
    if (!byArea.has(r.area)) byArea.set(r.area, []);
    byArea.get(r.area).push(r);
  }
  console.log('\n  Validation\n  ' + '─'.repeat(70));
  for (const [area, rs] of byArea) {
    const bad = rs.filter((r) => !r.ok);
    console.log(`  ${bad.length ? 'FAIL' : ' ok '}  ${area.padEnd(12)} ${rs.length - bad.length}/${rs.length}`);
    for (const r of bad) console.log(`         · ${r.msg}`);
  }
  console.log('  ' + '─'.repeat(70));
  console.log(`  ${results.length - failed.length}/${results.length} checks passed`);
  console.log(`  screenshots: build/screenshots/\n`);
  await writeFile(path.join(ROOT, 'build', 'validation-report.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('validate failed:', e); process.exit(1); });
