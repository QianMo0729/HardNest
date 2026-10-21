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

/* Contact page: identity cards, form state, submit gate.
   Mirrors Contact.dc.html — including the ?type= / ?product= prefill and
   the "name and contact must both be non-empty" submit rule. */
(function () {
  'use strict';
  var DC = window.DC;

  var IDENTITY = { customer: '个人用户', dealer: '经销商加盟', media: '媒体合作' };
  var PRODUCTS = { yan: '岩', xue: '穴', jie: '阶', wan: '湾' };
  var ACT_IDENTITY = {
    setIdentityCustomer: '个人用户',
    setIdentityDealer: '经销商加盟',
    setIdentityMedia: '媒体合作'
  };

  DC.ready(function () {
    DC.reveal(0.1, '0px');

    var nameEl = document.querySelector('[data-act="onNameChange"]');
    var contactEl = document.querySelector('[data-act="onContactChange"]');
    var messageEl = document.querySelector('[data-act="onMessageChange"]');
    var submitEl = document.querySelector('[data-act="onSubmit"]');

    var identity = '个人用户';

    try {
      var params = new URLSearchParams(window.location.search);
      var type = params.get('type');
      var product = params.get('product');
      var color = params.get('color');
      if (type && IDENTITY[type]) identity = IDENTITY[type];
      if (product && PRODUCTS[product] && messageEl) {
        messageEl.value = '我对「' + PRODUCTS[product] + '」' +
          (color ? '（' + color + '）' : '') + '感兴趣，想了解更多。';
      }
    } catch (e) { /* no-op */ }
    DC.applyGroup('identity', identity);

    Object.keys(ACT_IDENTITY).forEach(function (act) {
      DC.on(act, 'click', function () {
        identity = ACT_IDENTITY[act];
        DC.applyGroup('identity', identity);
      });
    });

    function canSubmit() {
      return !!(nameEl && contactEl &&
        nameEl.value.trim().length > 0 && contactEl.value.trim().length > 0);
    }
    function syncSubmit() {
      var ok = canSubmit();
      if (!submitEl) return;
      DC.applyOne(submitEl, String(ok));
      if (ok) submitEl.removeAttribute('disabled');
      else submitEl.setAttribute('disabled', '');
    }
    [nameEl, contactEl].forEach(function (el) {
      if (el) el.addEventListener('input', syncSubmit);
    });
    syncSubmit();

    if (submitEl) {
      submitEl.addEventListener('click', function () {
        if (!canSubmit()) return;
        DC.setIf('submitted', true);
        DC.setIf('notSubmitted', false);
      });
    }
    DC.on('resetForm', 'click', function () {
      if (nameEl) nameEl.value = '';
      if (contactEl) contactEl.value = '';
      if (messageEl) messageEl.value = '';
      syncSubmit();
      DC.setIf('submitted', false);
      DC.setIf('notSubmitted', true);
    });

    DC.suspendOffscreenAnimations();
  });
})();
