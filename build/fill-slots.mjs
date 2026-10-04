// One-off: encode the picked product photos into the image-slot sidecar.
// Contract mirrored from image-slot.js (WebP q=0.85), except full-bleed
// slots are capped at 1920px instead of 1200px so the hero stays sharp.
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const P = '猫爬架/猫爬架/';
const S = '猫窝沙发/猫窝沙发/';

const PICKS = {
  'hero-main':        [P + 'Clipboard - 2025-10-16 16.01.46.png', 1920],
  'home-card-p-yan':  [P + '1 (1).png', 1200],
  'home-card-p-xue':  [S + 'Gemini_Generated_Image_6lhn776lhn776lhn.png', 1200],
  'home-card-p-jie':  [P + 'Clipboard - 2025-03-18 14.08.05.png', 1200],
  'home-card-p-wan':  [S + '高端宠物家具设计，曲面流线型沙发，下面内置猫窝，流体力学造型搭配波浪表面参数化设计纹理，造型为油漆材质搭配高弹力沙发坐垫，场景的高端设计美学，产品摄影，高分辨率，专业 2.png', 1200],
  'lifestyle-main':   [P + '微信图片_202309180850421.png', 1920],
  'prod-hero-yan':    [P + '1 (10).png', 1200],
  'prod-hero-xue':    [S + 'qifu3d_a_full_shot_of_a_unique_modern_white_sofa_featuring_a_bu_747b27.png', 1200],
  'prod-hero-jie':    [P + 'qifu3d_A_tall_three-dimensional_cat_jungle_gym_with_a_surface_p_02940b.png', 1200],
  'prod-hero-wan':    [S + '高端宠物家具设计，曲面流线型沙发，下面内置猫窝，流体力学造型搭配波浪表面参数化设计纹理，白色亮面油漆材质，场景的高端设计美学，产品摄影，高分辨率，专业工作室灯光.png', 1200],
  'story-hero':       [S + 'Clipboard - 2026-05-30 15.42.36.png', 1920],
  'story-lifestyle':  [S + 'qifu3d_Product_design_human_pet_sofa_single_sofa_combined_insta_0-2.png', 1920]
};

const out = {};
for (const [id, [file, cap]] of Object.entries(PICKS)) {
  const img = sharp(await readFile(file)).rotate(); // honour EXIF orientation
  const meta = await img.metadata();
  const scale = Math.min(1, cap / Math.max(meta.width, meta.height));
  const buf = await img
    .resize(Math.round(meta.width * scale), Math.round(meta.height * scale), { kernel: 'lanczos3' })
    .webp({ quality: 85 })
    .toBuffer();
  out[id] = 'data:image/webp;base64,' + buf.toString('base64');
  console.log(id.padEnd(18), meta.width + 'x' + meta.height, '->', Math.round(meta.width * scale) + 'x' + Math.round(meta.height * scale), (buf.length / 1024).toFixed(0) + ' KB');
}

await writeFile('Hardnest官网/.image-slots.state.json', JSON.stringify(out));
console.log('sidecar written:', Object.keys(out).length, 'slots');
