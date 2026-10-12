export interface OnlineEntity {
  id: string;
  name: string;
  url: string;
}
export interface OnlineWork {
  code: string;
  title: string;
  url: string;
  coverUrl?: string;
  coverCandidates?: string[];
}
export interface OnlineWorksPage {
  items: OnlineWork[];
  page: number;
  nextPage: number | null;
  total?: number;
}
