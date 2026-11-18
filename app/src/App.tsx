import { useEffect, useRef, useState } from "react";
import { useSyncExternalStore } from "react";
import { Connection } from "./conn";
import type { Store } from "./store";
import { FirstRun } from "./FirstRun";
import { Chat } from "./Chat";

export function App({ store }: { store: Store }) {
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  const connRef = useRef<Connection | null>(null);
  const [conn, setConn] = useState<Connection | null>(null);

  useEffect(() => {
    // The store is the source of truth; the connection starts once it is
    // loaded so the hello cursor matches what is actually persisted.
    let alive = true;
    store.init().then(
      () => {
        if (!alive) return;
        connRef.current = new Connection(store);
        setConn(connRef.current);
      },
      (err) => console.error("store init failed; continuing with empty cache", err),
    );
    return () => {
      alive = false;
    };
  }, [store]);

  // Keep the virtual keyboard height in a CSS variable so the composer can
  // ride above it (iOS standalone has no reliable visual viewport otherwise).
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty("--vkb", `${kb}px`);
    };
    vv.addEventListener("resize", onResize);
    vv.addEventListener("scroll", onResize);
    onResize();
    return () => {
      vv.removeEventListener("resize", onResize);
      vv.removeEventListener("scroll", onResize);
    };
  }, []);

  if (!conn) return <Splash />;
  if (store.mode === "update") return <UpdateScreen />;
  if (store.mode === "pair") return <FirstRun store={store} conn={conn} />;
  return <Chat store={store} conn={conn} />;
}

function Splash() {
  return (
    <div className="screen center">
      <div className="mark" aria-hidden="true" />
      <p className="dim">Durable</p>
    </div>
  );
}

function UpdateScreen() {
  return (
    <div className="screen center">
      <div className="card pad">
        <h1>Update available</h1>
        <p className="dim">
          The gateway speaks a newer protocol. Reload to pick up the new app.
        </p>
        <button className="primary" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    </div>
  );
}
