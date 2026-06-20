import type { Video } from '@/types'

/** 分面维度类型（本地数据可直接派生） */
export type FacetType = 'studio' | 'series' | 'director' | 'actor' | 'genre'

export interface FacetTypeMeta {
    type: FacetType
    label: string
}

/** 顶部分面切换的维度集合 */
export const FACET_TYPES: FacetTypeMeta[] = [
    { type: 'studio', label: '片商' },
    { type: 'series', label: '系列' },
    { type: 'director', label: '导演' },
    { type: 'actor', label: '演员' },
    { type: 'genre', label: '分类' },
]

/**
 * 从番号提取系列/厂牌前缀（如 `SSIS-001` → `SSIS`）。
 * 规则与后端 `series_prefix_of` 保持一致：大写、`-` 分两段、前缀 2-8 且含字母、数字段含数字。
 */
export function seriesPrefixOf(localId?: string | null): string | null {
    if (!localId) return null
    const upper = localId.trim().toUpperCase()
    const parts = upper.split('-')
    if (parts.length !== 2) return null
    const [prefix, number] = parts
    if (prefix.length < 2 || prefix.length > 8) return null
    if (!/[A-Z]/.test(prefix)) return null
    if (!/[0-9]/.test(number)) return null
    return prefix
}

function splitCsv(s?: string): string[] {
    if (!s) return []
    return s.split(',').map((x) => x.trim()).filter(Boolean)
}

/** 取出某视频在指定分面下的取值（演员/分类可能多值，片商/系列/导演单值）。 */
export function facetValuesOf(v: Video, type: FacetType): string[] {
    switch (type) {
        case 'studio':
            return v.studio?.trim() ? [v.studio.trim()] : []
        case 'director':
            return v.director?.trim() ? [v.director.trim()] : []
        case 'series': {
            const p = seriesPrefixOf(v.localId)
            return p ? [p] : []
        }
        case 'actor':
            return splitCsv(v.actors)
        case 'genre':
            return splitCsv(v.genres)
    }
}

export interface FacetValue {
    name: string
    count: number
}

/** 聚合某分面下的所有取值与作品数（本地库派生）。 */
export function aggregateFacet(videos: Video[], type: FacetType): FacetValue[] {
    const map = new Map<string, number>()
    for (const v of videos) {
        for (const val of facetValuesOf(v, type)) {
            map.set(val, (map.get(val) ?? 0) + 1)
        }
    }
    return [...map.entries()].map(([name, count]) => ({ name, count }))
}
