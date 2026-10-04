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

/* Home page: hero canvas, cursor glow, parallax/progress scroll, reveal
   frame, card tilt, magnetic buttons.

   Behavioural contract with Home.dc.html: every constant, easing, threshold
   and draw order below is copied from the original. What changed is *when*
   work happens, not what it produces. */
(function () {
  'use strict';
  var DC = window.DC;
  var CFG = window.__DCCFG || {};

  /* ── one rAF driver for the whole page ─────────────────────────────── */
  var tasks = [];
  var rafId = 0;
  function tick() {
    rafId = 0;
    var alive = false;
    for (var i = 0; i < tasks.length; i++) { if (tasks[i]()) alive = true; }
    if (alive) rafId = requestAnimationFrame(tick);
  }
  function kick() { if (!rafId) rafId = requestAnimationFrame(tick); }

  DC.ready(function () {
    var hero = document.getElementById('hero');
    var glow = document.getElementById('cursor-glow');
    var canvas = document.getElementById('hero-particles');
    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* Shared hero pointer state. The original attached two separate
       mousemove listeners to #hero, each calling getBoundingClientRect().
       #hero is position:relative with no padding/border and the canvas is
       inset:0 inside it, so the two rects were always identical — one
       measurement now feeds both consumers, in the original order. */
    var mouse = { x: -9999, y: -9999 };
    var glowTx = 0, glowTy = 0, glowCx = 0, glowCy = 0;

    if (hero) {
      hero.addEventListener('mousemove', function (e) {
        var r = hero.getBoundingClientRect();
        var lx = e.clientX - r.left;
        var ly = e.clientY - r.top;
        glowTx = lx; glowTy = ly;   // was setupCursorGlow's _onMouseMove
        mouse.x = lx; mouse.y = ly; // was setupParticles' _onPMove
        kick();
      });
      hero.addEventListener('mouseleave', function () {
        mouse.x = -9999; mouse.y = -9999;
      });
    }

    /* ── cursor glow ──────────────────────────────────────────────────
       Same 0.055 lerp. The original ran this rAF forever, writing
       identical left/top strings 60x a second for the life of the page —
       and on a touch device, where mousemove never fires, cx/cy start
       already equal to tx/ty, so every one of those frames was writing a
       value that never changed.

       Now the loop only runs while it has somewhere to go. It stops when
       the remaining distance is under 1/256 px, which is below the 1/64 px
       layout quantum, so the resting position rasterises to the same pixel
       the asymptote would have. */
    var EPS = 1 / 256;
    if (hero && glow) {
      glowTx = hero.clientWidth / 2;
      glowTy = hero.clientHeight * 0.42;
      glowCx = glowTx; glowCy = glowTy;
      glow.style.left = glowCx + 'px';
      glow.style.top = glowCy + 'px';

      tasks.push(function glowTask() {
        var dx = glowTx - glowCx, dy = glowTy - glowCy;
        if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) return false;
        glowCx += dx * 0.055;
        glowCy += dy * 0.055;
        glow.style.left = glowCx + 'px';
        glow.style.top = glowCy + 'px';
        return true;
      });
    }

    /* ── hero particles ───────────────────────────────────────────────── */
    if (canvas && hero && !reduced) {
      var ctx = canvas.getContext('2d');
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var w = 0, h = 0;

      function resize() {
        var nw = canvas.clientWidth, nh = canvas.clientHeight;
        /* Mobile URL-bar show/hide fires resize with an unchanged box.
           Reassigning canvas.width there would reallocate the backing
           store and clear it for no reason, mid-scroll. */
        if (nw === w && nh === h) return;
        w = nw; h = nh;
        canvas.width = w * dpr; canvas.height = h * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      resize();
      window.addEventListener('resize', resize);

      var rnd = window.__dcRandom;
      var N = window.innerWidth < 720 ? 34 : 62;
      var parts = [];
      for (var i = 0; i < N; i++) {
        parts.push({
          x: rnd(), y: rnd(),
          r: 0.7 + rnd() * 1.7,
          vy: 0.0001 + rnd() * 0.00032,
          sway: 0.4 + rnd() * 1.1,
          phase: rnd() * Math.PI * 2,
          tw: 0.6 + rnd() * 1.4,
          px: 0, py: 0
        });
      }

      /* Optional sprite atlas: one pre-rendered dot+glow per particle at
         its exact radius, replacing 62 shadowBlur fills per frame with 62
         drawImage calls. Not byte-identical — compositing a pre-baked
         shape-over-shadow and then scaling by globalAlpha differs from
         scaling source alpha before the blur — so it stays opt-in. */
      var sprites = null;
      if (CFG.particleSprites) {
        sprites = parts.map(function (p) {
          var pad = 9 * 1.5 + p.r + 2;
          var size = Math.ceil(pad * 2);
          var c = document.createElement('canvas');
          c.width = size * dpr; c.height = size * dpr;
          var g = c.getContext('2d');
          g.setTransform(dpr, 0, 0, dpr, 0, 0);
          g.beginPath();
          g.arc(pad, pad, p.r, 0, Math.PI * 2);
          g.fillStyle = 'rgba(255,142,64,1)';
          g.shadowColor = 'rgba(255,103,20,0.85)';
          g.shadowBlur = 9;
          g.fill();
          return { canvas: c, pad: pad, size: size };
        });
      }

      var visible = true;
      new IntersectionObserver(function (entries) {
        visible = entries[0].isIntersecting;
      }, { rootMargin: '0px' }).observe(hero);

      var t = 0;
      tasks.push(function particleTask() {
        t += 0.016;
        for (var i = 0; i < parts.length; i++) {
          var p = parts[i];
          p.y -= p.vy;
          if (p.y < -0.04) { p.y = 1.04; p.x = rnd(); }
          p.px = p.x * w + Math.sin(t * p.sway + p.phase) * 18;
          p.py = p.y * h;
        }

        /* Off-screen: state still advances at exactly the same rate, so
           scrolling back lands on the frame it would have reached. Only
           the raster is skipped — and because the canvas bitmap stops
           changing, the mix-blend-mode:screen / overlay layers stacked on
           top of it stop being recomposited too. */
        if (!visible) return true;

        ctx.clearRect(0, 0, w, h);
        ctx.lineWidth = 1;

        for (var a = 0; a < parts.length; a++) {
          var pa = parts[a];
          for (var b = a + 1; b < parts.length; b++) {
            var pb = parts[b];
            var ddx = pa.px - pb.px, ddy = pa.py - pb.py;
            var dd = ddx * ddx + ddy * ddy;
            if (dd < 8100) {
              ctx.strokeStyle = 'rgba(255,132,56,' + ((1 - Math.sqrt(dd) / 90) * 0.1) + ')';
              ctx.beginPath(); ctx.moveTo(pa.px, pa.py); ctx.lineTo(pb.px, pb.py); ctx.stroke();
            }
          }
        }

        /* shadowColor was reassigned to the same literal on every particle
           in the original; hoisting it costs 62 fewer colour parses a frame
           and cannot change output because shadowBlur is 0 for the strokes. */
        ctx.shadowColor = 'rgba(255,103,20,0.85)';

        for (var k = 0; k < parts.length; k++) {
          var p2 = parts[k];
          var alpha = 0.22 + 0.34 * (0.5 + 0.5 * Math.sin(t * p2.tw + p2.phase * 2));
          if (sprites) {
            var s = sprites[k];
            ctx.globalAlpha = alpha;
            ctx.drawImage(s.canvas, p2.px - s.pad, p2.py - s.pad, s.size, s.size);
            ctx.globalAlpha = 1;
          } else {
            ctx.beginPath();
            ctx.arc(p2.px, p2.py, p2.r, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255,142,64,' + alpha + ')';
            ctx.shadowBlur = 9;
            ctx.fill();
            ctx.shadowBlur = 0;
          }
          var mdx = p2.px - mouse.x, mdy = p2.py - mouse.y;
          var md = mdx * mdx + mdy * mdy;
          if (md < 22500) {
            ctx.strokeStyle = 'rgba(255,132,56,' + ((1 - Math.sqrt(md) / 150) * 0.24) + ')';
            ctx.beginPath(); ctx.moveTo(p2.px, p2.py); ctx.lineTo(mouse.x, mouse.y); ctx.stroke();
          }
        }
        return true;
      });
    }
    kick();

    /* ── scroll-driven effects ────────────────────────────────────────
       Identical maths to setupScroll(); the only change is that every
       read now happens before every write. The original interleaved them
       (transform write -> scrollHeight read -> width write ->
       getBoundingClientRect read), forcing two synchronous layouts per
       scroll frame. None of those writes can affect any of those reads:
       the progress bar is position:fixed, transforms do not affect
       layout, and both section heights are fixed at 210vh/100vh. */
    var bg = document.getElementById('hero-parallax-bg');
    var bar = document.getElementById('scroll-progress');
    var sec = document.getElementById('reveal-sec');
    var frame = document.getElementById('reveal-frame');
    var copy = document.getElementById('reveal-copy');
    var scrollTicking = false;

    function updateScroll() {
      // ── reads ──
      var y = window.scrollY || 0;
      var vh = window.innerHeight;
      var max = document.documentElement.scrollHeight - vh;
      var rectTop = 0, secH = 0;
      if (sec && frame) {
        rectTop = sec.getBoundingClientRect().top;
        secH = sec.offsetHeight;
      }

      // ── writes ──
      if (bg) bg.style.transform = 'scale(1.12) translateY(' + (Math.min(y, 900) * 0.16) + 'px)';
      if (bar) {
        var frac = max > 0 ? y / max : 0;
        if (CFG.progressTransform) bar.style.transform = 'scaleX(' + frac + ')';
        else bar.style.width = (frac * 100) + '%';
      }
      if (sec && frame) {
        var total = secH - vh;
        var p = total > 0 ? (-rectTop) / total : 0;
        p = Math.max(0, Math.min(1, p));
        var eased = Math.min(1, p / 0.6);
        frame.style.transform = 'scale(' + (0.68 + 0.32 * eased) + ')';
        frame.style.borderRadius = (44 - 44 * eased) + 'px';
        if (copy) copy.style.opacity = String(Math.max(0, Math.min(1, (p - 0.28) / 0.3)));
      }
      scrollTicking = false;
    }

    window.addEventListener('scroll', function () {
      if (scrollTicking) return;
      scrollTicking = true;
      requestAnimationFrame(updateScroll);
    }, { passive: true });
    updateScroll();

    DC.reveal(0.12, '0px 0px -60px 0px');

    /* ── card tilt ────────────────────────────────────────────────────
       getBoundingClientRect() is deliberately re-read on every move. The
       card already carries the previous move's translateY/rotateX/rotateY,
       so the rect includes that transform and the tilt is a feedback loop.
       Caching the rect on mouseenter would change the response curve. */
    document.querySelectorAll('[data-card]').forEach(function (card) {
      var img = card.querySelector('[data-card-img]');
      card.addEventListener('mouseenter', function () {
        card.style.boxShadow = '0 30px 60px rgba(20,19,18,0.14)';
        if (img) img.style.transform = 'scale(1.06)';
      });
      card.addEventListener('mousemove', function (e) {
        var r = card.getBoundingClientRect();
        var px = (e.clientX - r.left) / r.width - 0.5;
        var py = (e.clientY - r.top) / r.height - 0.5;
        card.style.transform = 'translateY(-8px) perspective(900px) rotateX(' +
          (-py * 5).toFixed(2) + 'deg) rotateY(' + (px * 5).toFixed(2) + 'deg)';
      });
      card.addEventListener('mouseleave', function () {
        card.style.transform = 'translateY(0)';
        card.style.boxShadow = 'none';
        if (img) img.style.transform = 'scale(1)';
      });
    });

    /* ── magnetic buttons ─────────────────────────────────────────────── */
    if (!reduced) {
      document.querySelectorAll('[data-magnetic]').forEach(function (el) {
        el.addEventListener('mousemove', function (e) {
          var r = el.getBoundingClientRect();
          var dx = e.clientX - (r.left + r.width / 2);
          var dy = e.clientY - (r.top + r.height / 2);
          el.style.transform = 'translate(' + (dx * 0.16).toFixed(1) + 'px, ' +
            (dy * 0.22).toFixed(1) + 'px)';
        });
        el.addEventListener('mouseleave', function () { el.style.transform = 'translate(0,0)'; });
      });
    }

    DC.suspendOffscreenAnimations();
  });
})();
