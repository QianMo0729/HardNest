/* Shared runtime. Replaces support.js + React for production pages. */
(function () {
  'use strict';

  var W = window;

  /* Deterministic RNG for validation runs only. Production always uses
     Math.random, so seeding cannot alter shipped behaviour. */
  W.__dcRandom = (function () {
    var seed = null;
    try {
      var q = new URLSearchParams(location.search).get('__seed');
      if (q) seed = parseInt(q, 10) >>> 0;
    } catch (e) { /* no-op */ }
    if (seed === null) return Math.random;
    var s = seed;
    return function mulberry32() {
      s |= 0; s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  })();

  /* ── style-variant application ──────────────────────────────────────
     __DCV holds style strings the page's own renderVals() produced at
     build time, one per declared state. Swapping between them is the only
     way this runtime is allowed to change a style attribute. */
  var DCV = W.__DCV || {};

  function applyGroup(group, sig) {
    var els = document.querySelectorAll('[data-sg="' + group + '"]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var table = DCV[el.getAttribute('data-sk')];
      if (!table) continue;
      var v = table[sig];
      if (v != null && el.getAttribute('style') !== v) el.setAttribute('style', v);
    }
  }

  function applyOne(el, sig) {
    var table = DCV[el.getAttribute('data-sk')];
    if (!table) return;
    var v = table[sig];
    if (v != null && el.getAttribute('style') !== v) el.setAttribute('style', v);
  }

  /* ── sc-if branches ─────────────────────────────────────────────────
     Toggling an attribute (not inline style) lets the element fall back to
     its authored display:flex / display:block instead of whatever we last
     wrote into style. */
  function setIf(name, on) {
    var els = document.querySelectorAll('[data-dc-if="' + name + '"]');
    for (var i = 0; i < els.length; i++) {
      if (on) els[i].removeAttribute('data-dc-hidden');
      else els[i].setAttribute('data-dc-hidden', '');
    }
  }

  /* ── reveal-on-scroll ───────────────────────────────────────────────
     Same thresholds and same unobserve-after-fire as the original. */
  function reveal(threshold, rootMargin) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.style.opacity = '1';
          entry.target.style.transform = 'translateY(0)';
          io.unobserve(entry.target);
        }
      });
    }, { threshold: threshold, rootMargin: rootMargin });
    document.querySelectorAll('[data-reveal]').forEach(function (el) { io.observe(el); });
    return io;
  }

  /* ── off-screen animation suspension ────────────────────────────────
     Infinite CSS animations (marquee, spinSlow, spinSlowRev, blobMorph,
     glowDrift, scrollLine) otherwise keep style/paint alive at display
     rate for the life of the page, including while scrolled far away.
     blobMorph is the worst of them: it animates border-radius, which is
     not compositable, so it repaints every frame forever.

     Pausing is made phase-exact by advancing currentTime past the time
     spent off-screen on resume, so a scroll-away-and-back lands on the
     frame it would have reached had it never stopped. */
  function suspendOffscreenAnimations() {
    if (!document.getAnimations) return;
    var groups = new Map();

    document.getAnimations().forEach(function (anim) {
      var eff = anim.effect;
      if (!eff || !eff.target) return;
      var timing = eff.getTiming();
      if (timing.iterations !== Infinity) return;
      var target = eff.target;
      if (!groups.has(target)) groups.set(target, []);
      groups.get(target).push(anim);
    });

    if (!groups.size) return;

    var io = new IntersectionObserver(function (entries) {
      var now = performance.now();
      entries.forEach(function (entry) {
        var anims = groups.get(entry.target);
        if (!anims) return;
        for (var i = 0; i < anims.length; i++) {
          var a = anims[i];
          if (entry.isIntersecting) {
            if (a.__pausedAt != null) {
              try { a.currentTime = (a.currentTime || 0) + (now - a.__pausedAt); } catch (e) { /* no-op */ }
              a.__pausedAt = null;
            }
            if (a.playState === 'paused') { try { a.play(); } catch (e) { /* no-op */ } }
          } else if (a.playState === 'running') {
            a.__pausedAt = now;
            try { a.pause(); } catch (e) { /* no-op */ }
          }
        }
      });
    }, { rootMargin: '160px 0px 160px 0px' });

    groups.forEach(function (_, target) { io.observe(target); });
    return io;
  }

  W.DC = {
    applyGroup: applyGroup,
    applyOne: applyOne,
    setIf: setIf,
    reveal: reveal,
    suspendOffscreenAnimations: suspendOffscreenAnimations,
    on: function (act, type, fn) {
      document.addEventListener(type, function (e) {
        var el = e.target.closest ? e.target.closest('[data-act="' + act + '"]') : null;
        if (el) fn(e, el);
      });
    },
    ready: function (fn) {
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
      else fn();
    }
  };
})();

/* Site navigation: scroll hide/show, scrolled state, mobile menu.
   Mirrors SiteNav.dc.html componentDidMount exactly (thresholds 40 / 80 / ±4).

   Difference from the React version: that one rebuilt the whole ~520-char
   navBarStyle string and re-set the style attribute on every state change.
   Here the two style strings are the ones renderVals() produced at build
   time and we only touch the attribute when the signature actually flips. */
(function () {
  'use strict';
  var DC = window.DC;

  DC.ready(function () {
    var bar = document.querySelector('[data-sk="navBarStyle"]');
    if (!bar) return;

    var lastY = window.scrollY || 0;
    var ticking = false;
    var hidden = false;
    var scrolled = false;

    function paint() {
      DC.applyOne(bar, scrolled + '|' + hidden);
    }

    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        var y = window.scrollY || 0;
        var nextScrolled = y > 40;
        var nextHidden = hidden;
        if (y < 80) nextHidden = false;
        else if (y > lastY + 4) nextHidden = true;
        else if (y < lastY - 4) nextHidden = false;
        if (nextHidden !== hidden || nextScrolled !== scrolled) {
          hidden = nextHidden;
          scrolled = nextScrolled;
          paint();
        }
        lastY = y;
        ticking = false;
      });
    }
    window.addEventListener('scroll', onScroll, { passive: true });

    /* Mobile menu. The panel is pre-rendered and toggled via the
       [data-dc-hidden] attribute, so going from hidden to shown is a
       display:none -> display:flex change, which restarts the authored
       navFadeIn animation exactly like the mount/unmount did. */
    var open = false;
    function setOpen(v) {
      open = v;
      DC.setIf('mobileOpen', open);
    }
    DC.on('toggleMobile', 'click', function () { setOpen(!open); });
    DC.on('closeMobile', 'click', function () { setOpen(false); });
  });
})();

/* BrandStory scroll scene: powder particles gather into a rotating blank,
   then crossfade into the real product photo — "从一粒粉末，到一件家具".

   Shared entry point: window.StoryScene.init()
     - editing page: loaded via <script src="./story-scene.js"> in the
       BrandStory.dc.html helmet, called from the page's DC logic
     - production build: build.mjs inlines this file into the story bundle,
       called from build/runtime/story.js

   Pure Canvas 2D with hand-rolled 3D projection — no dependencies, in
   keeping with build/runtime/home.js. init() returns a destroy() function,
   or null when the scene should stay hidden (reduced motion, no 2D
   context, missing markup) so the caller's static fallback remains. */
(function () {
  'use strict';

  var REDUCED = typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function ease(u) { u = clamp01(u); return u * u * (3 - 2 * u); }

  /* [t, value] pairs, smoothstep between neighbours. */
  function kf(frames, t) {
    if (t <= frames[0][0]) return frames[0][1];
    for (var i = 1; i < frames.length; i++) {
      if (t <= frames[i][0]) {
        var t0 = frames[i - 1][0], v0 = frames[i - 1][1];
        var t1 = frames[i][0], v1 = frames[i][1];
        return v0 + (v1 - v0) * ease((t - t0) / (t1 - t0));
      }
    }
    return frames[frames.length - 1][1];
  }

  /* Act window: 0 before a, ramps a->b, holds b..c, ramps c->d down. */
  function win(t, a, b, c, d) {
    if (t <= a || t >= d) return 0;
    if (t < b) return ease((t - a) / (b - a));
    if (t <= c) return 1;
    return 1 - ease((t - c) / (d - c));
  }

  /* ── choreography ─────────────────────────────────────────────────── */
  /* Desktop x journey of the particle body: centre -> left -> right ->
   * centre. Mobile keeps it centred (panels stack below instead). */
  var MORPH = [[0, 0], [0.09, 0], [0.24, 0.42], [0.50, 1], [1, 1]];
  var CX_SIDE = [[0, 0.50], [0.09, 0.50], [0.24, 0.295], [0.34, 0.295], [0.50, 0.69], [0.56, 0.69], [0.66, 0.295], [0.76, 0.295], [0.87, 0.50], [1, 0.50]];
  var CY_SIDE = [[0, 0.55], [0.24, 0.50], [1, 0.50]];
  var CY_STACK = [[0, 0.50], [0.24, 0.30], [0.87, 0.30], [0.945, 0.45], [1, 0.45]];
  var SCALE = [[0, 1], [0.24, 0.92], [0.50, 1], [0.72, 1], [0.87, 1.32], [1, 1.32]];
  var HEAT = [[0, 0], [0.28, 0], [0.48, 1], [1, 1]];
  var COOL = [[0, 0], [0.50, 0], [0.68, 1], [1, 1]];
  var SPIN = [[0, 0.14], [0.24, 0.30], [0.36, 0.60], [0.47, 2.6], [0.58, 0.9], [0.72, 0.45], [1, 0.30]];
  var FADE = [[0, 1], [0.875, 1], [0.955, 0], [1, 0]];
  /* The blank solidifies as it cools: a shaded body fades in under the
     particles, which then read as surface texture rather than a swarm. */
  var SOLID = [[0, 0], [0.50, 0], [0.62, 0.85], [0.68, 1], [1, 1]];
  /* Final act: the blank settles into the reveal card's exact rect so the
     particle->photo cross-fade swaps a glowing silhouette for the real
     product with no geometry jump. */
  var CARD = [[0, 0], [0.80, 0], [0.93, 1], [1, 1]];

  function hexRGB(hex) {
    return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  }
  function mixRGB(a, b, u) {
    return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
  }
  function cssRGB(c, k) {
    return 'rgb(' + Math.min(255, Math.round(c[0] * k)) + ',' +
      Math.min(255, Math.round(c[1] * k)) + ',' + Math.min(255, Math.round(c[2] * k)) + ')';
  }

  /* Particle colour ramp: cool grey -> ember -> brand orange -> pale wood.
     Index picked per particle from heat/cool phase minus a per-particle
     threshold, so the ignition sweeps through the body staggered. */
  var RAMP = ['#B7B1A8', '#D9AE85', '#F69455', '#FF8438', '#FFA05C', '#F6C48D', '#F1D6AF', '#EEDFC6', '#EDE2CE'];

  function makeSprites() {
    return RAMP.map(function (color) {
      var s = 64;
      var c = document.createElement('canvas');
      c.width = s; c.height = s;
      var g = c.getContext('2d');
      var grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      grad.addColorStop(0, color);
      grad.addColorStop(0.22, color);
      /* hex -> rgba for the soft tail */
      var r = parseInt(color.slice(1, 3), 16),
          gg = parseInt(color.slice(3, 5), 16),
          b = parseInt(color.slice(5, 7), 16);
      grad.addColorStop(0.55, 'rgba(' + r + ',' + gg + ',' + b + ',0.32)');
      grad.addColorStop(1, 'rgba(' + r + ',' + gg + ',' + b + ',0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, s, s);
      return c;
    });
  }

  function init() {
    var section = document.getElementById('story-scene');
    var track = document.getElementById('story-track');
    var canvas = document.getElementById('story-canvas');
    if (!section || !track || !canvas || REDUCED) return null;
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;

    var act0 = document.getElementById('story-act-0');
    var act1 = document.getElementById('story-act-1');
    var act2 = document.getElementById('story-act-2');
    var act3 = document.getElementById('story-act-3');
    var act4 = document.getElementById('story-act-4');
    var sub = document.getElementById('story-final-sub');
    var card = document.getElementById('story-card');
    var railFill = document.getElementById('story-rail-fill');

    /* Swap scene in, static fallback out. */
    section.style.display = 'block';
    var legacy = document.querySelectorAll('[data-story-legacy]');
    for (var li = 0; li < legacy.length; li++) legacy[li].style.display = 'none';

    /* ── canvas sizing ──────────────────────────────────────────────── */
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = 0, h = 0, stacked = false;
    function resize() {
      var nw = canvas.clientWidth, nh = canvas.clientHeight;
      if (nw === w && nh === h) return;
      w = nw; h = nh;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      stacked = w < 860;
    }
    resize();
    window.addEventListener('resize', resize);

    /* ── particles ──────────────────────────────────────────────────── */
    var rnd = window.__dcRandom || Math.random;
    var N = (window.innerWidth < 860 ? 2600 : 6500);
    var cloud = new Float32Array(N * 3);
    var target = new Float32Array(N * 3);
    var pSize = new Float32Array(N);
    var pPhase = new Float32Array(N);
    var pTw = new Float32Array(N);
    var pIg = new Float32Array(N);
    var pDrift = new Float32Array(N);
    var pDriftPh = new Float32Array(N);

    function gauss() { return (rnd() + rnd() + rnd() - 1.5) * 0.8165; }

    for (var i = 0; i < N; i++) {
      var j = i * 3;
      /* loose powder cloud: flattened ellipsoid */
      cloud[j] = gauss() * 1.9;
      cloud[j + 1] = gauss() * 1.12;
      cloud[j + 2] = gauss() * 1.12;

      /* blank: cylinder of half-height 1.2, radius 0.6 */
      var pick = rnd();
      var theta = rnd() * Math.PI * 2;
      var rr, yy;
      if (pick < 0.72) {            /* wall */
        rr = 0.6 + (rnd() - 0.5) * 0.03;
        yy = (rnd() * 2 - 1) * 1.2;
      } else if (pick < 0.84) {     /* caps */
        rr = 0.6 * Math.sqrt(rnd());
        yy = (rnd() < 0.5 ? -1 : 1) * (1.2 + (rnd() - 0.5) * 0.02);
      } else {                      /* interior fill, keeps the body dense */
        rr = 0.55 * Math.sqrt(rnd());
        yy = (rnd() * 2 - 1) * 1.2;
      }
      target[j] = Math.cos(theta) * rr;
      target[j + 1] = yy;
      target[j + 2] = Math.sin(theta) * rr;

      pSize[i] = 0.011 + rnd() * 0.015;
      pPhase[i] = rnd() * Math.PI * 2;
      pTw[i] = 0.6 + rnd() * 1.6;
      pIg[i] = rnd();
      pDrift[i] = 0.05 + rnd() * 0.12;
      pDriftPh[i] = rnd() * Math.PI * 2;
    }

    var sprites = makeSprites();

    /* ── pointer parallax ───────────────────────────────────────────── */
    var mx = 0, my = 0, smx = 0, smy = 0;
    function onMove(e) {
      var r = canvas.getBoundingClientRect();
      mx = ((e.clientX - r.left) / Math.max(1, r.width) - 0.5) * 2;
      my = ((e.clientY - r.top) / Math.max(1, r.height) - 0.5) * 2;
    }
    function onLeave() { mx = 0; my = 0; }
    section.addEventListener('mousemove', onMove);
    section.addEventListener('mouseleave', onLeave);

    /* ── visibility ─────────────────────────────────────────────────── */
    var visible = true;
    var io = new IntersectionObserver(function (entries) {
      visible = entries[0].isIntersecting;
    }, { rootMargin: '0px' });
    io.observe(track);

    /* ── per-frame state ────────────────────────────────────────────── */
    var t = 0, sp = 0, spin = 0, raf = 0, dead = false;
    var lastRail = -1;
    var panelPE = [null, null, null];

    function setPanel(el, o, base, dy, slotIdx) {
      el.style.opacity = String(Math.round(o * 1000) / 1000);
      el.style.transform = base + 'translateY(' + dy.toFixed(1) + 'px)';
      if (slotIdx == null) return;
      var pe = o > 0.6 ? 'auto' : 'none';
      if (panelPE[slotIdx] !== pe) { panelPE[slotIdx] = pe; el.style.pointerEvents = pe; }
    }

    function updatePanels() {
      /* hero: present from the start, lifts up and out early */
      var o0 = 1 - ease(clamp01((sp - 0.05) / 0.055));
      setPanel(act0, o0, '', -34 * (1 - o0));

      var base = stacked ? '' : 'translateY(-50%) ';
      var o1 = win(sp, 0.150, 0.210, 0.270, 0.330);
      setPanel(act1, o1, base, (sp < 0.27 ? 1 : -1) * 26 * (1 - o1), 0);
      var o2 = win(sp, 0.400, 0.460, 0.520, 0.580);
      setPanel(act2, o2, base, (sp < 0.52 ? 1 : -1) * 26 * (1 - o2), 1);
      var o3 = win(sp, 0.635, 0.695, 0.720, 0.775);
      setPanel(act3, o3, base, (sp < 0.72 ? 1 : -1) * 26 * (1 - o3), 2);

      var o4 = win(sp, 0.795, 0.860, 9, 10);
      setPanel(act4, o4, stacked ? '' : 'translateX(-50%) ', 26 * (1 - o4));
      var o5 = win(sp, 0.890, 0.945, 9, 10);
      setPanel(sub, o5, stacked ? '' : 'translateX(-50%) ', 18 * (1 - o5));

      /* Pure same-rect cross-fade with the particle blank (FADE runs the
         same 0.875-0.955 window): no scale/translate punch, just a develop
         from blur so the photo appears to come into focus out of the
         glowing silhouette. */
      var oc = ease(clamp01((sp - 0.875) / 0.08));
      card.style.opacity = String(Math.round(oc * 1000) / 1000);
      card.style.filter = oc >= 1 ? '' : 'blur(' + ((1 - oc) * 10).toFixed(1) + 'px)';

      if (railFill) {
        var pct = Math.round(sp * 1000) / 10;
        if (pct !== lastRail) { lastRail = pct; railFill.style.height = pct + '%'; }
      }
    }

    function roundRectPath(x, y, rw, rh, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + rw, y, x + rw, y + rh, r);
      ctx.arcTo(x + rw, y + rh, x, y + rh, r);
      ctx.arcTo(x, y + rh, x, y, r);
      ctx.arcTo(x, y, x + rw, y, r);
      ctx.closePath();
    }

    /* Solid blank: a shaded, softly-lit cylinder body that fades in as the
       piece cools, turning the particle swarm into a single object. */
    function drawSolid(cx, cy, ppu, cool, solid, fade, cardU) {
      var Rw = 0.6 * ppu, Hh = 1.2 * ppu;
      /* Morph toward the card's rect: 42vh x 56vh centred (33vh x 44vh at
         45% top when stacked — #story-card / #story-card-frame in the page
         stylesheet). */
      if (cardU > 0) {
        var cRw = (stacked ? 0.165 : 0.21) * h;
        var cHh = (stacked ? 0.22 : 0.28) * h;
        cx += (0.5 * w - cx) * cardU;
        cy += ((stacked ? 0.45 : 0.50) * h - cy) * cardU;
        Rw += (cRw - Rw) * cardU;
        Hh += (cHh - Hh) * cardU;
      }
      var bx = cx - Rw, by = cy - Hh, bw = Rw * 2, bh = Hh * 2;
      var rad = Rw * 0.22 * (1 - cardU) + 24 * cardU;
      var col = mixRGB(hexRGB('#FF8438'), hexRGB('#EBDABC'), ease(cool));
      var base = Math.min(1, solid) * fade;
      /* Scene dressing (halo, ground shadow, open top) belongs to the free
         blank, so it lifts as the body settles into the photo card. */
      var dress = base * (1 - cardU);

      if (dress > 0.01) {
        var halo = ctx.createRadialGradient(cx, cy, Hh * 0.2, cx, cy, Hh * 2.1);
        halo.addColorStop(0, 'rgba(255,190,120,0.20)');
        halo.addColorStop(1, 'rgba(255,190,120,0)');
        ctx.globalAlpha = dress;
        ctx.fillStyle = halo;
        ctx.fillRect(cx - Hh * 2.1, cy - Hh * 2.1, Hh * 4.2, Hh * 4.2);

        var shy = by + bh + Rw * 0.10;
        var sh = ctx.createRadialGradient(cx, shy, 0, cx, shy, Rw * 1.45);
        sh.addColorStop(0, 'rgba(0,0,0,0.5)');
        sh.addColorStop(0.7, 'rgba(0,0,0,0.18)');
        sh.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.globalAlpha = dress;
        ctx.fillStyle = sh;
        ctx.beginPath();
        ctx.ellipse(cx, shy, Rw * 1.45, Rw * 0.30, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      /* body: horizontal form shading */
      ctx.globalAlpha = base;
      var grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
      grad.addColorStop(0, cssRGB(col, 0.52));
      grad.addColorStop(0.22, cssRGB(col, 0.98));
      grad.addColorStop(0.5, cssRGB(col, 1.1));
      grad.addColorStop(0.8, cssRGB(col, 0.92));
      grad.addColorStop(1, cssRGB(col, 0.48));
      ctx.fillStyle = grad;
      roundRectPath(bx, by, bw, bh, rad);
      ctx.fill();

      /* vertical studio light: lit crown, shaded foot */
      var vg = ctx.createLinearGradient(0, by, 0, by + bh);
      vg.addColorStop(0, 'rgba(255,251,242,0.30)');
      vg.addColorStop(0.3, 'rgba(255,251,242,0)');
      vg.addColorStop(0.72, 'rgba(24,12,6,0)');
      vg.addColorStop(1, 'rgba(24,12,6,0.30)');
      ctx.fillStyle = vg;
      roundRectPath(bx, by, bw, bh, rad);
      ctx.fill();

      /* rim light along the left edge */
      var rg = ctx.createLinearGradient(bx, 0, bx + bw * 0.14, 0);
      rg.addColorStop(0, 'rgba(255,255,250,0.42)');
      rg.addColorStop(1, 'rgba(255,255,250,0)');
      ctx.fillStyle = rg;
      roundRectPath(bx, by, bw, bh, rad);
      ctx.fill();

      /* top face — a soft domed lip rather than a flat disc */
      if (cardU < 0.99) {
        ctx.globalAlpha = base * (1 - cardU);
        var tg = ctx.createRadialGradient(cx, by, 0, cx, by, Rw);
        tg.addColorStop(0, cssRGB(col, 0.88));
        tg.addColorStop(0.68, cssRGB(col, 1.04));
        tg.addColorStop(1, cssRGB(col, 1.22));
        ctx.fillStyle = tg;
        ctx.beginPath();
        ctx.ellipse(cx, by, Rw, Rw * 0.16, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    function draw(morph, cxF, cyF, scale, heat, cool, fade, solid, cardU) {
      ctx.clearRect(0, 0, w, h);
      var ppu = ((stacked ? w * 0.85 : h * 0.40) / 2.4) * scale;
      var cx = cxF * w + smx * 10;
      var cy = cyF * h + smy * 8;
      var rotY = spin + smx * 0.10;
      var rotX = 0.10 + smy * 0.06;
      var cosY = Math.cos(rotY), sinY = Math.sin(rotY);
      var cosX = Math.cos(rotX), sinX = Math.sin(rotX);
      var F = 3.4;
      var wob = 1 - morph * 0.85;

      if (solid > 0.01) drawSolid(cx, cy, ppu, cool, solid, fade, cardU);
      var tex = 1 - solid * 0.55;

      for (var i = 0; i < N; i++) {
        var j = i * 3;
        var wobA = Math.sin(t * 0.9 + pDriftPh[i]) * pDrift[i] * wob;
        var wobB = Math.cos(t * 0.7 + pDriftPh[i] * 1.7) * pDrift[i] * wob;
        var x = cloud[j] + (target[j] - cloud[j]) * morph + wobA;
        var y = cloud[j + 1] + (target[j + 1] - cloud[j + 1]) * morph + wobB;
        var z = cloud[j + 2] + (target[j + 2] - cloud[j + 2]) * morph + wobA * 0.6;

        var x2 = x * cosY + z * sinY;
        var z2 = -x * sinY + z * cosY;
        var y2 = y * cosX - z2 * sinX;
        var z3 = y * sinX + z2 * cosX;

        var persp = F / (F + z3);
        var sx = cx + x2 * persp * ppu;
        var sy = cy + y2 * persp * ppu;

        var hu = clamp01(heat * 1.5 - pIg[i] * 0.5);
        var cu = clamp01(cool * 1.5 - pIg[i] * 0.5);
        var idx = ((hu * 0.375 + cu * 0.625) * 8 + 0.5) | 0;

        var a = (0.42 + 0.58 * (0.5 + 0.5 * Math.sin(t * pTw[i] + pPhase[i]))) * fade * Math.min(1, persp * 0.8) * 0.92 * tex;
        if (a < 0.02) continue;
        var s = pSize[i] * persp * ppu * 3.4;
        if (s < 1.6) s = 1.6;

        ctx.globalAlpha = a > 1 ? 1 : a;
        ctx.drawImage(sprites[idx], sx - s * 0.5, sy - s * 0.5, s, s);
      }
      ctx.globalAlpha = 1;
    }

    function frame() {
      if (dead) return;
      raf = requestAnimationFrame(frame);
      t += 0.016;

      var vh = window.innerHeight;
      var total = track.offsetHeight - vh;
      var tp = total > 0 ? clamp01(-track.getBoundingClientRect().top / total) : 0;
      sp += (tp - sp) * 0.10;
      if (Math.abs(tp - sp) < 0.0004) sp = tp;
      spin += kf(SPIN, sp) * 0.016;
      smx += (mx - smx) * 0.05;
      smy += (my - smy) * 0.05;

      updatePanels();
      /* Same contract as the home hero: state advances even while
         off-screen so scrolling back lands on the right frame; only the
         raster is skipped. */
      if (!visible) return;
      /* Mobile keeps the body centred — panels stack below it instead. */
      draw(kf(MORPH, sp), stacked ? 0.5 : kf(CX_SIDE, sp), kf(stacked ? CY_STACK : CY_SIDE, sp),
        kf(SCALE, sp), kf(HEAT, sp), kf(COOL, sp), kf(FADE, sp), kf(SOLID, sp), kf(CARD, sp));
    }

    updatePanels();
    frame();

    return function destroy() {
      dead = true;
      cancelAnimationFrame(raf);
      io.disconnect();
      window.removeEventListener('resize', resize);
      section.removeEventListener('mousemove', onMove);
      section.removeEventListener('mouseleave', onLeave);
      section.style.display = 'none';
      for (var li = 0; li < legacy.length; li++) legacy[li].style.display = '';
    };
  }

  window.StoryScene = { init: init };
})();

/* Brand story page: scroll-driven particle scene + reveal-on-scroll.
   StoryScene.init() lives in Hardnest官网/story-scene.js, which build.mjs
   inlines ahead of this file. It returns null when the scene should stay
   hidden (reduced motion, no canvas), leaving the static fallback. */
(function () {
  'use strict';
  window.DC.ready(function () {
    if (window.StoryScene) window.StoryScene.init();
    window.DC.reveal(0.12, '0px 0px -60px 0px');
    window.DC.suspendOffscreenAnimations();
  });
})();
