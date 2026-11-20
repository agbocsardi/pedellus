import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Store } from "./store";
import "./styles.css";

const store = new Store();
createRoot(document.getElementById("root")!).render(<App store={store} />);

// A deployed update only reaches an installed app on a real reload: iOS often resumes the old page
// instead of relaunching it. Check for a new service worker whenever the app comes to the front,
// and reload once when a new one takes over (never on the first install, which has no controller).
if ("serviceWorker" in navigator) {
  const hadController = navigator.serviceWorker.controller !== null;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true;
    location.reload();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    void navigator.serviceWorker.getRegistration().then((registration) => registration?.update()).catch(() => undefined);
  });
}
