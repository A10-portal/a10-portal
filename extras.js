// Guest checkout auth modal
window._origDoCheckout = window.doCheckout;
document.addEventListener('DOMContentLoaded', function() {
  var btn = document.querySelector('#cart-items button');
  if (btn) {
    btn.addEventListener('click', function() {
      var session = JSON.parse(localStorage.getItem('foundry_session') || 'null');
      if (!session?.id) {
        var m = document.createElement('div');
        m.id = 'auth-modal';
        m.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.65);display:flex;align-items:center;justify-content:center;padding:20px';
        m.innerHTML = '<div style="background:#fff;border-radius:16px;max-width:380px;width:100%;overflow:hidden"><div style="background:#111;padding:20px;text-align:center;border-bottom:3px solid #ff6100"><div style="font-size:20px;font-weight:900;color:#ff6100">Mova99</div></div><div style="padding:24px;display:flex;flex-direction:column;gap:10px"><a href="/login" style="display:block;padding:13px;background:#ff6100;color:#fff;border-radius:10px;font-size:14px;font-weight:800;text-align:center;text-decoration:none">Login</a><a href="/signup" style="display:block;padding:13px;background:#111;color:#fff;border-radius:10px;font-size:14px;font-weight:800;text-align:center;text-decoration:none">Create Account</a><button onclick="this.closest(\'#auth-modal\').remove()" style="padding:10px;background:transparent;color:#aaa;border:none;font-size:12px;cursor:pointer">Cancel</button></div></div>';
        document.body.appendChild(m);
      }
    });
  }
});
