import { MetadataPipeline } from "../../services/scraping/MetadataPipeline";
import type { MetadataPipelineSettings } from "../../services/scraping/MetadataPipeline";
import type { ScrapeProvider } from "../../services/scraping/ScrapeService";
import { nativeSettingsStorage } from "./settingsStorage";
export function createMetadataPipeline(metatube: ScrapeProvider, available: boolean) {
  return new MetadataPipeline(
    metatube,
    nativeSettingsStorage<MetadataPipelineSettings>("metadata-pipeline-v1"),
    available,
  );
}
