<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import {
    Building2,
    Layers,
    Clapperboard,
    Users,
    Tag,
    ArrowLeft,
    Search,
    ArrowDownAZ,
    ArrowDown01,
} from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import VirtualGrid from '@/components/VirtualGrid.vue'
import VideoDetailDialog from '@/components/VideoDetailDialog.vue'
import ScrapeDialog from '@/components/ScrapeDialog.vue'
import ActorDetailPanel from '@/components/ActorDetailPanel.vue'
import { useVideoStore } from '@/stores'
import type { Video } from '@/types'
import { FACET_TYPES, type FacetType, facetValuesOf, aggregateFacet } from '@/utils/facet'

const videoStore = useVideoStore()

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
const actorAvatarSrc = (name: string): string | null => {
    const a = actorMap.value.get(name)
    if (!a) return null
    if (a.avatarPath) return convertFileSrc(a.avatarPath)
    if (a.avatarUrl) return a.avatarUrl
    return null
}
const hideBrokenImg = (e: Event) => {
    ;(e.target as HTMLImageElement).style.display = 'none'
}

const facetType = ref<FacetType>('studio')
const selectedValue = ref<string | null>(null)
const search = ref('')
const sortByCount = ref(true) // true=按作品数, false=按名称

const ICONS: Record<FacetType, any> = {
    studio: Building2,
    series: Layers,
    director: Clapperboard,
    actor: Users,
    genre: Tag,
}

onMounted(() => {
    if (videoStore.videos.length === 0) videoStore.fetchVideos()
    fetchActors()
})

const switchFacet = (t: FacetType) => {
    facetType.value = t
    selectedValue.value = null
    search.value = ''
}

const currentFacetLabel = computed(
    () => FACET_TYPES.find((f) => f.type === facetType.value)?.label ?? '',
)

// 分面值列表（本地库派生 + 搜索 + 排序）
const facetValues = computed(() => {
    let arr = aggregateFacet(videoStore.videos, facetType.value)
    const kw = search.value.trim().toLowerCase()
    if (kw) arr = arr.filter((x) => x.name.toLowerCase().includes(kw))
    arr.sort((a, b) =>
        sortByCount.value
            ? b.count - a.count || a.name.localeCompare(b.name, 'zh-CN')
            : a.name.localeCompare(b.name, 'zh-CN'),
    )
    return arr
})

// 分面详情：归属该取值的作品
const detailVideos = computed<Video[]>(() => {
    if (!selectedValue.value) return []
    return videoStore.videos.filter((v) =>
        facetValuesOf(v, facetType.value).includes(selectedValue.value!),
    )
})

// 视频详情 / 刮削
const detailDialogOpen = ref(false)
const selectedVideo = ref<Video | null>(null)
const scrapeDialogRef = ref<InstanceType<typeof ScrapeDialog> | null>(null)

const handleVideoSelect = (video: Video) => {
    selectedVideo.value = video
    detailDialogOpen.value = true
}
const handleVideoUpdated = (video: Video) => {
    selectedVideo.value = video
}
const handleScrape = (video: Video) => {
    scrapeDialogRef.value?.open(video)
}

// 演员详情面板：当前选中演员的 id（用于抓取档案/全集）
const selectedActorId = computed<number | null>(() =>
    facetType.value === 'actor' && selectedValue.value
        ? actorMap.value.get(selectedValue.value)?.id ?? null
        : null,
)
const openVideoById = (videoId: string) => {
    const v = videoStore.videos.find((x) => x.id === videoId)
    if (v) handleVideoSelect(v)
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
                <div class="relative">
                    <Search class="absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input v-model="search" :placeholder="`搜索${currentFacetLabel}`" class="h-8 w-48 pl-8" />
                </div>
                <Button variant="ghost" size="sm" class="h-8 gap-1" @click="sortByCount = !sortByCount">
                    <component :is="sortByCount ? ArrowDown01 : ArrowDownAZ" class="size-4" />
                    {{ sortByCount ? '作品数' : '名称' }}
                </Button>
            </div>
        </div>

        <!-- 分面值列表 -->
        <template v-if="!selectedValue">
            <div
                v-if="facetValues.length === 0"
                class="flex flex-1 items-center justify-center text-muted-foreground"
            >
                <p>暂无{{ currentFacetLabel }}数据</p>
            </div>
            <ScrollArea v-else class="flex-1">
                <div class="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 p-4">
                    <button
                        v-for="fv in facetValues"
                        :key="fv.name"
                        class="flex items-center gap-2 rounded-lg border bg-card p-3 text-left transition hover:border-primary hover:bg-accent"
                        @click="selectedValue = fv.name"
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
                    </button>
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
                <span v-if="facetType !== 'actor'" class="text-xs text-muted-foreground">{{ detailVideos.length }} 部</span>
            </div>

            <!-- 演员：档案 + 作品全集（本地有/缺失）；其它分面：本地作品网格 -->
            <ActorDetailPanel
                v-if="facetType === 'actor'"
                :actor-id="selectedActorId"
                :actor-name="selectedValue!"
                :local-videos="detailVideos"
                @open-video="openVideoById"
                @refreshed="fetchActors"
            />
            <div v-else class="flex-1 overflow-hidden py-4">
                <VirtualGrid :items="detailVideos" @select="handleVideoSelect" @scrape="handleScrape" />
            </div>
        </template>

        <VideoDetailDialog
            v-model:open="detailDialogOpen"
            :video="selectedVideo"
            @video-updated="handleVideoUpdated"
        />
        <ScrapeDialog ref="scrapeDialogRef" @success="videoStore.fetchVideos()" />
    </div>
</template>
