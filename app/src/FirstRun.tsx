import { useMemo, useState, type FormEvent } from "react";
import { useSyncExternalStore } from "react";
import type { Connection } from "./conn";
import type { Store } from "./store";

/** Pairing-code alphabet: [A-Z2-9] minus I and O, case-insensitive input. */
const CODE_CHARS = /^[A-HJ-NP-Z2-9]+$/;
const CODE_STRIP = /[^A-HJ-NP-Z2-9]/g;

interface StandaloneNavigator extends Navigator {
  standalone?: boolean;
}

function iosNotStandalone(): boolean {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const standalone =
    matchMedia("(display-mode: standalone)").matches ||
    (navigator as StandaloneNavigator).standalone === true;
  return ios && !standalone;
}

function defaultLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Android/.test(ua)) return "Android";
  return "Web";
}

const HINT =
  "Add to Home Screen first: tap Share, then “Add to Home Screen”, and open the app from there. " +
  "The installed app keeps its own sign-in, separate from Safari — pair from inside it, or this code won’t take effect there.";

export function FirstRun({ store, conn }: { store: Store; conn: Connection }) {
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [code, setCode] = useState("");
  const [label, setLabel] = useState(defaultLabel());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const showHint = useMemo(iosNotStandalone, []);

  async function pair(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const c = code.trim();
    const l = label.trim();
    if (!CODE_CHARS.test(c) || c.length !== 8 || !l || l.length > 40) {
      setError("Enter the 8-character code and a short device label.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/v1/pair", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: c, label: l }),
      });
      if (res.status === 204) {
        // The durable_device cookie is set; the connection takes it from here.
        store.setMode("boot");
        conn.revive();
        return;
      }
      if (res.status === 400) setError("That code or label isn’t valid.");
      else if (res.status === 401) setError("Wrong or expired code. Print a fresh one on the host.");
      else if (res.status === 429) setError("Too many attempts — wait a minute and try again.");
      else setError(`Pairing failed (${res.status}).`);
    } catch {
      setError("Can’t reach the gateway. Check your connection.");
    }
    setBusy(false);
  }

  return (
    <div className="screen center">
      <form className="card pad pair" onSubmit={pair}>
        <div className="mark" aria-hidden="true" />
        <h1>Durable</h1>
        {showHint && <p className="hint">{HINT}</p>}
        <label htmlFor="pair-code">Pairing code</label>
        <input
          id="pair-code"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(CODE_STRIP, ""))}
          placeholder="XXXXXXXX"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={8}
          disabled={busy}
        />
        <label htmlFor="pair-label">Device label</label>
        <input
          id="pair-label"
          value={label}
          onChange={(e) => setLabel(e.target.value.slice(0, 40))}
          placeholder="iPhone"
          autoComplete="off"
          maxLength={40}
          disabled={busy}
        />
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "Pairing…" : "Pair this device"}
        </button>
        {error && <p className="error-text" role="alert">{error}</p>}
      </form>
    </div>
  );
}
