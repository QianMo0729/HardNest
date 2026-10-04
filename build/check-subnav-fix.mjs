/* One-off check for the sticky filter-bar fix on products.html.
   Scrolls down (nav hides -> bar must move to top:0) and back up
   (nav returns -> bar must return to top:74px). */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 8937;

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore'
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function barState(page) {
  return page.evaluate(() => {
    const bar = document.querySelector('[data-sk="subnavStyle"]');
    const nav = document.querySelector('[data-sk="navBarStyle"]');
    const r = bar.getBoundingClientRect();
    return {
      barTop: Math.round(r.top * 100) / 100,
      barStuckAt: getComputedStyle(bar).top,
      navTransform: getComputedStyle(nav).transform,
      scrollY: window.scrollY
    };
  });
}

async function scrollTo(page, y) {
  // Instant jumps in a few steps: direction deltas drive the nav hide/show
  // logic; smooth-behavior scrolling would fight the page's own CSS.
  await page.evaluate(async (target) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 6; i++) {
      const cur = window.scrollY;
      const next = cur + (target - cur) / (6 - i);
      window.scrollTo({ top: next, behavior: 'instant' });
      await sleep(90);
    }
    window.scrollTo({ top: target, behavior: 'instant' });
  }, y);
  await sleep(1400); // let the 0.5s nav/bar transitions finish
}

try {
  await sleep(800);
  const browser = await chromium.launch({ executablePath: CHROME });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`http://127.0.0.1:${PORT}/products.html`, { waitUntil: 'load' });
  await sleep(600);

  // 1. Scroll deep into the page (downward): nav hides, bar -> top:0
  await scrollTo(page, 3000);
  const down = await barState(page);
  // 2. Scroll back up a bit: nav reappears, bar -> top:74px
  await scrollTo(page, 2400);
  const up = await barState(page);
  // 3. Back to very top: nav visible
  await scrollTo(page, 0);
  const top = await barState(page);

  await browser.close();

  // translateY(0) computes to an identity matrix, translateY(-100%) to ty=-74
  const navTy = (m) => (m === 'none' ? 0 : Number(m.slice(7, -1).split(',')[5]));
  const checks = [
    ['scroll down: nav hidden', navTy(down.navTransform) === -74],
    ['scroll down: bar top css = 0px', down.barStuckAt === '0px'],
    ['scroll down: bar glued to viewport top', Math.abs(down.barTop) < 2],
    ['scroll up: nav visible again', navTy(up.navTransform) === 0],
    ['scroll up: bar top css = 74px', up.barStuckAt === '74px'],
    ['scroll up: bar sits at 74px', Math.abs(up.barTop - 74) < 2],
    ['page top: bar top css = 74px', top.barStuckAt === '74px'],
    ['no console/page errors', errors.length === 0]
  ];

  let bad = 0;
  for (const [name, ok] of checks) {
    console.log((ok ? '  PASS ' : '  FAIL ') + name);
    if (!ok) bad++;
  }
  console.log('\nsnapshots:');
  console.log('down:', JSON.stringify(down));
  console.log('up:  ', JSON.stringify(up));
  console.log('top: ', JSON.stringify(top));
  if (errors.length) console.log('errors:', errors);
  process.exit(bad ? 1 : 0);
} finally {
  server.kill();
}
