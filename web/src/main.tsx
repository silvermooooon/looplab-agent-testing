import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DemoTarget } from "./demo";
import "./styles.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {location.pathname.startsWith("/demo") ? <DemoTarget /> : <App />}
  </React.StrictMode>,
);
