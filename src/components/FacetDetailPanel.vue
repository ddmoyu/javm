<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Input } from '@/components/ui/input'
import { Loader2, Download, Star, X } from 'lucide-vue-next'
import type { Video } from '@/types'
import { dmmCoverUrl, dmmMonoCoverUrl, isDmmPlaceholderSize, isDmmImageUrl } from '@/utils/dmm'
import { useScrollMemory } from '@/composables/useScrollMemory'
import { useSettingsStore, useFavoritesStore } from '@/stores'

const settingsStore = useSettingsStore()
const favoritesStore = useFavoritesStore()

// 记忆作品网格滚动位置（按维度+取值区分）：跨路由返回、切回同一取值都恢复
const scrollAreaRef = ref<any>(null)
const getViewport = (): HTMLElement | null =>
    (scrollAreaRef.value?.$el?.querySelector('[data-slot="scroll-area-viewport"]') as HTMLElement) ?? null
const { restore: restoreScroll } = useScrollMemory(
    getViewport,
    () => `facet:${props.facetType}:${props.facetName}`,
)

// 收藏（按维度类型 + 取值名）
const isFav = computed(() => favoritesStore.isFavorite(props.facetType, props.facetName))
const toggleFav = () => favoritesStore.toggle(props.facetType, props.facetName)

interface Props {
    facetType: 'studio' | 'series' | 'director' | 'genre' | 'code'
    facetName: string
    localVideos: Video[]
    // 在线搜索进入：进面板即自动抓全集（无需手动点抓取）
    autoFetch?: boolean
}
const props = defineProps<Props>()
const emit = defineEmits<{
    (e: 'open-video', videoId: string): void
    (e: 'open-missing', payload: { code: string; title: string; cover: string; hasData: boolean }): void
}>()

// 番号维度：纯在线搜索（输入完整/残缺番号搜结果），无本地取值、不落库、不可收藏
const isCode = computed(() => props.facetType === 'code')

interface FacetWork {
    code: string
    title?: string | null
    coverUrl?: string | null
    releaseDate?: string | null
    status: string
    localVideoId?: string | null
    isUncensored: boolean
}

const works = ref<FacetWork[]>([])
const loading = ref(false)
const fetching = ref(false)
const activeTab = ref<'all' | 'local' | 'missing'>('all')
// 番号/名字过滤词。必须在下方 facetType/facetName 的 immediate watch 之前声明：
// 该 watch 在 setup 阶段就会执行并重置它，声明靠后会触发 TDZ、导致 loadDetail 不执行。
const filterText = ref('')

// silent=true：增量刷新时不切 loading（避免抓取过程中网格闪烁）
const loadDetail = async (silent = false) => {
    // 番号维度无本地维度数据（结果走在线搜索）：仅切换关键词时清空旧结果；
    // silent 重载（如缺失作品刮削落库后的刷新）不动已搜到的结果，避免被清空。
    if (isCode.value) {
        if (!silent) works.value = []
        return
    }
    if (!silent) loading.value = true
    try {
        const res = await invoke<{ works: FacetWork[] }>('get_facet_detail', {
            facetType: props.facetType,
            facetName: props.facetName,
        })
        works.value = res.works ?? []
    } catch (e) {
        console.error('获取维度详情失败:', e)
    } finally {
        if (!silent) loading.value = false
    }
}

watch(
    () => [props.facetType, props.facetName],
    () => {
        activeTab.value = 'all'
        filterText.value = ''
        // 取值切换后内容重载完再恢复该取值上次的滚动位置
        void loadDetail().then(() => restoreScroll())
        if (!isCode.value) favoritesStore.load(props.facetType)
    },
    { immediate: true },
)

// 供父组件在缺失作品刮削落库后静默刷新网格（封面/标题即时更新）
defineExpose({ reload: () => loadDetail(true) })

const fetchWorks = async () => {
    if (fetching.value) return
    fetching.value = true
    let unlisten: (() => void) | null = null
    try {
        if (isCode.value) {
            // 番号在线搜索：搜索列表页分页结果经 code-search-progress 累计回传（payload.works 直接覆盖）
            works.value = []
            unlisten = await listen<{ keyword: string; works: FacetWork[] }>(
                'code-search-progress',
                (e) => {
                    if (e.payload?.keyword === props.facetName) works.value = e.payload.works ?? []
                },
            )
            const r = await invoke<{ worksTotal: number; worksLocal: number }>('search_works_by_code', {
                keyword: props.facetName,
            })
            toast.success(`搜到 ${r.worksTotal} 部作品，本地 ${r.worksLocal} 部`)
            return
        }
        // 边抓边显示：后端每页发进度，这里增量刷新
        unlisten = await listen<{ facetName: string; worksTotal: number }>(
            'facet-fetch-progress',
            (e) => {
                if (e.payload?.facetName === props.facetName) loadDetail(true)
            },
        )
        const r = await invoke<{ worksTotal: number; worksLocal: number }>('fetch_facet_works', {
            facetType: props.facetType,
            facetName: props.facetName,
        })
        toast.success(`已抓取：${r.worksTotal} 部作品，本地 ${r.worksLocal} 部`)
        await loadDetail()
    } catch (e) {
        console.error(isCode.value ? '番号搜索失败:' : '抓取全集失败:', e)
        toast.error((isCode.value ? '搜索失败: ' : '抓取失败: ') + String(e))
    } finally {
        if (unlisten) unlisten()
        fetching.value = false
    }
}

// 停止抓取：通知后端取消，已抓到的页（每页已落库 / 番号搜索已回传）会保留
const cancelWorks = async () => {
    try {
        if (isCode.value) {
            await invoke('cancel_code_search', { keyword: props.facetName })
            return
        }
        await invoke('cancel_facet_fetch', {
            facetType: props.facetType,
            facetName: props.facetName,
        })
    } catch (e) {
        console.error('停止抓取失败:', e)
    }
}

// 在线搜索进入：取值就绪即自动在线抓全集（声明在 fetchWorks 之后，避免 TDZ）
watch(
    () => [props.facetType, props.facetName],
    () => {
        if (props.autoFetch && props.facetName) fetchWorks()
    },
    { immediate: true },
)

const hasWorks = computed(() => works.value.length > 0)
const localCount = computed(() => works.value.filter((w) => w.status === 'local').length)
const missingCount = computed(() => works.value.filter((w) => w.status !== 'local').length)

// 抓取按钮文案：番号维度是「搜索」，其余维度是「抓全集」
const fetchBtnText = computed(() => {
    if (fetching.value) return isCode.value ? '搜索中…' : '抓取中…'
    if (isCode.value) return hasWorks.value ? '重新搜索' : '搜索'
    return hasWorks.value ? '重新抓取' : '抓取全集'
})
const emptyHint = computed(() =>
    isCode.value ? '暂无结果' : '暂无作品，点击「抓取全集」获取',
)

// 卡片大小（与演员面板共用一个设置）
const cardSize = ref(settingsStore.settings.general.actorCardSize || 160)
watch(
    () => settingsStore.settings.general.actorCardSize,
    (v) => {
        if (v && v !== cardSize.value) cardSize.value = v
    },
)
const persistCardSize = () => {
    if (cardSize.value !== settingsStore.settings.general.actorCardSize) {
        settingsStore.updateSettings({
            general: { ...settingsStore.settings.general, actorCardSize: cardSize.value },
        })
    }
}

const coverOf = (v: Video): string | null => {
    const path = v.fanart || v.poster || v.thumb
    return path ? convertFileSrc(path) : null
}

interface Card {
    key: string
    coverSrc: string | null
    code: string
    title: string
    status: 'local' | 'missing'
    videoId: string | null
    // 是否已有落库封面（区别于 DMM 兜底猜测）：有则点开缺失卡不再自动刮削
    hasStoredCover: boolean
}

const displayCards = computed<Card[]>(() => {
    if (hasWorks.value) {
        let ws = works.value
        if (activeTab.value === 'local') ws = ws.filter((w) => w.status === 'local')
        else if (activeTab.value === 'missing') ws = ws.filter((w) => w.status !== 'local')
        return ws.map((w) => ({
            key: w.code,
            coverSrc: w.coverUrl || dmmCoverUrl(w.code),
            code: w.code,
            title: w.title || '',
            status: w.status === 'local' ? 'local' : 'missing',
            videoId: w.localVideoId || null,
            hasStoredCover: !!w.coverUrl,
        }))
    }
    return props.localVideos.map((v) => ({
        key: v.id,
        coverSrc: coverOf(v) || dmmCoverUrl(v.localId),
        code: v.localId || '',
        title: v.title || '',
        status: 'local' as const,
        videoId: v.id,
        hasStoredCover: !!coverOf(v),
    }))
})

// 番号/名字过滤：边输入边过滤，作用于当前 Tab 的卡片（番号或标题部分匹配，忽略大小写）
// filterText 已在上方前置声明
const filteredCards = computed<Card[]>(() => {
    const kw = filterText.value.trim().toLowerCase()
    if (!kw) return displayCards.value
    return displayCards.value.filter(
        (c) => c.code.toLowerCase().includes(kw) || c.title.toLowerCase().includes(kw),
    )
})

const onCardClick = (c: Card) => {
    if (c.videoId) emit('open-video', c.videoId)
    // 已有封面 → 直接展示不刮削；无封面 → 开即自动刮削补全。
    // 带上卡片当前封面（含 DMM 兜底）供详情展示；DMM 占位图由详情页按尺寸识别后清空再刮削补
    else if (c.code)
        emit('open-missing', {
            code: c.code,
            title: c.title,
            cover: c.coverSrc ?? '',
            hasData: c.hasStoredCover,
        })
}
// 封面加载成功但其实是 DMM 占位图：按固定尺寸精准识别，当加载失败走兜底，不当有效封面
const onCoverLoad = (e: Event, code: string) => {
    const img = e.target as HTMLImageElement
    const src = img.currentSrc || img.src || ''
    if (isDmmImageUrl(src) && isDmmPlaceholderSize(img.naturalWidth, img.naturalHeight)) onCoverError(e, code)
}
const onCoverError = (e: Event, code: string) => {
    const img = e.target as HTMLImageElement
    const cur = img.getAttribute('src') || ''
    const digital = dmmCoverUrl(code)
    const mono = dmmMonoCoverUrl(code)
    if (digital && cur !== digital && img.dataset.dmm !== 'digital' && img.dataset.dmm !== 'mono') {
        img.dataset.dmm = 'digital'
        img.src = digital
    } else if (mono && cur !== mono && img.dataset.dmm !== 'mono') {
        img.dataset.dmm = 'mono'
        img.src = mono
    } else {
        img.style.visibility = 'hidden'
    }
}
</script>

<template>
    <div class="flex h-full flex-col">
        <!-- 头部：名称 + 计数 + 抓取全集 -->
        <div class="flex items-center gap-3 border-b p-4">
            <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                    <span class="truncate text-lg font-semibold">{{ facetName }}</span>
                    <button
                        v-if="!isCode"
                        type="button"
                        class="shrink-0 text-muted-foreground transition hover:text-yellow-500"
                        :class="isFav ? 'text-yellow-500' : ''"
                        title="收藏"
                        @click="toggleFav"
                    >
                        <Star class="size-5" :fill="isFav ? 'currentColor' : 'none'" />
                    </button>
                </div>
                <div class="mt-0.5 text-sm text-muted-foreground">
                    <template v-if="hasWorks">
                        {{ isCode ? '搜到' : '全集' }} {{ works.length }} 部 · 本地 {{ localCount }} · 缺失 {{ missingCount }}
                    </template>
                    <template v-else-if="isCode">在线搜索番号（支持完整或残缺番号）</template>
                    <template v-else>本地 {{ localVideos.length }} 部（未抓取全集）</template>
                </div>
            </div>
            <Button size="sm" class="gap-1" :disabled="fetching" @click="fetchWorks">
                <Loader2 v-if="fetching" class="size-4 animate-spin" />
                <Download v-else class="size-4" />
                {{ fetchBtnText }}
            </Button>
            <Button v-if="fetching" size="sm" variant="outline" class="gap-1" @click="cancelWorks">
                <X class="size-4" />
                停止
            </Button>
        </div>

        <!-- Tab + 卡片大小 -->
        <div v-if="hasWorks || localVideos.length" class="flex items-center gap-1 border-b px-4 py-2">
            <template v-if="hasWorks">
                <Button
                    v-for="t in (['all', 'local', 'missing'] as const)"
                    :key="t"
                    :variant="activeTab === t ? 'default' : 'ghost'"
                    size="sm"
                    class="h-7 text-xs"
                    @click="activeTab = t"
                >
                    {{ t === 'all' ? `全部 ${works.length}` : t === 'local' ? `本地 ${localCount}` : `缺失 ${missingCount}` }}
                </Button>
            </template>
            <div class="ml-auto flex items-center gap-2">
                <Input
                    v-model="filterText"
                    placeholder="过滤番号/名字"
                    class="h-7 w-40 text-xs"
                />
                <span class="text-xs text-muted-foreground">卡片</span>
                <input
                    v-model.number="cardSize"
                    type="range"
                    min="110"
                    max="800"
                    step="10"
                    class="w-28 cursor-pointer accent-primary"
                    title="封面大小"
                    @change="persistCardSize"
                />
            </div>
        </div>

        <!-- 作品网格 -->
        <ScrollArea ref="scrollAreaRef" class="min-h-0 flex-1">
            <div
                v-if="loading || (isCode && fetching && !hasWorks)"
                class="flex items-center justify-center py-12 text-muted-foreground"
            >
                <Loader2 class="size-6 animate-spin" />
            </div>
            <div
                v-else-if="displayCards.length === 0"
                class="flex items-center justify-center py-12 text-sm text-muted-foreground"
            >
                {{ emptyHint }}
            </div>
            <div
                v-else-if="filteredCards.length === 0"
                class="flex items-center justify-center py-12 text-sm text-muted-foreground"
            >
                无匹配结果
            </div>
            <div
                v-else
                class="grid gap-3 p-4"
                :style="{ gridTemplateColumns: `repeat(auto-fill, minmax(${cardSize}px, 1fr))` }"
            >
                <div
                    v-for="c in filteredCards"
                    :key="c.key"
                    class="group"
                    :class="c.videoId || c.code ? 'cursor-pointer' : ''"
                    @click="onCardClick(c)"
                >
                    <div class="relative aspect-[3/2] overflow-hidden rounded-md bg-muted">
                        <img
                            v-if="c.coverSrc"
                            :src="c.coverSrc"
                            referrerpolicy="no-referrer"
                            loading="lazy"
                            class="size-full object-cover transition group-hover:scale-105"
                            @load="onCoverLoad($event, c.code)"
                            @error="onCoverError($event, c.code)"
                        />
                        <span
                            class="absolute right-1 top-1 rounded px-1 text-[10px] text-white"
                            :class="c.status === 'local' ? 'bg-green-600/80' : 'bg-black/60'"
                        >{{ c.status === 'local' ? '本地' : '缺失' }}</span>
                    </div>
                    <div class="mt-1 truncate text-xs font-medium" :title="c.code">{{ c.code }}</div>
                    <div class="truncate text-xs text-muted-foreground" :title="c.title">{{ c.title }}</div>
                </div>
            </div>
        </ScrollArea>
    </div>
</template>
