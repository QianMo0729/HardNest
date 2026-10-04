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
