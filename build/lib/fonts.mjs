import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { hashName } from './assets.mjs';

/* Self-hosting via the Google Fonts `text=` parameter.
 *
 * This matters for equivalence: the bytes we ship are the *same binaries*
 * Google serves this page today, subset by Google's own pipeline. Outlines,
 * hinting, vertical metrics and the weight instances are therefore
 * identical — which they would not be if we substituted a variable font or
 * re-instanced the family ourselves.
 *
 * Everything is requested as static instances at the exact weights the
 * pages ask for (300/400/500/700/900 and 500/700/900).
 */

const UA_WOFF2 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* Always covered regardless of page content, so digits, Latin and the
   punctuation the copy leans on can never fall out of a subset. The CJK
   tail is the colourway names the Products page swaps in at runtime —
   only the default one renders statically, the rest must not fall back. */
export const ALWAYS = Array.from(
  ' !"#$%&\'()*+,-./0123456789:;<=>?@' +
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`' +
  'abcdefghijklmnopqrstuvwxyz{|}~' +
  '·×÷–—‘’“”…′″' +
  '←↑→↓⇒✓✔✕✖◆●○■□' +
  '，。、；：？！（）【】《》〈〉「」' +
  '％＋－＝＜＞＠＃＆＊　°±≈≠≤≥№™©®' +
  '米白暖沙墨黑云雾灰驼棕'
);

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function unicodeRange(chars) {
  return chars.map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase()).join(',');
}

async function fetchCss(family, weight, text) {
  const url = 'https://fonts.googleapis.com/css2?family=' +
    encodeURIComponent(family) + ':wght@' + weight +
    '&text=' + encodeURIComponent(text) +
    '&display=swap';
  const res = await fetch(url, { headers: { 'User-Agent': UA_WOFF2 } });
  if (!res.ok) throw new Error(`google fonts ${res.status} for ${family} ${weight}`);
  return res.text();
}

/**
 * @param buckets Map<"CssName|weight", Set<string>>
 * @param apiName Map<CssName, google family name>
 */
export async function buildFonts(buckets, apiName, outDir, { chunkSize = 400 } = {}) {
  await mkdir(outDir, { recursive: true });
  const faces = [];
  const files = [];
  let total = 0;

  const keys = Array.from(buckets.keys()).sort();
  for (const key of keys) {
    const [cssName, weightStr] = key.split('|');
    const weight = parseInt(weightStr, 10);
    const family = apiName[cssName];
    if (!family) throw new Error(`no Google family mapped for "${cssName}"`);

    const chars = Array.from(new Set([...ALWAYS, ...buckets.get(key)])).sort();
    const groups = chunk(chars, chunkSize);

    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      const css = await fetchCss(family, weight, group.join(''));
      // Subset responses serve from /l/font?kit=... with no file extension.
      const m = /src:\s*url\((https:\/\/[^)\s]+)\)\s*format\('woff2'\)/.exec(css);
      if (!m) throw new Error(`no woff2 in Google CSS for ${family} ${weight} chunk ${gi}`);
      // Prefer Google's own unicode-range: it describes exactly what the
      // returned file contains, which is the authoritative answer if their
      // subsetter ever drops or adds a codepoint relative to our request.
      const ur = /unicode-range:\s*([^;}]+)/.exec(css);

      const bin = await fetch(m[1], { headers: { 'User-Agent': UA_WOFF2 } });
      if (!bin.ok) throw new Error(`woff2 download ${bin.status} for ${family} ${weight}`);
      const buf = Buffer.from(await bin.arrayBuffer());

      const name = hashName(buf, `${cssName.replace(/\s+/g, '')}-${weight}-${gi}.woff2`);
      await writeFile(path.join(outDir, name), buf);
      files.push({ name, bytes: buf.length, family: cssName, weight, glyphs: group.length });
      total += buf.length;

      faces.push(
        `@font-face{font-family:'${cssName}';font-style:normal;font-weight:${weight};` +
        // Relative to fonts.css, which is emitted into assets/ alongside
        // the woff2 files — an "assets/" prefix here resolves to
        // /assets/assets/... and 404s.
        `font-display:swap;src:url(${name}) format('woff2');` +
        `unicode-range:${ur ? ur[1].trim() : unicodeRange(group)}}`
      );
    }
  }

  return { css: faces.join('\n'), files, stats: { faces: faces.length, bytes: total } };
}
