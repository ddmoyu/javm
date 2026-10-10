import "@mantine/core/styles.css";
import "./prototype.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Prototype } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("原型根节点缺失");
createRoot(root).render(
  <StrictMode>
    <Prototype />
  </StrictMode>,
);
