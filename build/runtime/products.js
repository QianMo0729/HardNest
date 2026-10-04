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
