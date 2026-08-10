// ABOUTME: Mounts Greenroom's single-page React application into the Worker-served document.
// ABOUTME: Loads the shared editorial backstage visual system for every role and public route.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

const root = document.getElementById("root");
if (root === null) {
  throw new Error("Greenroom application root is missing");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
