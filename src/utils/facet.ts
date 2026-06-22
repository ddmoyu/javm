import type { Video } from '@/types'

/**
 * 分面维度类型。actor/studio/series/director/genre 可由本地库直接派生取值列表；
 * `code`（番号）是纯在线搜索维度——无本地取值列表，靠输入完整/残缺番号去数据源搜结果。
 */
export type FacetType = 'studio' | 'series' | 'director' | 'actor' | 'genre' | 'code'

export interface FacetTypeMeta {
    type: FacetType
    label: string
}

/** 顶部分面切换的维度集合（演员在最前） */
export const FACET_TYPES: FacetTypeMeta[] = [
    { type: 'actor', label: '演员' },
    { type: 'studio', label: '片商' },
    { type: 'series', label: '系列' },
    { type: 'director', label: '导演' },
    { type: 'genre', label: '分类' },
    { type: 'code', label: '番号' },
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
        case 'code':
            // 番号维度纯在线搜索，不从本地库聚合取值列表
            return []
    }
}

export interface FacetValue {
    name: string
    count: number
}

/**
 * 聚合某分面下的所有取值与作品数（本地库派生）。
 *
 * `resolve` 可把原始取值映射到合并键 + 展示名（演员按别名簇合并：同一人的多个名字归到一条、
 * 显示主名）。同一视频内按合并键去重，避免同人多名形被重复计数。不传则按原始取值计数。
 */
export function aggregateFacet(
    videos: Video[],
    type: FacetType,
    resolve?: (name: string) => { key: string; display: string },
): FacetValue[] {
    const map = new Map<string, { display: string; count: number }>()
    for (const v of videos) {
        // 仅在按簇合并时去重（同人多名形不重复计数）；无 resolver 时保持逐次计数的旧语义
        const seen = resolve ? new Set<string>() : null
        for (const val of facetValuesOf(v, type)) {
            const r = resolve ? resolve(val) : { key: val, display: val }
            if (seen) {
                if (seen.has(r.key)) continue
                seen.add(r.key)
            }
            const cur = map.get(r.key)
            if (cur) cur.count++
            else map.set(r.key, { display: r.display, count: 1 })
        }
    }
    return [...map.values()].map((e) => ({ name: e.display, count: e.count }))
}
