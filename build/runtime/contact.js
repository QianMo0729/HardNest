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
