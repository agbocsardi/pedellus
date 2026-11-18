import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Store } from "./store";
import "./styles.css";

const store = new Store();
createRoot(document.getElementById("root")!).render(<App store={store} />);
