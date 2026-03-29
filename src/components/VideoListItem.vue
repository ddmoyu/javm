<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Clock, Play, Monitor, Folder, Trash2, Search, Film, Info, FolderInput, Star } from 'lucide-vue-next'
import { Badge } from '@/components/ui/badge'
import type { Video, Directory } from '@/types'
import { SCAN_STATUS_TEXT, SCAN_STATUS_VARIANT } from '@/utils/constants'
import { formatDuration, formatRating, formatFileSize } from '@/utils/format'
import { useVideoStore } from '@/stores'
import { toImageSrc } from '@/utils/image'
import {
  openInExplorer,
  moveVideoFile,
} from '@/lib/tauri'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import DeleteVideoDialog from './DeleteVideoDialog.vue'

interface Props {
  video: Video
}

const props = defineProps<Props>()

const emit = defineEmits<{
  (e: 'click', video: Video): void
  (e: 'play', video: Video): void
  (e: 'scrape', video: Video): void
}>()

const videoStore = useVideoStore()
const imgError = ref(false)
const showDeleteDialog = ref(false)

const coverStateKey = computed(() => [
  props.video.poster || '',
  props.video.thumb || '',
  props.video.scanStatus,
  videoStore.coverVersions[props.video.id] || 0,
].join('|'))

watch(coverStateKey, () => {
  imgError.value = false
}, { immediate: true })

// 图片源
const imageSrc = computed(() => {
  if (imgError.value) return null
  const path = props.video.thumb || props.video.poster
  const src = toImageSrc(path)
  if (!src) return null
  const version = videoStore.coverVersions[props.video.id]
  return version ? `${src}${src.includes('?') ? '&' : '?'}t=${version}` : src
})

const handleClick = () => emit('click', props.video)
const handlePlay = (e?: Event) => { e?.stopPropagation(); emit('play', props.video) }
const handleOpenDir = async () => { await openInExplorer(props.video.videoPath) }
const handleScrape = () => emit('scrape', props.video)
const handleDelete = () => { showDeleteDialog.value = true }

const handleMove = async (dir: Directory) => {
  try {
    await moveVideoFile(props.video.id, dir.path)
    videoStore.removeVideo(props.video.id)
  } catch (e) {
    console.error('Failed to move video:', e)
    alert('移动失败: ' + e)
  }
}

const onImgError = () => { imgError.value = true }
</script>

<template>
  <ContextMenu>
    <ContextMenuTrigger as-child>
      <div
        class="flex items-center gap-4 px-4 py-3 border-b hover:bg-accent/50 transition-colors cursor-pointer"
        @click="handleClick"
      >
        <!-- 缩略图 -->
        <div class="h-[100px] aspect-[800/536] shrink-0 rounded overflow-hidden bg-muted flex items-center justify-center">
          <img
            v-if="imageSrc"
            :src="imageSrc"
            :alt="video.title"
            class="w-full h-full object-contain"
            loading="lazy"
            @error="onImgError"
          />
          <Film v-else class="size-5 text-muted-foreground/50" />
        </div>

        <!-- 信息区域 -->
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <h3 class="text-sm font-medium truncate">{{ video.title || video.originalTitle }}</h3>
            <Badge
              v-if="video.scanStatus !== 2"
              :variant="SCAN_STATUS_VARIANT[video.scanStatus]"
              class="shrink-0 text-[10px] h-5"
            >
              {{ SCAN_STATUS_TEXT[video.scanStatus] }}
            </Badge>
          </div>
          <div class="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
            <span v-if="video.localId" class="font-mono bg-muted px-1 rounded">{{ video.localId }}</span>
            <span v-if="video.studio" class="truncate max-w-[120px]">{{ video.studio }}</span>
            <span v-if="video.premiered">{{ video.premiered }}</span>
          </div>
        </div>

        <!-- 右侧元数据 -->
        <div class="flex items-center gap-4 shrink-0 text-xs text-muted-foreground">
          <span v-if="video.rating" class="flex items-center gap-1 text-yellow-500">
            <Star class="size-3" fill="currentColor" />
            {{ formatRating(video.rating) }}
          </span>
          <span v-if="video.duration" class="flex items-center gap-1">
            <Clock class="size-3" />
            {{ formatDuration(video.duration) }}
          </span>
          <span v-if="video.resolution" class="flex items-center gap-1">
            <Monitor class="size-3" />
            {{ video.resolution }}
          </span>
          <span v-if="video.fileSize" class="w-16 text-right">
            {{ formatFileSize(video.fileSize) }}
          </span>
        </div>
      </div>
    </ContextMenuTrigger>

    <ContextMenuContent class="w-48">
      <ContextMenuItem @select="handlePlay">
        <Play class="mr-2 size-4" />
        播放视频
      </ContextMenuItem>
      <ContextMenuItem @select="handleClick">
        <Info class="mr-2 size-4" />
        查看详情
      </ContextMenuItem>
      <ContextMenuItem @select="handleOpenDir">
        <Folder class="mr-2 size-4" />
        打开目录
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem @select="handleScrape">
        <Search class="mr-2 size-4" />
        刮削数据
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuSub>
        <ContextMenuSubTrigger>
          <FolderInput class="mr-2 size-4" />
          移动到目录...
        </ContextMenuSubTrigger>
        <ContextMenuSubContent class="max-w-[400px] min-w-[200px] w-auto">
          <ContextMenuItem v-for="dir in videoStore.directories" :key="dir.id" @select="handleMove(dir)">
            <Folder class="mr-2 size-4 shrink-0" />
            <span class="truncate" :title="dir.path">{{ dir.path }}</span>
          </ContextMenuItem>
          <ContextMenuItem v-if="videoStore.directories.length === 0" disabled>
            无可用目录
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSeparator />
      <ContextMenuItem class="text-destructive focus:text-destructive" @select="handleDelete">
        <Trash2 class="mr-2 size-4" />
        删除视频
      </ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>

  <DeleteVideoDialog v-model:open="showDeleteDialog" :video="props.video" />
</template>
