# Hardnest 官网

Two builds from one source. The `.dc.html` files stay the editing format;
`dist/` is a static, self-contained production build with no React, no
third-party requests, and no editing runtime.

```
npm run edit        # editing preview  -> http://localhost:8931/Home.dc.html
npm run build       # compile          -> dist/
npm run serve       # production       -> http://localhost:8080/
npm run validate    # 112-check equivalence + regression suite
```

`npm run build` needs network access once, to fetch the font subsets from
Google. Everything else is offline.

## What changed, and why

The editing build blocks all rendering on two scripts from `unpkg.com`
(`support.js:1907` — `loadReactUmd().then(init)`, with `x-dc{display:none}`
applied immediately), then fetches the page HTML a second time, then fetches
`SiteNav`/`SiteFooter`, then dynamically imports `productData.js`. On a
mainland Chinese connection `unpkg.com` is unreliable and
`fonts.googleapis.com` is blocked outright, so that waterfall is the single
biggest thing wrong with the site. `dist/` has none of it.

| | editing | production |
|---|---|---|
| Home, cold cache | 688 KB | **232 KB** |
| third-party hosts | `unpkg.com`, `fonts.googleapis.com` | **none** |
| logo | 1180×776, 164 KB (3.66 MB decoded) | 170×112, 4.6 KB |
| shipped runtime | `support.js` 69 KB + `image-slot.js` 65 KB + React 18 | ~6 KB |

## Runtime work removed

Everything below preserves the rendered result exactly; only *when* work
happens changed.

- **Scroll handler** batches all reads before all writes. The original
  interleaved them (`Home.dc.html:325-343`: transform write → `scrollHeight`
  read → width write → `getBoundingClientRect` read), forcing two synchronous
  layouts per scroll frame. None of those writes can affect those reads — the
  bar is `position:fixed`, transforms don't affect layout, both section
  heights are fixed — so the computed values are identical.
- **One pointer measurement** for the hero. `#hero` had two `mousemove`
  listeners each calling `getBoundingClientRect()`; the canvas is `inset:0`
  inside a `position:relative` `#hero` with no padding or border, so the two
  rects were provably identical.
- **Cursor glow settles.** The original ran a `requestAnimationFrame` loop
  forever writing `left`/`top`. On a touch device `mousemove` never fires, so
  `cx`/`cy` start already equal to their targets and every one of those frames
  wrote an unchanged value for the life of the page. It now stops below
  1/256 px of remaining travel — under the 1/64 px layout quantum, so the
  resting position rasterises to the same pixel.
- **Canvas stops painting off-screen.** Particle state keeps advancing at the
  same rate (the original is frame-count based — `t += 0.016`), so scrolling
  back lands on the frame it would have reached. Because the bitmap stops
  changing, the `mix-blend-mode: screen` canvas and the `mix-blend-mode:
  overlay` noise layer above it stop being recomposited too — that stack is
  the hero's real GPU cost.
- **Resize guard.** Mobile URL-bar show/hide fires `resize` with an unchanged
  box; the original reallocated and cleared the canvas backing store anyway.
- **Off-screen CSS animations pause, phase-exact.** `marquee`, `spinSlow`,
  `spinSlowRev`, `blobMorph`, `glowDrift` and `scrollLine` are all infinite
  and never stopped. `blobMorph` is the worst — it animates `border-radius`,
  which is not compositable, so it repainted every frame forever. On resume,
  `currentTime` is advanced past the time spent hidden, so the animation lands
  where it would have been had it never stopped.
- **`shadowColor` hoisted** out of the particle loop (it was reassigned to the
  same literal 62× per frame; `shadowBlur` is 0 for the strokes, so this
  cannot change output).
- **Progress bar** uses `transform: scaleX()` with `transform-origin: 0 50%`
  instead of `width`, with the transition retargeted to `transform` at the
  same `0.1s linear`.

Deliberately **not** changed:

- The card tilt still re-reads `getBoundingClientRect()` on every move. The
  card already carries the previous move's transform, so the rect includes it
  and the tilt is a feedback loop — caching the rect would change the
  response curve.
- The particle pair loop is untouched. At N=62 it is 1,891 iterations of six
  float ops; the cost in that loop is the ~200-400 `stroke()` calls that pass
  the distance gate, and spatial partitioning removes none of them.
- Mouse-connection lines stay interleaved with the dots. Batching them into a
  separate pass would put every line above every dot and change alpha
  compositing where they overlap.

## Needs your sign-off (not enabled by default)

- **`node build/build.mjs --particle-sprites`** replaces 62 `shadowBlur`
  fills per frame with 62 `drawImage` calls from a per-particle sprite atlas.
  This is the largest remaining canvas win, but it is *not* pixel-identical:
  compositing a pre-baked shape-over-shadow and then scaling by `globalAlpha`
  is not the same as scaling source alpha before the blur. The difference is
  sub-1% alpha on a 1–2 px glowing dot. Smoke-tested and working; diff it
  before shipping.
- **The nav's `backdrop-filter` transition** is untouched.
  `SiteNav.dc.html:101` transitions `backdrop-filter 0.4s ease`, which
  animates the blur *radius* between 8px and 20px and invalidates the cached
  blur texture every frame for 400 ms, every time you cross y=40. Dropping
  just that one transition (leaving the blur itself alone) is a real heat win
  but makes the blur snap instead of fade.

## Known behaviour changes

- **The mobile/desktop nav split is now a CSS media query**, not `sc-if` on
  `matchMedia`. `isNarrow` started `false`, so mobile users previously got the
  desktop nav on first paint and watched it swap. The boundary is exactly
  complementary (`max-width:860px` / `not all and (max-width:860px)`).
- **Fonts are now self-hosted**, so mainland visitors will see Noto Sans/Serif
  SC where they previously fell back to PingFang SC — Google Fonts is blocked
  there, so the design was never reaching them.
- Pages gained a `<title>` and a favicon (every page load previously spent a
  request on `/favicon.ico` and took a 404).

## Fonts

Subsets are fetched through the Google Fonts `text=` API, so the shipped bytes
are the *same binaries* Google serves today, subset by Google's own pipeline —
identical outlines, hinting and vertical metrics. Static instances at the
exact weights the pages ask for (300/400/500/700/900 and 500/700/900); no
variable font substitution.

Glyphs are bucketed by the `(family, weight)` that actually renders them
(`build/lib/glyphs.mjs`), so the 900-weight face carries the H1's ten
characters rather than all ~600 on the site. `npm run validate` asserts via
`document.fonts.check()` that no rendered character falls outside its subset.

**Free text typed into the Contact form** falls back to the system CJK font
(`PingFang SC` / Android's Noto Sans CJK) for characters outside the subset —
the existing `font-family` chain is unchanged. To widen coverage, add
characters to `ALWAYS` in `build/lib/fonts.mjs`.

## Images

`<image-slot>` stores every slot for every page of the directory in one
`.image-slots.state.json` as base64 data URLs, so each page downloads every
other page's images, inflated 33%, in a blob no cache can partition. The
sidecar now exists — twelve slots are filled with product photography picked
from the source libraries (`猫爬架/`, `猫窝沙发/`): the home hero, the four
home product cards (`home-card-p-yan/xue/jie/wan`), the home lifestyle
section, the four Products-page heroes, and the BrandStory hero/lifestyle
images. `build/fill-slots.mjs` records which source photo backs each slot and
regenerates the sidecar; the BrandStory scroll-scene process panels no
longer carry image slots (no factory photography exists — text-only panels
beat empty frames).

On rebuild the build base64-decodes each entry and writes it out as a
content-hashed `.webp`, byte-for-byte. No re-encode: the stored bytes are
already WebP q=0.85, capped at 1200 px for cards/product heroes and 1920 px
for the full-bleed slots (`fill-slots.mjs` bakes this in, matching the
editor's own encode at `image-slot.js:151,269`). Encoding again would
compound a loss already taken once. The hero gets `fetchpriority="high"`;
everything below the fold gets `loading="lazy"`.

Slot ids inside an `<sc-for>` loop (`home-card-{{ item.id }}`) are resolved
against the loop scope at build time (`build.mjs`), so the sidecar stores
the concrete per-product ids the editing runtime saw.

Uncropped slots emit `object-fit: cover` — for default framing the runtime's
`_applyView` geometry (`image-slot.js:998-1041`) reduces to exactly that.
Reframed slots keep their absolute geometry, because `base` there is computed
against the live frame size and cannot be baked into a static percentage.

## Caching

`server.js` serves the `.br`/`.gz` files the build precompressed (nothing is
compressed per-request) and applies the split the hashed filenames make safe:

- `assets/<name>.<hash>.<ext>` → `max-age=31536000, immutable`
- `*.html` → `max-age=0, must-revalidate` (cheap 304s)

ETags are per *representation* — the brotli, gzip and identity bodies of one
file get different tags, which is what RFC 9110 requires and what stops an
intermediary handing a client an encoding it didn't ask for. Only text types
are compressed; woff2/png/webp are already compressed and are served as-is.

## Editing

Edit the `.dc.html` files and `productData.js` as before; `npm run edit` is
unchanged. Copy, styles, `style-hover`, and product data all flow through the
build — the compiler evaluates each page's own `class Component extends
DCLogic` and calls its real `renderVals()`, so every style string in `dist/`
is produced by the same code React was running.

**Component *logic* does not flow through.** `componentDidMount` and friends
are reimplemented in `build/runtime/*.js`. If you change interaction
behaviour in a `.dc.html` script block, mirror it there and re-run
`npm run validate`.
