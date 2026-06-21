<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Loader2, Download, Star, Pencil, Check, X } from 'lucide-vue-next'
import { Input } from '@/components/ui/input'
import type { Video } from '@/types'
import { dmmCoverUrl, dmmMonoCoverUrl, isDmmPlaceholderSize, isDmmImageUrl } from '@/utils/dmm'
import { useSettingsStore, useFavoritesStore } from '@/stores'

const settingsStore = useSettingsStore()
const favoritesStore = useFavoritesStore()

// 收藏（按演员名）
const isFav = computed(() => favoritesStore.isFavorite('actor', props.actorName))
const toggleFav = () => favoritesStore.toggle('actor', props.actorName)
// 生日：截到日期、过滤零值（0001 等）。MetaTube 未知生日会回零值，需整规
const birthdayText = computed(() => {
    const raw = profile.value?.birthday
    const m = raw?.match(/(\d{4})-(\d{2})-(\d{2})/)
    if (!m || parseInt(m[1], 10) < 1900) return ''
    return `${m[1]}-${m[2]}-${m[3]}`
})

interface AliasRow {
    name: string
    lang: string
    isCanonical: boolean
}
interface Props {
    actorId: number | null
    actorName: string
    localVideos: Video[]
    // 该演员跨语言别名（中文/英文/日文/曾用名），由父组件经 entity_alias_expand 取得
    aliases?: AliasRow[]
}
const props = defineProps<Props>()
const emit = defineEmits<{
    (e: 'open-video', videoId: string): void
    (e: 'open-missing', payload: { code: string; title: string; cover: string; hasData: boolean }): void
    (e: 'refreshed'): void
    (e: 'aliases-changed'): void
}>()

// 多名字：展示（第一名为主名加粗，其余浅色小字）+ 编辑（一个输入框、逗号分隔所有名字）
const aliasEditing = ref(false)
const editText = ref('') // 编辑态：所有名字逗号分隔（第一个为主名 = 当前名）
const aliasBusy = ref(false)
const allAliases = computed<AliasRow[]>(() => props.aliases ?? [])
// 主名（默认名）：固定为 canonical 的名字；未固定时回退到当前查看名
const primaryName = computed(() => allAliases.value.find((a) => a.isCanonical)?.name ?? props.actorName)
// 除主名外的其它名字（展示态浅色小字列出）
const otherNames = computed(() =>
    allAliases.value.map((a) => a.name).filter((n) => n !== primaryName.value),
)

// 把编辑框文本拆成去重后的名字数组（支持中英文逗号、顿号、换行分隔）
function parseNames(text: string): string[] {
    const seen = new Set<string>()
    const out: string[] = []
    for (const raw of text.split(/[,，、\n]/)) {
        const n = raw.trim()
        if (n && !seen.has(n)) {
            seen.add(n)
            out.push(n)
        }
    }
    return out
}

// 进入编辑：预填所有名字（主名在前），逗号分隔
function startEdit() {
    editText.value = [primaryName.value, ...otherNames.value].join('，')
    aliasEditing.value = true
}

// 保存：解析名字 → 新增的归并、删除的拉黑；第一个名字固定为主名（默认名）
async function saveAliases() {
    if (aliasBusy.value) return
    const names = parseNames(editText.value)
    // 锚点：当前查看名必须在集合内（否则与本地视频归属脱节），缺失则补在末尾，不抢主名
    if (!names.includes(props.actorName)) names.push(props.actorName)
    if (names.length === 0) {
        aliasEditing.value = false
        return
    }
    const primary = names[0] // 第一个 = 主名（默认名）

    const currentNames = new Set([props.actorName, ...allAliases.value.map((a) => a.name)])
    const nextNames = new Set(names)
    const added = names.filter((n) => !currentNames.has(n))
    const removed = [...currentNames].filter((n) => n !== props.actorName && !nextNames.has(n))
    const currentPrimary = allAliases.value.find((a) => a.isCanonical)?.name ?? props.actorName
    const primaryChanged = primary !== currentPrimary

    if (added.length === 0 && removed.length === 0 && !primaryChanged) {
        aliasEditing.value = false
        return
    }

    aliasBusy.value = true
    try {
        // 新增任一名字：把全集一起归并到同一实体（已存在的幂等）
        if (added.length > 0) {
            await invoke('entity_alias_force_merge', { entityType: 'actor', names })
        }
        // 删除的名字逐个拉黑（永不复活）
        for (const n of removed) {
            await invoke('entity_alias_block', { entityType: 'actor', name: n })
        }
        // 第一个名字固定为主名：展示标题用它，抓取档案也优先用它搜源
        if (primaryChanged) {
            await invoke('entity_alias_pin_canonical', { entityType: 'actor', name: primary })
        }
        emit('aliases-changed')
        toast.success('已保存名字')
        aliasEditing.value = false
    } catch (e) {
        toast.error('保存失败: ' + String(e))
    } finally {
        aliasBusy.value = false
    }
}

// 编辑/保存切换：编辑态点击=保存，展示态点击=进入编辑
function toggleEdit() {
    if (aliasEditing.value) void saveAliases()
    else startEdit()
}

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
            // 传全部别名：跨多名字演员的不同 actor_id 合并作品，避免之前抓过却查到 0 部
            aliasNames: (props.aliases ?? []).map((a) => a.name),
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
        filterText.value = ''
        aliasEditing.value = false
        loadDetail()
        favoritesStore.load('actor')
    },
    { immediate: true },
)

// 别名集合（异步到位或编辑后变化）后静默重载：按全部别名跨 id 合并作品，
// 避免别名晚于 actorId 到达时漏掉之前抓过的全集
watch(
    () => (props.aliases ?? []).map((a) => a.name).join('|'),
    () => {
        if (props.actorId) loadDetail(true)
    },
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
            // 传名字候选（主名在前）：后端逐个搜源，主名搜不到再回退其它别名
            { actorId: props.actorId, nameCandidates: [primaryName.value, ...otherNames.value] },
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

// 停止抓取：通知后端取消，已抓到的页（每页已落库）会保留
const cancelFetch = async () => {
    if (!props.actorId) return
    try {
        await invoke('cancel_actor_fetch', { actorId: props.actorId })
    } catch (e) {
        console.error('停止抓取失败:', e)
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

// 番号/名字过滤：边输入边过滤，作用于当前 Tab 的卡片（番号或标题部分匹配，忽略大小写）
const filterText = ref('')
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

// 封面加载成功但其实是 DMM 占位图（now_printing / noimage，封面不存在时 302 跳过去的）：
// 按固定尺寸精准识别，当成加载失败处理，走 digital→mono→隐藏 兜底，不把占位图当有效封面。
const onCoverLoad = (e: Event, code: string) => {
    const img = e.target as HTMLImageElement
    const src = img.currentSrc || img.src || ''
    if (isDmmImageUrl(src) && isDmmPlaceholderSize(img.naturalWidth, img.naturalHeight)) onCoverError(e, code)
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
                <!-- 名字行：编辑态=一个输入框（逗号分隔所有名字）；展示态=第一名加粗 + 其余浅色小字 -->
                <Input
                    v-if="aliasEditing"
                    v-model="editText"
                    class="h-8 max-w-md text-sm"
                    placeholder="用逗号分隔多个名字，第一个为主名"
                    :disabled="aliasBusy"
                    @keyup.enter="saveAliases"
                />
                <div v-else class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span class="text-lg font-semibold">{{ primaryName }}</span>
                    <span
                        v-for="n in otherNames"
                        :key="n"
                        class="text-sm text-muted-foreground/70"
                    >{{ n }}</span>
                </div>

                <div class="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                    <span v-if="birthdayText">生日 {{ birthdayText }}</span>
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
                <!-- 抓取 + 收藏 + 编辑/保存：图标后置 -->
                <div class="mt-2 flex items-center gap-2">
                    <Button size="sm" class="gap-1" :disabled="fetching || !actorId" @click="fetchProfile">
                        <Loader2 v-if="fetching" class="size-4 animate-spin" />
                        <Download v-else class="size-4" />
                        {{ fetching ? '抓取中…' : hasFetched ? '重新抓取' : '抓取档案 / 全集' }}
                    </Button>
                    <Button v-if="fetching" size="sm" variant="outline" class="gap-1" @click="cancelFetch">
                        <X class="size-4" />
                        停止
                    </Button>
                    <button
                        type="button"
                        class="shrink-0 text-muted-foreground transition hover:text-yellow-500"
                        :class="isFav ? 'text-yellow-500' : ''"
                        title="收藏演员"
                        @click="toggleFav"
                    >
                        <Star class="size-5" :fill="isFav ? 'currentColor' : 'none'" />
                    </button>
                    <button
                        type="button"
                        class="shrink-0 text-muted-foreground transition hover:text-primary disabled:opacity-50"
                        :class="aliasEditing ? 'text-primary' : ''"
                        :title="aliasEditing ? '保存名字' : '编辑名字'"
                        :disabled="aliasBusy"
                        @click="toggleEdit"
                    >
                        <component :is="aliasEditing ? Check : Pencil" class="size-4" />
                    </button>
                </div>
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
                    max="500"
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
