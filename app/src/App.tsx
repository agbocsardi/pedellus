import { useEffect, useRef, useState } from "react";
import { useSyncExternalStore } from "react";
import { Connection } from "./conn";
import type { Store } from "./store";
import { FirstRun } from "./FirstRun";
import { Chat } from "./Chat";
import { Avatar } from "./Avatar";

export function App({ store }: { store: Store }) {
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  const connRef = useRef<Connection | null>(null);
  const [conn, setConn] = useState<Connection | null>(null);

  useEffect(() => {
    // The store is the source of truth; the connection starts once it is
    // loaded so the hello cursor matches what is actually persisted.
    let alive = true;
    store
      .init()
      .catch((err) => console.error("store init failed; continuing with empty cache", err))
      .finally(() => {
        if (!alive) return;
        connRef.current = new Connection(store);
        setConn(connRef.current);
      });
    return () => {
      alive = false;
    };
  }, [store]);

  // The keyboard can both shrink and pan the visual viewport on iOS.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const style = document.documentElement.style;
    let frame: number | undefined;
    const sync = () => {
      frame = undefined;
      // iOS can still scroll the layout viewport after focusing a field.
      if ((window.scrollX || window.scrollY) &&
          document.activeElement?.matches(".app textarea, .app input")) {
        window.scrollTo(0, 0);
      }
      style.setProperty("--app-h", `${vv.height}px`);
      style.setProperty("--vv-top", `${vv.offsetTop}px`);
    };
    const schedule = () => { frame ??= requestAnimationFrame(sync); };
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    window.addEventListener("scroll", schedule);
    document.addEventListener("focusin", schedule);
    sync();
    return () => {
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      window.removeEventListener("scroll", schedule);
      document.removeEventListener("focusin", schedule);
      if (frame !== undefined) cancelAnimationFrame(frame);
      style.removeProperty("--app-h");
      style.removeProperty("--vv-top");
    };
  }, []);

  if (!conn && store.storageBlocked) return (
    <div className="screen center">
      <div className="card pad" role="status">
        <h1>Close other Durable windows</h1>
        <p className="dim">Durable will continue after its local storage can be upgraded.</p>
      </div>
    </div>
  );
  if (!conn) return <Splash />;
  if (store.mode === "update") return <UpdateScreen />;
  if (store.mode === "pair") return <FirstRun store={store} conn={conn} />;
  return <Chat store={store} conn={conn} />;
}

function Splash() {
  return (
    <div className="screen center">
      <div className="avatar-slot big">
        <Avatar state="thinking" />
      </div>
    </div>
  );
}

function UpdateScreen() {
  return (
    <div className="screen center">
      <div className="card pad">
        <div className="avatar-slot big">
          <Avatar state="offline" />
        </div>
        <h1>Update available</h1>
        <p className="dim">
          The gateway speaks a newer protocol. Reload to pick up the new app.
        </p>
        <button className="primary" onClick={() =>
            void navigator.serviceWorker
              ?.getRegistration()
              .then((r) => r?.update())
              .catch(() => {})
              .finally(() => location.reload())
          }>
          Reload
        </button>
      </div>
    </div>
  );
}
