import React, { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
const demo = location.pathname.startsWith("/demo");
const Entry = demo
  ? lazy(() => import("./demo").then((m) => ({ default: m.DemoTarget })))
  : lazy(() => import("./App").then((m) => ({ default: m.App })));
if (demo) void import("./styles.css");
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Suspense fallback={<div style={{ padding: 32 }}>正在加载 LoopLab…</div>}>
      <Entry />
    </Suspense>
  </React.StrictMode>,
);
