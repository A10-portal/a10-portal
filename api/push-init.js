// Mova99 Push Notification Permission
// Add this to api/push-notification.js as a public script
// Or include via <script src="/push-init.js"></script> on any page

(function() {
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  async function registerPush() {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
      const reg = await navigator.serviceWorker.ready;
      const existing = await reg.pushManager.getSubscription();
      if (existing) return;
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return;
      const vapidKey = 'BKDaWm4VMC4Gz8UZH4MZNCUgeXDBY3mEnhy9YKhxZxpRf0JpNhLQwn8fwKxqzN_4Qq4yUXKcoMJXJie9iEgrkoI';
      const subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey)
      });
      const session = JSON.parse(localStorage.getItem('foundry_session') || 'null');
      await fetch('/api/push-notification?action=register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: JSON.stringify(subscription),
          userId: session?.id || ''
        })
      });
    } catch(e) {
      console.log('Push:', e.message);
    }
  }

  // Run on load
  window.addEventListener('load', registerPush);

  // Also run on first user interaction
  document.addEventListener('click', function onFirstClick() {
    registerPush();
    document.removeEventListener('click', onFirstClick);
  }, { once: true });
})();
