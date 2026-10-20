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
/** 来源页头部的条目档案（演员页提供生日、身高、三围等）；字段按出现顺序保留。 */
export interface OnlineProfile {
  name: string;
  avatarUrl?: string;
  fields: { label: string; value: string }[];
}
export interface OnlineWorksPage {
  items: OnlineWork[];
  page: number;
  nextPage: number | null;
  total?: number;
  profile?: OnlineProfile;
}
