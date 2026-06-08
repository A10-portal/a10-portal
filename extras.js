// Guest checkout auth modal
(function() {
  function showAuthModal() {
    var ex = document.getElementById('auth-modal');
    if (ex) ex.remove();
    localStorage.setItem('mova_cart', JSON.stringify(window.cart || []));
    var m = document.createElement('div');
    m.id = 'auth-modal';
    m.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;padding:20px';
    m.innerHTML = '<div style="background:#fff;border-radius:16px;max-width:380px;width:100%;overflow:hidden">'
      + '<div style="background:#111;padding:20px;text-align:center;border-bottom:3px solid #ff6100">'
      + '<div style="font-size:20px;font-weight:900;font-style:italic;color:#ff6100">Mova99</div>'
      + '<div style="font-size:12px;color:#fff;margin-top:4px;opacity:.7">Sign in to complete your order</div>'
      + '</div>'
      + '<div style="padding:24px;display:flex;flex-direction:column;gap:10px">'
      + '<a href="/login?redirect=index" style="display:block;padding:13px;background:#ff6100;color:#fff;border-radius:10px;font-size:14px;font-weight:800;text-align:center;text-decoration:none">Login to My Account</a>'
      + '<a href="/signup?redirect=index" style="display:block;padding:13px;background:#111;color:#fff;border-radius:10px;font-size:14px;font-weight:800;text-align:center;text-decoration:none">Create Free Account</a>'
      + '<button onclick="document.getElementById(\'auth-modal\').remove()" style="padding:10px;background:transparent;color:#aaa;border:none;font-size:12px;cursor:pointer;font-family:inherit">Cancel</button>'
      + '</div></div>';
    document.body.appendChild(m);
  }

  // Intercept checkout button click
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('button');
    if (!btn) return;
    if (btn.textContent.trim().toLowerCase().indexOf('checkout') === -1) return;
    var session = JSON.parse(localStorage.getItem('foundry_session') || 'null');
    if (!session || !session.id) {
      e.stopImmediatePropagation();
      if (typeof closeCartDrawer === 'function') closeCartDrawer();
      showAuthModal();
    }
  }, true);

  // Auto open product from ?pid= URL
  var pid = new URLSearchParams(window.location.search).get('pid');
  if (pid) {
    var n = 0;
    var t = setInterval(function() {
      if (window.PRODUCT_REG && window.PRODUCT_REG[pid]) {
        clearInterval(t);
        if (typeof openModal === 'function') openModal(pid);
      }
      if (++n > 40) clearInterval(t);
    }, 300);
  }
})();
