import "@mantine/core/styles.css";
import "./global.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider } from "@mantine/core";
import { cssVariablesResolver, theme } from "./theme";
import { App } from "./App";

const root = document.getElementById("root");
if (!root) throw new Error("原型根节点缺失");
createRoot(root).render(
  <StrictMode>
    <MantineProvider
      theme={theme}
      defaultColorScheme="dark"
      cssVariablesResolver={cssVariablesResolver}
    >
      <App />
    </MantineProvider>
  </StrictMode>,
);
