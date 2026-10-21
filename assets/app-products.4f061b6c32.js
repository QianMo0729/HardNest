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

/* Products page: sticky sub-nav pills + per-product colour swatches.
   Thresholds copied from Products.dc.html setupSubnav(). */
(function () {
  'use strict';
  var DC = window.DC;
  var PID = { Yan: 'p-yan', Xue: 'p-xue', Jie: 'p-jie', Wan: 'p-wan' };
  var PRODKEY = { Yan: 'yan', Xue: 'xue', Jie: 'jie', Wan: 'wan' };
  /* Mirrors the colorMap in Products.dc.html renderVals(). */
  var NAMES = {
    Yan: ['米白', '暖沙', '墨黑'],
    Xue: ['米白', '云雾灰', '墨黑'],
    Jie: ['米白', '麻棕', '墨黑'],
    Wan: ['米白', '驼棕', '墨黑']
  };

  DC.ready(function () {
    DC.reveal(0.12, '0px 0px -60px 0px');

    var active = 'p-yan';
    var sub = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting && entry.target.id !== active) {
          active = entry.target.id;
          DC.applyGroup('sec', active);
        }
      });
    }, { threshold: 0, rootMargin: '-40% 0px -55% 0px' });

    Object.keys(PID).forEach(function (k) {
      var el = document.getElementById(PID[k]);
      if (el) sub.observe(el);
    });

    /* Sticky filter bar follows the nav: nav.js hides the fixed header on
       downward scroll (same 80 / ±4 thresholds), and the bar's sticky top
       must drop from 74px to 0 with it or the bar hangs in mid-air. The
       0.5s top transition in the variant styles keeps the two in sync. */
    var navHidden = false;
    var lastNavY = window.scrollY || 0;
    var navTicking = false;
    window.addEventListener('scroll', function () {
      if (navTicking) return;
      navTicking = true;
      requestAnimationFrame(function () {
        var y = window.scrollY || 0;
        var next = navHidden;
        if (y < 80) next = false;
        else if (y > lastNavY + 4) next = true;
        else if (y < lastNavY - 4) next = false;
        if (next !== navHidden) {
          navHidden = next;
          DC.applyGroup('subnav', String(navHidden));
        }
        lastNavY = y;
        navTicking = false;
      });
    }, { passive: true });

    /* Swatches. selected[] starts empty and swatchStyle() treats a missing
       entry as index 0, which is the state the build already rendered.
       A pick also lands on the colourway label and the CTA link, so the
       choice follows the visitor into the contact form prefill. */
    document.querySelectorAll('[data-act^="select"]').forEach(function (btn) {
      var m = /^select(Yan|Xue|Jie|Wan)(\d+)$/.exec(btn.getAttribute('data-act'));
      if (!m) return;
      var group = PID[m[1]];
      var idx = m[2];
      btn.addEventListener('click', function () {
        DC.applyGroup(group, idx);
        var name = NAMES[m[1]][Number(idx)];
        var key = PRODKEY[m[1]];
        var label = document.querySelector('[data-color-name="' + key + '"]');
        if (label) label.textContent = name;
        var cta = document.querySelector('[data-cta="' + key + '"]');
        if (cta) {
          cta.setAttribute('href', 'contact.html?type=customer&product=' + key +
            '&color=' + encodeURIComponent(name));
        }
      });
    });

    DC.suspendOffscreenAnimations();
  });
})();
