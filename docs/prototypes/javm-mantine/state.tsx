import { createContext, useContext } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { DownloadTask, Film } from "./data";
import type { FilmFacet } from "./filmMetadata";

export type Page = "library" | "discover" | "directories" | "downloads" | "scraper" | "settings";
export type FilmDetailView = "info" | "files" | "screenshots" | "edit" | "links";
export interface PrototypeState {
  page: Page;
  go: (page: Page) => void;
  films: Film[];
  setFilms: Dispatch<SetStateAction<Film[]>>;
  tasks: DownloadTask[];
  setTasks: Dispatch<SetStateAction<DownloadTask[]>>;
  query: string;
  setQuery: (value: string) => void;
  openFilm: (film: Film, view?: FilmDetailView) => void;
  play: (film: Film) => void;
  scrape: (film: Film, view?: "match" | "links") => void;
  browseFacet: (facet: FilmFacet, value: string) => void;
  notice: (message: string) => void;
  theme: "dark" | "light";
  setTheme: (theme: "dark" | "light") => void;
  closeToTray: boolean;
  setCloseToTray: (enabled: boolean) => void;
  cardClickToPlay: boolean;
  setCardClickToPlay: (enabled: boolean) => void;
  add: (kind: "import" | "download") => void;
}
export const PrototypeContext = createContext<PrototypeState | null>(null);
export function usePrototype() {
  const context = useContext(PrototypeContext);
  if (!context) throw new Error("原型上下文未初始化");
  return context;
}
