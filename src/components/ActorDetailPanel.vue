<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { toast } from 'vue-sonner'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Loader2, Download } from 'lucide-vue-next'
import type { Video } from '@/types'

interface Props {
    actorId: number | null
    actorName: string
    localVideos: Video[]
}
const props = defineProps<Props>()
const emit = defineEmits<{
    (e: 'open-video', videoId: string): void
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

const loadDetail = async () => {
    if (!props.actorId) {
        profile.value = null
        works.value = []
        return
    }
    loading.value = true
    try {
        const res = await invoke<{ profile: ActorProfile; works: ActorWork[] }>('get_actor_detail', {
            actorId: props.actorId,
        })
        profile.value = res.profile
        works.value = res.works ?? []
    } catch (e) {
        console.error('获取演员详情失败:', e)
    } finally {
        loading.value = false
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

const fetchProfile = async () => {
    if (!props.actorId || fetching.value) return
    fetching.value = true
    try {
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
        fetching.value = false
    }
}

const hasWorks = computed(() => works.value.length > 0)
const localCount = computed(() => works.value.filter((w) => w.status === 'local').length)
const missingCount = computed(() => works.value.filter((w) => w.status !== 'local').length)

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
}

// 已抓全集 → 显示全集（可切 Tab）；未抓 → 显示本地作品（来自媒体库）
const displayCards = computed<Card[]>(() => {
    if (hasWorks.value) {
        let ws = works.value
        if (activeTab.value === 'local') ws = ws.filter((w) => w.status === 'local')
        else if (activeTab.value === 'missing') ws = ws.filter((w) => w.status !== 'local')
        return ws.map((w) => ({
            key: w.code,
            coverSrc: w.coverUrl || null,
            code: w.code,
            title: w.title || '',
            status: w.status === 'local' ? 'local' : 'missing',
            videoId: w.localVideoId || null,
        }))
    }
    return props.localVideos.map((v) => ({
        key: v.id,
        coverSrc: coverOf(v),
        code: v.localId || '',
        title: v.title || '',
        status: 'local' as const,
        videoId: v.id,
    }))
})

const onCardClick = (c: Card) => {
    if (c.videoId) emit('open-video', c.videoId)
}
const hideBrokenImg = (e: Event) => {
    ;(e.target as HTMLImageElement).style.visibility = 'hidden'
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
                    {{ fetching ? '抓取中…' : '抓取档案 / 全集' }}
                </Button>
            </div>
        </div>

        <!-- 作品 Tab（仅在已抓全集时显示） -->
        <div v-if="hasWorks" class="flex items-center gap-1 border-b px-4 py-2">
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
        </div>

        <!-- 作品网格 -->
        <ScrollArea class="flex-1">
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
            <div v-else class="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3 p-4">
                <div
                    v-for="c in displayCards"
                    :key="c.key"
                    class="group"
                    :class="c.videoId ? 'cursor-pointer' : ''"
                    @click="onCardClick(c)"
                >
                    <div class="relative aspect-[3/2] overflow-hidden rounded-md bg-muted">
                        <img
                            v-if="c.coverSrc"
                            :src="c.coverSrc"
                            referrerpolicy="no-referrer"
                            loading="lazy"
                            class="size-full object-cover transition group-hover:scale-105"
                            @error="hideBrokenImg"
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
