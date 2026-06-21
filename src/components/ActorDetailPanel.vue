<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Loader2, Download } from 'lucide-vue-next'
import type { Video } from '@/types'
import { dmmCoverUrl, dmmMonoCoverUrl } from '@/utils/dmm'
import { useSettingsStore } from '@/stores'

const settingsStore = useSettingsStore()

interface Props {
    actorId: number | null
    actorName: string
    localVideos: Video[]
}
const props = defineProps<Props>()
const emit = defineEmits<{
    (e: 'open-video', videoId: string): void
    (e: 'open-missing', payload: { code: string; title: string; cover: string; hasData: boolean }): void
    (e: 'refreshed'): void
}>()

interface ActorProfile {
    avatarPath?: string | null
    avatarUrl?: string | null
    birthday?: string | null
    height?: number | null
    cup?: string | null
    bust?: number | null
    waist?: number | null
    hip?: number | null
    workCount?: number | null
}
interface ActorWork {
    code: string
    title?: string | null
    coverUrl?: string | null
    releaseDate?: string | null
    status: string
    localVideoId?: string | null
    isUncensored: boolean
}

const profile = ref<ActorProfile | null>(null)
const works = ref<ActorWork[]>([])
const loading = ref(false)
const fetching = ref(false)
const activeTab = ref<'all' | 'local' | 'missing'>('all')

// silent=true：增量刷新时不切 loading（避免抓取过程中网格闪烁）
const loadDetail = async (silent = false) => {
    if (!props.actorId) {
        profile.value = null
        works.value = []
        return
    }
    if (!silent) loading.value = true
    try {
        const res = await invoke<{ profile: ActorProfile; works: ActorWork[] }>('get_actor_detail', {
            actorId: props.actorId,
        })
        profile.value = res.profile
        works.value = res.works ?? []
    } catch (e) {
        console.error('获取演员详情失败:', e)
    } finally {
        if (!silent) loading.value = false
    }
}

watch(
    () => props.actorId,
    () => {
        activeTab.value = 'all'
        loadDetail()
    },
    { immediate: true },
)

// 供父组件在缺失作品刮削落库后静默刷新网格（封面/标题即时更新）
defineExpose({ reload: () => loadDetail(true) })

const fetchProfile = async () => {
    if (!props.actorId || fetching.value) return
    fetching.value = true
    let unlisten: (() => void) | null = null
    try {
        // 边抓边显示：后端每页发进度，这里增量刷新
        unlisten = await listen<{ actorId: number; worksTotal: number }>(
            'actor-fetch-progress',
            (e) => {
                if (e.payload?.actorId === props.actorId) loadDetail(true)
            },
        )
        const r = await invoke<{ profileUpdated: boolean; worksTotal: number; worksLocal: number }>(
            'fetch_actor_profile',
            { actorId: props.actorId },
        )
        toast.success(`已抓取：${r.worksTotal} 部作品，本地 ${r.worksLocal} 部`)
        await loadDetail()
        emit('refreshed')
    } catch (e) {
        console.error('抓取演员档案失败:', e)
        toast.error('抓取失败: ' + String(e))
    } finally {
        if (unlisten) unlisten()
        fetching.value = false
    }
}

const hasWorks = computed(() => works.value.length > 0)
const localCount = computed(() => works.value.filter((w) => w.status === 'local').length)
const missingCount = computed(() => works.value.filter((w) => w.status !== 'local').length)
// 是否已抓取过（已落库）：有作品，或档案已有资料 → 按钮显示「重新抓取」
const hasFetched = computed(
    () =>
        hasWorks.value ||
        !!(profile.value && (profile.value.birthday || profile.value.height || profile.value.cup)),
)

const avatarSrc = computed<string | null>(() => {
    const p = profile.value
    if (p?.avatarPath) return convertFileSrc(p.avatarPath)
    if (p?.avatarUrl) return p.avatarUrl
    return null
})

const measurements = computed(() => {
    const p = profile.value
    if (!p) return null
    if (p.bust && p.waist && p.hip) return `${p.bust} / ${p.waist} / ${p.hip}`
    return null
})

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

// 已抓全集 → 显示全集（可切 Tab）；未抓 → 显示本地作品（来自媒体库）
const displayCards = computed<Card[]>(() => {
    if (hasWorks.value) {
        let ws = works.value
        if (activeTab.value === 'local') ws = ws.filter((w) => w.status === 'local')
        else if (activeTab.value === 'missing') ws = ws.filter((w) => w.status !== 'local')
        return ws.map((w) => ({
            key: w.code,
            // 无封面 → 用番号直拼 DMM 官方封面兜底（覆盖有码主流）
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

const onCardClick = (c: Card) => {
    if (c.videoId) emit('open-video', c.videoId)
    // 已有封面 → 直接展示不刮削；无封面 → 开即自动刮削补全
    else if (c.code)
        emit('open-missing', {
            code: c.code,
            title: c.title,
            cover: c.coverSrc ?? '',
            hasData: c.hasStoredCover,
        })
}

// 作品卡片大小（网格 min 列宽 px）：持久化到设置（disk，重启保留）。
// 拖动过程用本地 ref 平滑更新网格，松手(@change)才写一次设置，避免频繁写配置。
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
const hideBrokenImg = (e: Event) => {
    ;(e.target as HTMLImageElement).style.visibility = 'hidden'
}

// 作品封面加载失败 → 依次尝试 DMM digital → mono → 隐藏。
// 能正常加载的(已有封面)不会触发，等于「已有的跳过」。WebView 自带 HTTP 缓存。
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
        <!-- 档案卡 -->
        <div class="flex gap-4 border-b p-4">
            <div class="size-24 shrink-0 overflow-hidden rounded-lg bg-muted">
                <img
                    v-if="avatarSrc"
                    :src="avatarSrc"
                    referrerpolicy="no-referrer"
                    class="size-full object-cover"
                    @error="hideBrokenImg"
                />
            </div>
            <div class="min-w-0 flex-1">
                <div class="text-lg font-semibold">{{ actorName }}</div>
                <div class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                    <span v-if="profile?.birthday">生日 {{ profile.birthday }}</span>
                    <span v-if="profile?.height">身高 {{ profile.height }}cm</span>
                    <span v-if="profile?.cup">罩杯 {{ profile.cup }}</span>
                    <span v-if="measurements">三围 {{ measurements }}</span>
                </div>
                <div class="mt-2 text-sm text-muted-foreground">
                    <template v-if="hasWorks">
                        全集 {{ works.length }} 部 · 本地 {{ localCount }} · 缺失 {{ missingCount }}
                    </template>
                    <template v-else> 本地 {{ localVideos.length }} 部（未抓取全集） </template>
                </div>
                <Button size="sm" class="mt-2 gap-1" :disabled="fetching || !actorId" @click="fetchProfile">
                    <Loader2 v-if="fetching" class="size-4 animate-spin" />
                    <Download v-else class="size-4" />
                    {{ fetching ? '抓取中…' : hasFetched ? '重新抓取' : '抓取档案 / 全集' }}
                </Button>
            </div>
        </div>

        <!-- 作品 Tab + 卡片大小拖拽条 -->
        <div
            v-if="hasWorks || localVideos.length"
            class="flex items-center gap-1 border-b px-4 py-2"
        >
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
                <span class="text-xs text-muted-foreground">卡片</span>
                <input
                    v-model.number="cardSize"
                    type="range"
                    min="110"
                    max="300"
                    step="10"
                    class="w-28 cursor-pointer accent-primary"
                    title="封面大小"
                    @change="persistCardSize"
                />
            </div>
        </div>

        <!-- 作品网格 -->
        <ScrollArea class="min-h-0 flex-1">
            <div
                v-if="loading"
                class="flex items-center justify-center py-12 text-muted-foreground"
            >
                <Loader2 class="size-6 animate-spin" />
            </div>
            <div
                v-else-if="displayCards.length === 0"
                class="flex items-center justify-center py-12 text-sm text-muted-foreground"
            >
                暂无作品，点击「抓取档案 / 全集」获取
            </div>
            <div
                v-else
                class="grid gap-3 p-4"
                :style="{ gridTemplateColumns: `repeat(auto-fill, minmax(${cardSize}px, 1fr))` }"
            >
                <div
                    v-for="c in displayCards"
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
