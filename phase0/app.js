// Phase 0 probe page logic. Plain DOM, no framework, no build step.
const $ = (id) => document.getElementById(id);
const set = (id, text) => { $(id).textContent = text; };

// 1. Display mode
{
  const standalone =
    matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  set('display-mode', standalone
    ? 'Standalone / installed web app \u2713'
    : 'Browser tab (not installed, or opened in Safari)');
}

// 2. Service worker registration state
(async () => {
  if (!('serviceWorker' in navigator)) {
    set('sw-status', 'service worker unsupported in this browser');
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    set('sw-status', `registered \u2713 (scope ${reg.scope})`);
    const worker = reg.active ?? reg.waiting ?? reg.installing;
    if (worker) set('sw-detail', `current state: ${worker.state}`);
    await navigator.serviceWorker.ready;
    set('sw-detail', `active and controlling this page \u2713`);
  } catch (err) {
    set('sw-status', `registration failed: ${err}`);
  }
})();

// 3. Notifications & push
function urlBase64ToUint8Array(b64) {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function subscribePush() {
  const { publicKey } = await (await fetch('/vapid-public')).json();
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });
  const res = await fetch('/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(sub),
  });
  if (!res.ok) throw new Error(`/subscribe answered ${res.status}`);
  return sub;
}

$('enable-push').addEventListener('click', async () => {
  if (!('Notification' in window) || !('PushManager' in window)) {
    set('push-status', 'notifications/push unsupported in this browser');
    return;
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    set('push-status', `permission: ${perm}. On iOS this only works in the installed app.`);
    return;
  }
  try {
    const sub = await subscribePush();
    const host = new URL(sub.endpoint).host;
    set('push-status', `subscribed \u2713 (push service ${host}, permission granted)`);
  } catch (err) {
    set('push-status', `subscribe failed: ${err}`);
  }
});

let pushTimer = null;
$('test-push').addEventListener('click', async () => {
  try {
    const res = await fetch('/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ delayMs: 10000 }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      set('push-status', `cannot send test push: ${res.status} ${body.error ?? ''}`);
      return;
    }
    const sendAt = Date.parse((await res.json()).sendAt);
    set('push-status', 'push scheduled \u2014 lock the phone now');
    clearInterval(pushTimer);
    pushTimer = setInterval(() => {
      const left = Math.max(0, Math.ceil((sendAt - Date.now()) / 1000));
      if (left > 0) set('push-status', `push fires in ${left} s \u2014 lock the phone now`);
      else { clearInterval(pushTimer); set('push-status', 'push sent; check lock screen / notification center'); }
    }, 500);
  } catch (err) {
    set('push-status', `failed to schedule push: ${err}`);
  }
});

// 4. Badge
function badgeAction(fn, label) {
  if (!('setAppBadge' in navigator)) {
    set('badge-status', 'Badging API unsupported in this browser');
    return;
  }
  fn.call(navigator).then(
    () => set('badge-status', `${label} \u2713 \u2014 go look at the home-screen icon`),
    (err) => set('badge-status', `${label} failed: ${err}`),
  );
}
$('badge-1').addEventListener('click', () => badgeAction(navigator.setAppBadge, 'set badge to 1'));
$('badge-3').addEventListener('click', () => badgeAction(navigator.setAppBadge, 'set badge to 3'));
$('badge-clear').addEventListener('click', () => badgeAction(navigator.clearAppBadge, 'cleared badge'));

// 5. Cookie jar
function readCookie(name) {
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function renderJar() {
  const cookie = readCookie('probe_token');
  set('jar-cookie', cookie ? `<token: ${cookie}>` : '(no cookie set in this jar)');
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem('probe_token')); } catch { /* ignore */ }
  set('jar-local', stored
    ? `<token: ${stored.token}, set ${new Date(stored.ts).toLocaleString()}>`
    : '(nothing in localStorage in this jar)');
}

$('jar-set').addEventListener('click', () => {
  const token = crypto.randomUUID();
  const ts = Date.now();
  document.cookie = `probe_token=${token}; max-age=31536000; path=/; SameSite=Strict`;
  localStorage.setItem('probe_token', JSON.stringify({ token, ts }));
  renderJar();
  set('jar-status', `token set at ${new Date(ts).toLocaleTimeString()} \u2014 now open this page in the other jar (Safari vs installed app)`);
});

renderJar();
