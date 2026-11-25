import { useEffect, useState } from "react";
import { useSyncExternalStore } from "react";
import { Connection } from "./conn";
import type { Store } from "./store";
import { FirstRun } from "./FirstRun";
import { Chat } from "./Chat";
import { Avatar } from "./Avatar";

export function App({ store }: { store: Store }) {
  // Only what picks the screen; each screen subscribes to what it shows.
  useSyncExternalStore(store.subscribe, () => `${store.mode}\u0000${store.storageBlocked}\u0000${store.agentName}`);
  const [conn, setConn] = useState<Connection | null>(null);

  useEffect(() => {
    // The store is the source of truth; the connection starts once it is
    // loaded so the hello cursor matches what is actually persisted.
    let alive = true;
    let connection: Connection | undefined;
    store
      .init()
      .catch((err) => console.error("store init failed; continuing with empty cache", err))
      .finally(() => {
        if (!alive) return;
        connection = new Connection(store, {
          // Navigation stays with the store: the connection only reports the accepted create.
          onThreadCreated: (thread, from) => store.followCreated(thread, from),
        });
        setConn(connection);
      });
    // StrictMode (and any real unmount) tears both down; a remount reopens the same store.
    return () => {
      alive = false;
      connection?.dispose();
      store.dispose();
      setConn(null);
    };
  }, [store]);

  // iOS keyboard handling, chosen on device with /keyboard-lab.html (F):
  // the shell follows the visual viewport, the page scroll is snapped back,
  // a tap focuses fields without letting iOS pan, and closing the keyboard
  // blurs the field (iPad keeps focus otherwise, so the next tap would take
  // iOS's own scrolling focus path and the header would bounce).
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const style = document.documentElement.style;
    const isField = (el: EventTarget | null): el is HTMLElement =>
      el instanceof HTMLElement && el.matches(".app textarea, .app input");
    const kbOpen = () => vv.height < window.innerHeight - 80;
    // Installed iOS 26 sometimes lays the page out to the full screen and sometimes stops it a
    // status bar short of the bottom (measured: 852pt screen, 793pt page), while
    // env(safe-area-inset-bottom) always reports the home indicator. Pad by the part of that
    // inset the page really reaches, measured, so the composer neither hides under the home
    // indicator nor floats above a gap.
    // Measured on device: with a translucent status bar the page starts at the screen top and may
    // end short of the bottom (top inset 59, page 793 of 852); with the default style it starts
    // below the status bar and reaches the bottom (top inset 0, page 793 from y=59).
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;height:env(safe-area-inset-bottom)";
    const probeTop = document.createElement("div");
    probeTop.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;height:env(safe-area-inset-top)";
    document.body.append(probe, probeTop);
    const insetBottom = () => {
      const inset = probe.getBoundingClientRect().height;
      const insetTop = probeTop.getBoundingClientRect().height;
      const landscape = window.innerWidth > window.innerHeight;
      const screenH = landscape ? Math.min(screen.width, screen.height) : Math.max(screen.width, screen.height);
      // A page with no top inset that is shorter than the screen sits below the status bar.
      const pageTop = insetTop > 0 ? 0 : Math.max(0, screenH - window.innerHeight);
      const covered = pageTop + window.innerHeight - (screenH - inset);
      return Math.max(0, Math.min(inset, covered));
    };
    let wasOpen = false;
    const sync = () => {
      const open = kbOpen();
      if (wasOpen && !open && isField(document.activeElement)) document.activeElement.blur();
      wasOpen = open;
      if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
      style.setProperty("--app-h", `${vv.height}px`);
      style.setProperty("--inset-bottom", `${open ? 0 : insetBottom()}px`);
      style.setProperty("--vv-top", `${open ? vv.offsetTop : 0}px`);
    };
    const tap = (e: TouchEvent) => {
      if (!isField(e.target) || kbOpen()) return;
      e.preventDefault();
      e.target.focus({ preventScroll: true });
    };
    vv.addEventListener("resize", sync);
    vv.addEventListener("scroll", sync);
    window.addEventListener("scroll", sync, { passive: true });
    document.addEventListener("touchend", tap, { passive: false });
    sync();
    return () => {
      vv.removeEventListener("resize", sync);
      vv.removeEventListener("scroll", sync);
      window.removeEventListener("scroll", sync);
      document.removeEventListener("touchend", tap);
      style.removeProperty("--app-h");
      style.removeProperty("--inset-bottom");
      probe.remove();
      probeTop.remove();
      style.removeProperty("--vv-top");
    };
  }, []);

  useEffect(() => {
    document.title = store.agentName;
  }, [store.agentName]);

  if (!conn && store.storageBlocked) return (
    <div className="screen center">
      <div className="card pad" role="status">
        <h1>Close other Pedellus windows</h1>
        <p className="dim">Pedellus will continue after its local storage can be upgraded.</p>
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
