<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
    Building2,
    Layers,
    Clapperboard,
    Users,
    Tag,
    Hash,
    ArrowLeft,
    Search,
    ArrowDownAZ,
    ArrowDown01,
    Star,
    Download,
    Loader2,
    X,
} from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { toast } from 'vue-sonner'
import VideoDetailDialog from '@/components/VideoDetailDialog.vue'
import ActorDetailPanel from '@/components/ActorDetailPanel.vue'
import FacetDetailPanel from '@/components/FacetDetailPanel.vue'
import { useVideoStore, useFavoritesStore } from '@/stores'
import type { Video } from '@/types'
import { FACET_TYPES, type FacetType, facetValuesOf, aggregateFacet } from '@/utils/facet'

const videoStore = useVideoStore()
const favoritesStore = useFavoritesStore()

// 演员头像（刮削时从详情页 .avatar-box 收割写入 actors 表）
interface ActorInfo {
    id: number
    name: string
    avatarPath?: string | null
    avatarUrl?: string | null
}
const actorMap = ref<Map<string, ActorInfo>>(new Map())
const fetchActors = async () => {
    try {
        const list = await invoke<ActorInfo[]>('get_actors')
        const m = new Map<string, ActorInfo>()
        for (const a of list) m.set(a.name, a)
        actorMap.value = m
    } catch (e) {
        console.error('获取演员失败:', e)
    }
}
// 演员别名簇：把同一人的多个名字在列表里合并为一条（显示主名 canonical）
interface AliasCluster {
    entityId: number
    canonical: string
    names: string[]
}
const actorClusters = ref<AliasCluster[]>([])
const fetchActorClusters = async () => {
    try {
        actorClusters.value = await invoke<AliasCluster[]>('entity_alias_clusters', {
            entityType: 'actor',
        })
    } catch (e) {
        console.error('获取演员别名簇失败:', e)
        actorClusters.value = []
    }
}
// 名字 → { key: 簇标识, display: 主名 }；不在簇里的名字回退自身
const actorNameResolve = computed(() => {
    const m = new Map<string, { key: string; display: string }>()
    for (const c of actorClusters.value) {
        const key = `actor#${c.entityId}`
        for (const n of c.names) m.set(n, { key, display: c.canonical })
    }
    return m
})
// 主名 → 簇内全部名字（头像回退 / 按别名搜索 / 批量取 id 用）
const canonicalToNames = computed(() => {
    const m = new Map<string, string[]>()
    for (const c of actorClusters.value) m.set(c.canonical, c.names)
    return m
})

const avatarByName = (name: string): string | null => {
    const a = actorMap.value.get(name)
    if (!a) return null
    if (a.avatarPath) return convertFileSrc(a.avatarPath)
    if (a.avatarUrl) return a.avatarUrl
    return null
}
const actorAvatarSrc = (name: string): string | null => {
    const direct = avatarByName(name)
    if (direct) return direct
    // 合并显示的是主名，头像可能当初收割在别名下 → 回退簇内其它名字
    const names = canonicalToNames.value.get(name)
    if (names) {
        for (const n of names) {
            const a = avatarByName(n)
            if (a) return a
        }
    }
    return null
}
const hideBrokenImg = (e: Event) => {
    ;(e.target as HTMLImageElement).style.display = 'none'
}

const facetType = ref<FacetType>('actor')
const selectedValue = ref<string | null>(null)
const search = ref('')
const sortByCount = ref(true) // true=按作品数, false=按名称
const showFavoritesOnly = ref(false) // 只看收藏

const isFav = (name: string) => favoritesStore.isFavorite(facetType.value, name)
const toggleFavorite = (name: string) => favoritesStore.toggle(facetType.value, name)

const ICONS: Record<FacetType, any> = {
    studio: Building2,
    series: Layers,
    director: Clapperboard,
    actor: Users,
    genre: Tag,
    code: Hash,
}

const route = useRoute()
// 从详情页 tag 跳转过来：?facet=<维度>&value=<取值> → 直接进入对应维度并选中
const applyRouteFacet = () => {
    const f = route.query.facet
    const v = route.query.value
    if (typeof f === 'string' && FACET_TYPES.some((t) => t.type === f)) {
        facetType.value = f as FacetType
        selectedValue.value = typeof v === 'string' && v.trim() ? v : null
        search.value = ''
    }
}

onMounted(() => {
    if (videoStore.videos.length === 0) videoStore.fetchVideos()
    fetchActors()
    fetchActorClusters()
    applyRouteFacet()
})

// 已在发现页时再次点击 tag（同路由仅 query 变化）也要响应
watch(() => route.query, applyRouteFacet)

// 切换维度即加载该维度的收藏集合（含首次）
watch(facetType, (t) => favoritesStore.load(t), { immediate: true })

const switchFacet = (t: FacetType) => {
    facetType.value = t
    selectedValue.value = null
    search.value = ''
}

const currentFacetLabel = computed(
    () => FACET_TYPES.find((f) => f.type === facetType.value)?.label ?? '',
)

// 分面值列表（本地库派生 + 搜索 + 收藏过滤 + 排序；收藏的恒靠前）
const facetValues = computed(() => {
    // 演员维度：按别名簇合并（同一人多名形归一条、显示主名）
    const resolve =
        facetType.value === 'actor'
            ? (name: string) => actorNameResolve.value.get(name) ?? { key: name, display: name }
            : undefined
    let arr = aggregateFacet(videoStore.videos, facetType.value, resolve)
    const favs = favoritesStore.favoriteSet(facetType.value)
    // 把"已收藏但本地无作品"的取值并入（count 0）：在线搜索收藏的演员/片商/分类等也能显示在列表
    if (favs.size) {
        const present = new Set(arr.map((x) => x.name))
        for (const f of favs) if (!present.has(f)) arr.push({ name: f, count: 0 })
    }
    const kw = search.value.trim().toLowerCase()
    if (kw)
        arr = arr.filter((x) => {
            if (x.name.toLowerCase().includes(kw)) return true
            // 演员：合并后显示主名，按别名也要能搜到
            if (facetType.value === 'actor') {
                const names = canonicalToNames.value.get(x.name)
                if (names && names.some((n) => n.toLowerCase().includes(kw))) return true
            }
            return false
        })
    if (showFavoritesOnly.value) arr = arr.filter((x) => favs.has(x.name))
    arr.sort((a, b) => {
        const fa = favs.has(a.name) ? 1 : 0
        const fb = favs.has(b.name) ? 1 : 0
        if (fa !== fb) return fb - fa // 收藏靠前
        return sortByCount.value
            ? b.count - a.count || a.name.localeCompare(b.name, 'zh-CN')
            : a.name.localeCompare(b.name, 'zh-CN')
    })
    return arr
})

// 在线搜索：搜索词作为列表第一项，点击后进入该取值详情页并自动在线抓取（演员/片商/系列/导演/分类统一）
const onlineFetchPending = ref(false)
// 点击本地取值进详情：清掉在线抓取标记（避免点本地项也触发在线抓）
const selectValue = (name: string) => {
    onlineFetchPending.value = false
    selectedValue.value = name
}
const enterOnlineSearch = () => {
    const q = search.value.trim()
    if (!q) return
    // 演员建档由下方 selectedValue 的 watch（ensureActorId）统一处理
    onlineFetchPending.value = true
    selectedValue.value = q
}

// 批量抓档案：对当前列表里的演员后台并发抓取档案/全集，进度经 actor-batch-progress 增量上报
const batchRunning = ref(false)
const batchProgress = ref<{
    done: number
    total: number
    succeeded: number
    failed: number
    name?: string
}>({ done: 0, total: 0, succeeded: 0, failed: 0 })
let batchUnlisten: (() => void) | null = null

// 当前列表（含搜索/收藏过滤）里的演员 → actors 表 id（主名取不到回退簇内别名）
const collectActorIdsForBatch = (): number[] => {
    const ids = new Set<number>()
    for (const fv of facetValues.value) {
        let id = actorMap.value.get(fv.name)?.id
        if (id == null) {
            const names = canonicalToNames.value.get(fv.name)
            if (names) {
                for (const n of names) {
                    const i = actorMap.value.get(n)?.id
                    if (i != null) {
                        id = i
                        break
                    }
                }
            }
        }
        if (id != null) ids.add(id)
    }
    return [...ids]
}

const startBatchFetch = async () => {
    if (batchRunning.value) return
    const ids = collectActorIdsForBatch()
    if (ids.length === 0) {
        toast.info('没有可抓取的演员')
        return
    }
    batchRunning.value = true
    batchProgress.value = { done: 0, total: ids.length, succeeded: 0, failed: 0 }
    batchUnlisten = await listen<typeof batchProgress.value>('actor-batch-progress', (e) => {
        if (e.payload) batchProgress.value = e.payload
    })
    try {
        const sum = await invoke<{ total: number; succeeded: number; failed: number }>(
            'fetch_actors_profile_batch',
            { actorIds: ids, onlyMissing: true },
        )
        toast.success(`批量抓取完成：成功 ${sum.succeeded}，失败 ${sum.failed}（共 ${sum.total}）`)
        await fetchActors()
        await fetchActorClusters()
    } catch (e) {
        console.error('批量抓取失败:', e)
        toast.error('批量抓取失败: ' + String(e))
    } finally {
        batchRunning.value = false
        if (batchUnlisten) {
            batchUnlisten()
            batchUnlisten = null
        }
    }
}
const stopBatchFetch = async () => {
    try {
        await invoke('cancel_actors_batch')
    } catch (e) {
        console.error('停止批量抓取失败:', e)
    }
}
// 卸载时解绑批量进度监听，避免遗留监听器
onUnmounted(() => {
    if (batchUnlisten) {
        batchUnlisten()
        batchUnlisten = null
    }
})

// 选中演员的跨语言别名（中文/英文/日文/曾用名），用于把属于任一别名的视频都归到该演员
interface AliasRow {
    name: string
    lang: string
    isCanonical: boolean
}
const selectedAliasRows = ref<AliasRow[]>([])
const selectedAliasNames = computed(() => selectedAliasRows.value.map((a) => a.name))
const loadActorAliases = async (name: string) => {
    try {
        const res = await invoke<{ aliases: AliasRow[] }>('entity_alias_expand', {
            entityType: 'actor',
            name,
        })
        selectedAliasRows.value = res.aliases ?? []
    } catch (e) {
        console.error('获取演员别名失败:', e)
        selectedAliasRows.value = []
    }
}
// 选中演员若本地无记录（如从作品 tag 跳来的非本地演员）：按名建档拿 id，
// 否则详情页解析不到 actorId → 抓取按钮禁用、也无法抓档案/全集。
const ensureActorId = async (name: string) => {
    if (actorMap.value.get(name)?.id != null) return
    try {
        const id = await invoke<number>('ensure_actor', { name })
        const m = new Map(actorMap.value)
        m.set(name, { ...(m.get(name) ?? { name }), id, name })
        actorMap.value = m // 重新赋值触发 selectedActorId 重算
    } catch (e) {
        console.error('演员建档失败:', e)
    }
}
watch(
    [facetType, selectedValue],
    ([ft, sv]) => {
        if (ft === 'actor' && sv) {
            void ensureActorId(sv)
            loadActorAliases(sv)
        } else {
            selectedAliasRows.value = []
        }
    },
    { immediate: true },
)

// 分面详情：归属该取值的作品。演员维度按「任一别名」匹配，把多名字的视频都收进来
const detailVideos = computed<Video[]>(() => {
    if (!selectedValue.value) return []
    if (facetType.value === 'actor' && selectedAliasNames.value.length > 0) {
        const names = new Set(selectedAliasNames.value)
        return videoStore.videos.filter((v) =>
            facetValuesOf(v, 'actor').some((n) => names.has(n)),
        )
    }
    return videoStore.videos.filter((v) =>
        facetValuesOf(v, facetType.value).includes(selectedValue.value!),
    )
})

// 视频详情 / 刮削
const detailDialogOpen = ref(false)
const selectedVideo = ref<Video | null>(null)
const detailAutoScrape = ref(false) // 缺失作品：开即自动刮削

const handleVideoSelect = (video: Video) => {
    detailAutoScrape.value = false
    selectedVideo.value = video
    detailDialogOpen.value = true
}
// 缺失作品卡：用只含番号的合成视频开详情，靠磁力/资源链接获取。
// 已有封面（落库过）→ 直接展示已有数据，不再每次点开自动刮削（不满意用户可手动重新刮削）；
// 无封面 → 开即自动刮削补全。已有封面带入 poster 供详情展示。
const openMissing = (payload: { code: string; title: string; cover?: string; hasData?: boolean }) => {
    detailAutoScrape.value = !payload.hasData
    selectedVideo.value = {
        id: '',
        localId: payload.code,
        title: payload.title || payload.code,
        originalTitle: payload.code,
        videoPath: '',
        poster: payload.cover || '',
        scanStatus: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    } as Video
    detailDialogOpen.value = true
}
const handleVideoUpdated = (video: Video) => {
    selectedVideo.value = video
}

// 演员详情面板：当前选中演员的 id（用于抓取档案/全集）。
// 先按选中名，再按任一别名解析到 actors 表 id —— 点别名也能定位到同一演员档案/全集。
const selectedActorId = computed<number | null>(() => {
    if (facetType.value !== 'actor' || !selectedValue.value) return null
    const direct = actorMap.value.get(selectedValue.value)?.id
    if (direct != null) return direct
    for (const n of selectedAliasNames.value) {
        const id = actorMap.value.get(n)?.id
        if (id != null) return id
    }
    return null
})
const openVideoById = (videoId: string) => {
    const v = videoStore.videos.find((x) => x.id === videoId)
    if (v) handleVideoSelect(v)
}

// 缺失作品刮削落库后：静默刷新当前面板，封面/标题即时更新
const actorPanelRef = ref<InstanceType<typeof ActorDetailPanel> | null>(null)
const facetPanelRef = ref<InstanceType<typeof FacetDetailPanel> | null>(null)
const handleWorkMetaSaved = () => {
    actorPanelRef.value?.reload()
    facetPanelRef.value?.reload()
}
</script>

<template>
    <div class="flex h-full flex-col">
        <!-- 顶部：分面切换 + 搜索 + 排序 -->
        <div class="flex flex-wrap items-center gap-2 border-b px-4 py-3">
            <div class="flex items-center gap-1">
                <Button
                    v-for="f in FACET_TYPES"
                    :key="f.type"
                    :variant="facetType === f.type ? 'default' : 'ghost'"
                    size="sm"
                    class="h-8 gap-1"
                    @click="switchFacet(f.type)"
                >
                    <component :is="ICONS[f.type]" class="size-4" />
                    {{ f.label }}
                </Button>
            </div>

            <div v-if="!selectedValue" class="ml-auto flex items-center gap-2">
                <Button
                    v-if="facetType === 'actor'"
                    variant="outline"
                    size="sm"
                    class="h-8 gap-1"
                    :disabled="batchRunning"
                    title="对当前列表的演员后台批量抓取缺失档案/全集"
                    @click="startBatchFetch"
                >
                    <Loader2 v-if="batchRunning" class="size-4 animate-spin" />
                    <Download v-else class="size-4" />
                    {{ batchRunning ? '抓取中…' : '批量抓档案' }}
                </Button>
                <div class="relative">
                    <Search class="absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input v-model="search" :placeholder="`搜索${currentFacetLabel}`" class="h-8 w-48 pl-8 pr-7" />
                    <button
                        v-if="search"
                        type="button"
                        class="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                        title="清除"
                        @click="search = ''"
                    >
                        <X class="size-4" />
                    </button>
                </div>
                <Button variant="ghost" size="sm" class="h-8 gap-1" @click="sortByCount = !sortByCount">
                    <component :is="sortByCount ? ArrowDown01 : ArrowDownAZ" class="size-4" />
                    {{ sortByCount ? '作品数' : '名称' }}
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    class="h-8 gap-1"
                    :class="showFavoritesOnly ? 'text-yellow-500' : ''"
                    title="只看收藏"
                    @click="showFavoritesOnly = !showFavoritesOnly"
                >
                    <Star class="size-4" :fill="showFavoritesOnly ? 'currentColor' : 'none'" />
                    收藏
                </Button>
            </div>
        </div>

        <!-- 批量抓档案进度 -->
        <div
            v-if="batchRunning"
            class="flex items-center gap-3 border-b bg-muted/40 px-4 py-1.5 text-xs"
        >
            <Loader2 class="size-3.5 animate-spin text-primary" />
            <span class="tabular-nums">
                批量抓取 {{ batchProgress.done }}/{{ batchProgress.total }} · 成功
                {{ batchProgress.succeeded }} · 失败 {{ batchProgress.failed }}
            </span>
            <span v-if="batchProgress.name" class="truncate text-muted-foreground"
                >当前：{{ batchProgress.name }}</span
            >
            <Button variant="ghost" size="sm" class="ml-auto h-6 px-2 text-xs" @click="stopBatchFetch"
                >停止</Button
            >
        </div>

        <!-- 分面值列表 -->
        <template v-if="!selectedValue">
            <div
                v-if="facetValues.length === 0 && !search.trim()"
                class="flex flex-1 items-center justify-center text-muted-foreground"
            >
                <p v-if="facetType === 'code'">输入完整或残缺番号，再点「在线搜索」抓取结果</p>
                <p v-else>暂无{{ currentFacetLabel }}数据</p>
            </div>
            <ScrollArea v-else class="min-h-0 flex-1">
                <div class="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 p-4">
                    <!-- 在线搜索：搜索非空时置顶，点击进详情页并在线抓取 -->
                    <div
                        v-if="search.trim()"
                        class="flex cursor-pointer items-center gap-2 rounded-lg border border-dashed border-primary/60 bg-primary/5 p-3 text-left transition hover:bg-primary/10"
                        :title="`在线搜索 ${search.trim()}`"
                        @click="enterOnlineSearch"
                    >
                        <Search class="size-4 shrink-0 text-primary" />
                        <span class="min-w-0 flex-1 truncate text-sm font-medium text-primary">在线搜索「{{ search.trim() }}」</span>
                    </div>
                    <div
                        v-for="fv in facetValues"
                        :key="fv.name"
                        class="flex cursor-pointer items-center gap-2 rounded-lg border bg-card p-3 text-left transition hover:border-primary hover:bg-accent"
                        @click="selectValue(fv.name)"
                    >
                        <img
                            v-if="facetType === 'actor' && actorAvatarSrc(fv.name)"
                            :src="actorAvatarSrc(fv.name)!"
                            referrerpolicy="no-referrer"
                            loading="lazy"
                            class="size-9 shrink-0 rounded-full bg-muted object-cover"
                            @error="hideBrokenImg"
                        />
                        <span class="min-w-0 flex-1 truncate text-sm font-medium" :title="fv.name">{{ fv.name }}</span>
                        <span
                            class="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs tabular-nums text-muted-foreground"
                        >{{ fv.count }}</span>
                        <button
                            type="button"
                            class="shrink-0 text-muted-foreground transition hover:text-yellow-500"
                            :class="isFav(fv.name) ? 'text-yellow-500' : ''"
                            title="收藏"
                            @click.stop="toggleFavorite(fv.name)"
                        >
                            <Star class="size-4" :fill="isFav(fv.name) ? 'currentColor' : 'none'" />
                        </button>
                    </div>
                </div>
            </ScrollArea>
        </template>

        <!-- 分面详情：作品网格 -->
        <template v-else>
            <div class="flex items-center gap-2 border-b px-4 py-2">
                <Button variant="ghost" size="sm" class="h-8 gap-1" @click="selectedValue = null">
                    <ArrowLeft class="size-4" /> 返回
                </Button>
                <span class="text-sm font-medium">{{ currentFacetLabel }}：{{ selectedValue }}</span>
                <span v-if="facetType !== 'actor' && facetType !== 'code'" class="text-xs text-muted-foreground">{{ detailVideos.length }} 部</span>
            </div>

            <!-- 演员：档案 + 全集；片商/系列/导演/分类：全集 -->
            <ActorDetailPanel
                v-if="facetType === 'actor'"
                ref="actorPanelRef"
                class="min-h-0 flex-1"
                :actor-id="selectedActorId"
                :actor-name="selectedValue!"
                :local-videos="detailVideos"
                :aliases="selectedAliasRows"
                :auto-fetch="onlineFetchPending"
                @open-video="openVideoById"
                @open-missing="openMissing"
                @refreshed="fetchActors"
                @aliases-changed="selectedValue && loadActorAliases(selectedValue)"
            />
            <FacetDetailPanel
                v-else
                ref="facetPanelRef"
                class="min-h-0 flex-1"
                :facet-type="facetType"
                :facet-name="selectedValue!"
                :local-videos="detailVideos"
                :auto-fetch="onlineFetchPending"
                @open-video="openVideoById"
                @open-missing="openMissing"
            />
        </template>

        <VideoDetailDialog
            v-model:open="detailDialogOpen"
            :video="selectedVideo"
            :auto-scrape="detailAutoScrape"
            @video-updated="handleVideoUpdated"
            @work-meta-saved="handleWorkMetaSaved"
        />
    </div>
</template>
