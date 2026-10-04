import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export function hashName(buf, name) {
  const h = createHash('sha256').update(buf).digest('hex').slice(0, 10);
  const ext = path.extname(name);
  return `${path.basename(name, ext)}.${h}${ext}`;
}

/**
 * The nav/footer logo ships at 1180x776 RGBA — a 3.66 MB decoded bitmap for
 * a box that is never taller than 28 CSS px. We re-raster it at 4x the
 * largest on-page height (112 px) so it stays sharp to DPR 4.
 *
 * Resampling cannot land on 1180/776 exactly at these sizes, so layout is
 * pinned separately with `aspect-ratio:1180/776` on the <img>. That keeps
 * the used width at height x 1180/776 regardless of the bitmap's real
 * dimensions, so the nav flex row lays out identically to before.
 */
export const LOGO_RATIO = [1180, 776];

export async function buildLogo(srcPath, outDir) {
  const src = await readFile(srcPath);
  const meta = await sharp(src).metadata();
  const targetH = 112;
  const targetW = Math.round(meta.width * (targetH / meta.height));

  const out = await sharp(src)
    .resize(targetW, targetH, { fit: 'fill', kernel: 'lanczos3' })
    .png({ compressionLevel: 9, effort: 10, palette: false })
    .toBuffer();

  const paletted = await sharp(src)
    .resize(targetW, targetH, { fit: 'fill', kernel: 'lanczos3' })
    .png({ compressionLevel: 9, effort: 10, palette: true, quality: 100, colours: 256 })
    .toBuffer();

  // Prefer the palette encode only when it is materially smaller; a logo is
  // usually few-colour enough that it is, and at 256 colours + full alpha the
  // visible difference on a 40x26 box is nil.
  const chosen = paletted.length < out.length * 0.9 ? paletted : out;
  const name = hashName(chosen, 'logo-mark-dark.png');
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, name), chosen);

  return {
    name,
    bytes: chosen.length,
    originalBytes: src.length,
    width: targetW,
    height: targetH,
    natural: [meta.width, meta.height]
  };
}

/**
 * Square icons derived from the logo. Without these every page load spends
 * a request on /favicon.ico and takes a 404 for it.
 */
export async function buildIcons(srcPath, outDir) {
  const src = await readFile(srcPath);
  const out = {};
  for (const [key, size] of [['favicon', 64], ['apple', 180]]) {
    const buf = await sharp(src)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9, effort: 10 })
      .toBuffer();
    const name = hashName(buf, `${key}-${size}.png`);
    await writeFile(path.join(outDir, name), buf);
    out[key] = { name, size, bytes: buf.length };
  }
  return out;
}

/**
 * Pull images out of the <image-slot> sidecar.
 *
 * image-slot.js stores every slot on every page of the directory in one
 * `.image-slots.state.json`, as base64 data URLs. That means each page
 * downloads every other page's images, inflated 33% by base64, in a single
 * blob that no cache can partition.
 *
 * The extraction is byte-exact: the stored bytes are already WebP q=0.85
 * capped at 1200 px (image-slot.js:151,269), so we base64-decode and write
 * them out untouched. Re-encoding would compound a loss that has already
 * been taken once.
 */
export async function extractSlots(sidecarPath, outDir) {
  let raw;
  try {
    raw = JSON.parse(await readFile(sidecarPath, 'utf8'));
  } catch {
    return { present: false, slots: {} };
  }
  await mkdir(outDir, { recursive: true });
  const slots = {};

  for (const [id, value] of Object.entries(raw)) {
    const v = typeof value === 'string' ? { u: value, s: 1, x: 0, y: 0 } : value;
    if (!v || !v.u) continue;
    const m = /^data:image\/(\w+);base64,(.*)$/s.exec(v.u);
    if (!m) { slots[id] = { src: v.u, s: v.s ?? 1, x: v.x ?? 0, y: v.y ?? 0 }; continue; }

    const bytes = Buffer.from(m[2], 'base64');
    const name = hashName(bytes, `slot-${id}.${m[1]}`);
    await writeFile(path.join(outDir, name), bytes);

    let dim = {};
    try {
      const meta = await sharp(bytes).metadata();
      dim = { w: meta.width, h: meta.height };
    } catch { /* dimensions are optional */ }

    slots[id] = {
      src: `assets/${name}`,
      s: Number.isFinite(v.s) ? v.s : 1,
      x: Number.isFinite(v.x) ? v.x : 0,
      y: Number.isFinite(v.y) ? v.y : 0,
      bytes: bytes.length,
      base64Bytes: m[2].length,
      ...dim
    };
  }
  return { present: true, slots };
}

/**
 * Static markup for one <image-slot>.
 *
 * For default framing (s=1, x=0, y=0) the runtime's _applyView geometry
 * (image-slot.js:998-1041) reduces exactly to object-fit:cover with a
 * centred object-position, so that is what we emit.
 *
 * A reframed slot cannot be expressed that way: `base` there is computed
 * against the *live* frame size, so the percentages are viewport-dependent
 * and cannot be baked. Those slots get the same absolutely-positioned
 * geometry the component produced, driven by the tiny reframe helper.
 */
export function slotMarkup(attrs, slot, opts = {}) {
  const style = attrs.style || '';
  const id = attrs.id || '';
  const shape = (attrs.shape || 'rounded').toLowerCase();
  const radius = attrs.radius ? `${parseFloat(attrs.radius)}px` : '12px';

  let frameStyle = '';
  if (attrs.mask) frameStyle = `clip-path:${attrs.mask};`;
  else if (shape === 'circle') frameStyle = 'border-radius:50%;';
  else if (shape === 'pill') frameStyle = 'border-radius:999px;';
  else if (shape === 'rounded') frameStyle = `border-radius:${radius};`;

  const idAttr = id ? ` id="${id}"` : '';

  if (!slot || !slot.src) {
    const ph = opts.showPlaceholder && attrs.placeholder
      ? `<span class="dc-slot-ph">${attrs.placeholder}</span>` : '';
    return `<div${idAttr} class="dc-slot" style="${style}"><div class="dc-slot-frame" style="${frameStyle}">${ph}</div></div>`;
  }

  const fit = (attrs.fit || 'cover').toLowerCase() === 'contain' ? 'contain' : 'cover';
  const reframed = slot.s !== 1 || slot.x !== 0 || slot.y !== 0;
  const dims = slot.w && slot.h ? ` width="${slot.w}" height="${slot.h}"` : '';
  const loading = opts.eager ? ' fetchpriority="high" decoding="async"' : ' loading="lazy" decoding="async"';

  if (!reframed) {
    return `<div${idAttr} class="dc-slot" style="${style}"><div class="dc-slot-frame" style="${frameStyle}">` +
      `<img src="${slot.src}"${dims} alt=""${loading} style="width:100%;height:100%;object-fit:${fit};object-position:50% 50%;">` +
      `</div></div>`;
  }

  const view = JSON.stringify({ s: slot.s, x: slot.x, y: slot.y, iw: slot.w, ih: slot.h, fit });
  return `<div${idAttr} class="dc-slot" style="${style}"><div class="dc-slot-frame" style="${frameStyle}">` +
    `<img src="${slot.src}"${dims} alt=""${loading} data-view='${view}' class="dc-slot-crop" ` +
    `style="position:absolute;max-width:none;left:50%;top:50%;transform:translate(-50%,-50%);">` +
    `</div></div>`;
}

/* Shadow-DOM :host / .frame rules from image-slot.js, flattened into one
   shared stylesheet instead of a 4 KB <style> re-parsed inside every slot's
   shadow root. */
export const SLOT_CSS = `
.dc-slot{display:block;position:relative;width:100%;height:100%;aspect-ratio:3/2}
.dc-slot-frame{position:absolute;inset:0;overflow:hidden;background:rgba(127,127,127,.08)}
.dc-slot-ph{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:12px;text-align:center;font:13px/1.3 system-ui,-apple-system,sans-serif;color:inherit;opacity:.5}
`.trim();
