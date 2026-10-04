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
