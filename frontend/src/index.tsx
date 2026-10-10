/* @refresh reload */
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "./index.css";
import { enablePopmotion } from "@pathscale/ui/motion";
import { render } from "@solidjs/web";
import { animate } from "popmotion";
import { App } from "./App";
import { applyPreferences, readPreferences } from "./preferences";

enablePopmotion(animate);
applyPreferences(readPreferences());
document.body.id = "pdf-viewer-app";

const root = document.getElementById("root");
if (!(root instanceof HTMLElement)) {
  throw new Error("Root element #root was not found");
}

render(() => <App />, root);

