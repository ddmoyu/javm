<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Clock, Play, Monitor, Folder, Trash2, Search, Film, Info, FolderInput, Star } from 'lucide-vue-next'
import { Badge } from '@/components/ui/badge'
import type { Video, Directory } from '@/types'
import { SCAN_STATUS_TEXT, SCAN_STATUS_VARIANT } from '@/utils/constants'
import { formatDuration, formatRating } from '@/utils/format'
import { useVideoStore } from '@/stores'
import { useSettingsStore } from '@/stores/settings'
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
const settingsStore = useSettingsStore()
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
  const path = props.video.poster || props.video.thumb
  const src = toImageSrc(path)
  if (!src) return null
  const version = videoStore.coverVersions[props.video.id]
  return version ? `${src}${src.includes('?') ? '&' : '?'}t=${version}` : src
})

// 是否显示状态徽章
const showStatusBadge = computed(() => {
  return props.video.scanStatus !== 2 // 非已完成状态显示徽章
})

const statusBadgeClass = computed(() => {
  if (props.video.scanStatus === 1) {
    return 'border-white/70 bg-black/25 text-white shadow-md backdrop-blur-md'
  }

  return ''
})

const statusTextClass = computed(() => {
  if (props.video.scanStatus === 1) {
    return 'font-semibold text-white mix-blend-difference'
  }

  return ''
})

// 处理点击 (查看详情)
const handleClick = () => {
  emit('click', props.video)
}

// 处理播放
const handlePlay = (e?: Event) => {
  e?.stopPropagation()
  emit('play', props.video)
}

const handleCoverClick = (e: MouseEvent) => {
  e.stopPropagation()
  if (settingsStore.settings.general.coverClickToPlay) {
    handlePlay()
    return
  }
  handleClick()
}

// 打开目录
const handleOpenDir = async () => {
  await openInExplorer(props.video.videoPath)
}

// 刮削
const handleScrape = async () => {
  emit('scrape', props.video)
}

// 删除文件
const handleDelete = () => {
  showDeleteDialog.value = true
}

// 移动到目录
const handleMove = async (dir: Directory) => {
  try {
    await moveVideoFile(props.video.id, dir.path)
    videoStore.removeVideo(props.video.id)
  } catch (e) {
    console.error('Failed to move video:', e)
    alert('移动失败: ' + e)
  }
}

const onImgError = () => {
  imgError.value = true
}
</script>

<template>
  <ContextMenu>
    <ContextMenuTrigger as-child>
      <div
        class="video-card group relative overflow-hidden rounded-lg bg-card border shadow-sm hover:shadow-lg transition-all duration-300 cursor-pointer w-[280px] shrink-0"
        @click="handleClick">

        <!-- 封面图 / 占位图 -->
        <div class="aspect-[800/536] overflow-hidden bg-muted flex items-center justify-center relative"
          @click.stop="handleCoverClick">
          <img v-if="imageSrc" :src="imageSrc" :alt="video.title || video.originalTitle"
            class="w-full h-full object-contain transition-transform duration-300" loading="lazy"
            @error="onImgError" />

          <div v-else class="flex flex-col items-center justify-center text-muted-foreground/50">
            <Film class="size-12 mb-2" />
            <span class="text-xs">No Cover</span>
          </div>

          <!-- 悬浮遮罩 (仅显示信息，无播放按钮) -->
          <div
            class="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-4">

            <div class="flex items-center gap-3 text-xs text-white/80">
              <span class="flex items-center gap-1 text-yellow-400">
                <Star class="size-3" fill="currentColor" />
                {{ formatRating(video.rating ?? 0) }}
              </span>
              <span class="flex items-center gap-1">
                <Clock class="size-3" />
                {{ formatDuration(video.duration || 0) }}
              </span>
              <span class="flex items-center gap-1">
                <Monitor class="size-3" />
                {{ video.resolution }}
              </span>
            </div>
          </div>
        </div>

        <!-- 底部信息（非悬浮状态） -->
        <div class="p-3">
          <h3 class="font-medium text-sm truncate mb-1" :title="video.title || video.originalTitle">
            {{ video.title || video.originalTitle }}
          </h3>
          <div class="flex items-center justify-between text-xs text-muted-foreground">
            <span v-if="video.localId" class="font-mono bg-muted px-1 rounded">
              {{ video.localId }}
            </span>

            <!-- 不显示评分 -->
            <span class="truncate max-w-[100px]" :title="video.studio">
              {{ video.studio }}
            </span>
          </div>
        </div>

        <!-- 状态徽章 -->
        <Badge v-if="showStatusBadge" :variant="SCAN_STATUS_VARIANT[video.scanStatus]"
          :class="['absolute top-2 right-2 z-10', statusBadgeClass]">
          <span :class="statusTextClass">{{ SCAN_STATUS_TEXT[video.scanStatus] }}</span>
        </Badge>
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

  <!-- 删除确认对话框 -->
  <DeleteVideoDialog
    v-model:open="showDeleteDialog"
    :video="props.video"
  />
</template>

<style scoped>
.video-card {
  container-type: inline-size;
}

/* 响应式字体大小 */
@container (max-width: 180px) {
  .video-card h3 {
    font-size: 0.75rem;
  }
}
</style>
