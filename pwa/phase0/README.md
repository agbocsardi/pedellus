# Phase 0 probe

Throwaway page to check, on the owner's iPhone, the things the plan marks
unverified: **Web Push from a `ts.net` origin in an installed home-screen web
app**, **the app icon badge**, and **the installed app's cookie jar being
separate from Safari's**. No build step; delete the directory when phase 0 is
done.

## Run it

```sh
cd phase0
npm install          # installs web-push@4.0.0 (pinned in package.json)
node server.mjs       # 127.0.0.1:8790 by default; or: node server.mjs 9000 / PORT=9000
```

The server generates a VAPID key pair into `phase0/.data/vapid.json` (mode
`0600`) on first run, stores the phone's push subscription in
`phase0/.data/subscription.json` (mode `0600`), and logs every request plus the
result of each push attempt to the terminal — keep the terminal visible while
testing.

Then publish it (you run this, not the agent):

```sh
tailscale serve --bg 8790
```

Open the `https://<machine>.<tailnet>.ts.net/` URL in Safari **on the phone**
(over the tailnet, same as any other tailnet use).

## Checklist

Install first: in Safari, **Share → Add to Home Screen**, then open the app
from the home screen. Everything below happens in the installed app unless it
says otherwise.

1. **Display mode** — section 1 should say `Standalone / installed web app ✓`.
2. **Service worker** — section 2 should say registered and active, both in
   Safari and in the installed app.
3. **Web Push (the main check)** — in the installed app: tap *Enable
   notifications & subscribe* (accept the permission prompt — this must come
   from the button tap), then *Send test push in 10 s*, then **lock the
   phone**. Expect a notification on the lock screen within ~15 s; tapping it
   should open/focus the app. The server console should print `push sent: ...
   -> 201`. In a plain Safari tab this is expected to fail or do nothing —
   push only exists for installed web apps on iOS.
4. **Badge** — tap *Set badge 1* (or 3), go to the home screen, look at the
   icon; then *Clear badge*. Record whether the numeric badge appears at all.
5. **Cookie jar** — in Safari, tap *Set new token*, note the value; then open
   the installed app and read section 5 (or set from the app and check Safari).
   Different/missing values = separate jars, confirming the architecture's
   pairing gotcha. Also record the localStorage timestamp.

Repeat 3 with the app **swiped away** (not just locked) if there is time: a
push should still wake the service worker and show the notification.

## Record results

Append a dated section to the **Log** in `2026-11-18_pwa_TODO.md`:

- iOS version, phone model, date
- pass/fail for each numbered check above, with what actually happened
  (permission prompt shown? badge visible? notification while locked?)
- anything odd from the server console (e.g. push service returned 404/410)
- then tick (or annotate) the two open phase 0 checkboxes:
  "Throwaway page behind `tailscale serve`" and "Confirm the installed app's
  cookie jar is separate from Safari's"

## Stop / clean up

```sh
tailscale serve off    # when done
# Ctrl-C the server
rm -rf phase0/.data    # throwaway: keys and the stored subscription
```

`phase0/.data/` and `phase0/node_modules/` are git-ignored. Icons in
`phase0/icons/` are committed; regenerate with `node gen-icons.mjs` if ever
needed.
