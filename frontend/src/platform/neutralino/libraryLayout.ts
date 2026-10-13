import { LibraryLayoutService } from "../../services/library/LibraryLayoutService";
import type { FilmLayout } from "../../contracts/library";
import type { Runtime } from "./bootstrap";
import { nativeSettingsStorage } from "./settingsStorage";

const key = "javm-library-layout-v1";
const services = new Map<Runtime, LibraryLayoutService>();

export function createLibraryLayoutSettings(runtime: Runtime) {
  let service = services.get(runtime);
  if (!service) {
    service = new LibraryLayoutService(
      runtime === "desktop"
        ? nativeSettingsStorage<{ layout: FilmLayout }>(key)
        : {
            async read() {
              return JSON.parse(localStorage.getItem(key) ?? "null") as unknown;
            },
            async write(value) {
              localStorage.setItem(key, JSON.stringify(value));
            },
          },
    );
    services.set(runtime, service);
    void service.initialize();
  }
  return service;
}
