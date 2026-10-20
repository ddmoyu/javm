import "@mantine/core/styles.css";
import "../../../frontend/src/styles/global.css";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, Group, MantineProvider, Text } from "@mantine/core";
import { cssVariablesResolver, theme } from "../../../frontend/src/app/theme";
import { LegacyImportService } from "../../../frontend/src/services/library/LegacyImportService";
import { LegacyImportModal } from "../../../frontend/src/features/library/LegacyImportModal";

const port = {
  async request<T>(method: string): Promise<T> {
    const response = await fetch("/__legacy-test", {
      method: "POST",
      body: JSON.stringify({ method }),
    });
    const result = (await response.json()) as { result: T; error?: string };
    if (result.error) throw new Error(result.error);
    return result.result;
  },
};
function createService() {
  const service = new LegacyImportService(port);
  void service.initialize();
  return service;
}
const initial = createService();
function Harness() {
  const [scheme, setScheme] = useState<"dark" | "light">("dark");
  const [service, setService] = useState(initial);
  return (
    <MantineProvider
      theme={theme}
      cssVariablesResolver={cssVariablesResolver}
      forceColorScheme={scheme}
    >
      <Group p="xl">
        <Text>合成数据库迁移验证</Text>
        <Button onClick={() => setScheme(scheme === "dark" ? "light" : "dark")}>切换主题</Button>
        <Button onClick={() => setService(createService())}>重新检查旧库</Button>
      </Group>
      <LegacyImportModal service={service} />
    </MantineProvider>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
