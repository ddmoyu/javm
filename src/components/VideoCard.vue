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
import { COVER_LAYOUTS, WATERFALL_NO_COVER_WIDTH } from '@/utils/constants'
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
  /** 等高画廊(瀑布流)模式：传入封面固定高度(px)，宽度按封面比例自适应；不传则为普通卡片 */
  galleryHeight?: number
}

const props = defineProps<Props>()

// 是否为等高画廊模式
const isGallery = computed(() => props.galleryHeight != null)

const emit = defineEmits<{
  (e: 'click', video: Video): void
  (e: 'play', video: Video): void
  (e: 'scrape', video: Video): void
}>()

const videoStore = useVideoStore()
const settingsStore = useSettingsStore()
const imgError = ref(false)
const showDeleteDialog = ref(false)

// 封面布局（横屏/竖屏）随设置变化
const coverLayout = computed(() =>
  COVER_LAYOUTS[settingsStore.settings.general.coverType] || COVER_LAYOUTS.landscape,
)

// 是否有封面图（按 poster/thumb 是否存在判断，与虚拟网格打包逻辑保持一致）
const hasCover = computed(() => !!(props.video.poster || props.video.thumb))

// 画廊模式下卡片显式宽度 = 固定高 × 封面比例（缺尺寸用设置默认比例，无封面用窄占位）。
// 用显式宽度而非依赖图片加载，避免懒加载未完成时卡片塌成 0 宽。
const galleryWidth = computed(() => {
  if (!props.galleryHeight) return 0
  if (!hasCover.value) return WATERFALL_NO_COVER_WIDTH
  const { coverWidth, coverHeight } = props.video
  const ratio = coverWidth && coverHeight && coverHeight > 0
    ? coverWidth / coverHeight
    : 1 / coverLayout.value.coverAspectRatio
  return Math.round(props.galleryHeight * ratio)
})

// 卡片根容器样式：画廊模式按比例算显式宽度，普通模式固定宽度
const cardStyle = computed(() =>
  isGallery.value ? { width: `${galleryWidth.value}px` } : { width: `${coverLayout.value.cardWidth}px` },
)

// 封面容器样式：画廊模式显式宽高，普通模式按比例
const coverStyle = computed(() => {
  if (isGallery.value) {
    return { width: `${galleryWidth.value}px`, height: `${props.galleryHeight}px` }
  }
  return { aspectRatio: coverLayout.value.aspectStyle }
})

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
        class="video-card group relative overflow-hidden rounded-lg bg-card border shadow-sm hover:shadow-lg transition-all duration-300 cursor-pointer shrink-0"
        :style="cardStyle"
        @click="handleClick">

        <!-- 封面图 / 占位图 -->
        <div class="overflow-hidden bg-muted flex items-center justify-center relative"
          :style="coverStyle"
          @click.stop="handleCoverClick">
          <img v-if="imageSrc" :src="imageSrc" :alt="video.title || video.originalTitle"
            :class="isGallery ? 'w-full h-full object-contain block' : 'w-full h-full object-contain transition-transform duration-300'"
            loading="lazy" @error="onImgError" />

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
