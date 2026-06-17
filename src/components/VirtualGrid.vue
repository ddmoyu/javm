<script setup lang="ts">
import { ref, computed, watch, nextTick, onActivated, onDeactivated } from 'vue'
import { useRouter } from 'vue-router'
import { useElementSize } from '@vueuse/core'
import VideoCard from './VideoCard.vue'
import VideoListItem from './VideoListItem.vue'
import type { Video } from '@/types'
import type { ViewMode } from '@/types/settings'
import { openWithPlayer, openVideoPlayerWindow } from '@/lib/tauri'
import { useSettingsStore } from '@/stores/settings'
import { COVER_LAYOUTS, WATERFALL_ROW_HEIGHT, WATERFALL_NO_COVER_WIDTH } from '@/utils/constants'
import { Button } from '@/components/ui/button'

interface Props {
  items: Video[]
  loading?: boolean
  viewMode?: ViewMode
}

const props = withDefaults(defineProps<Props>(), {
  loading: false,
  viewMode: 'card',
})

const emit = defineEmits<{
  (e: 'select', video: Video): void
  (e: 'scrape', video: Video): void
}>()

const router = useRouter()
const settingsStore = useSettingsStore()

// 封面布局（横屏/竖屏）随设置变化
const coverLayout = computed(() =>
  COVER_LAYOUTS[settingsStore.settings.general.coverType] || COVER_LAYOUTS.landscape,
)

// 容器引用
const containerRef = ref<HTMLElement>()

// 监听容器尺寸变化，页面从隐藏恢复时常见的是高度先为 0 再恢复
const { width: containerWidth, height: containerHeight } = useElementSize(containerRef)

// 响应式列数配置（卡片宽度随封面类型变化）
const columnConfig = computed(() => ({
  cardWidth: coverLayout.value.cardWidth,
  gap: 16,         // 间距
  minColumns: 1,
  maxColumns: 10,
}))

const coverAspectRatio = computed(() => coverLayout.value.coverAspectRatio)
const OVERSCAN_ROWS = 3

// 是否为列表模式
const isListMode = computed(() => props.viewMode === 'list')

// 是否为瀑布流(等高画廊)模式：封面固定高度、宽度按比例自适应，行虚拟化
const isWaterfall = computed(() => props.viewMode === 'waterfall')

const WATERFALL_GAP = 16
// 等高画廊单行高度 = 封面固定高 + 信息区 + 行间距
const waterfallRowHeight = WATERFALL_ROW_HEIGHT + 60 + WATERFALL_GAP

// 单张封面在画廊中的宽度（= 固定高度 × 封面宽高比；无封面用窄占位，缺尺寸用设置默认比例）
const itemGalleryWidth = (video: Video): number => {
  const hasCover = !!(video.poster || video.thumb)
  if (!hasCover) return WATERFALL_NO_COVER_WIDTH
  let ratio: number
  if (video.coverWidth && video.coverHeight && video.coverHeight > 0) {
    ratio = video.coverWidth / video.coverHeight
  } else {
    // 缺尺寸（未回填）回退到当前封面类型的默认比例（宽/高）
    ratio = 1 / coverLayout.value.coverAspectRatio
  }
  return Math.round(WATERFALL_ROW_HEIGHT * ratio)
}

// 按容器宽度把视频贪心打包成等高行（行尾自然参差）
const waterfallRows = computed<Video[][]>(() => {
  if (!isWaterfall.value) return []
  const availableWidth = (containerWidth.value || 800) - WATERFALL_GAP * 2
  const rows: Video[][] = []
  let current: Video[] = []
  let currentWidth = 0
  for (const video of props.items) {
    const w = itemGalleryWidth(video)
    const needed = currentWidth === 0 ? w : currentWidth + WATERFALL_GAP + w
    if (currentWidth > 0 && needed > availableWidth) {
      rows.push(current)
      current = []
      currentWidth = 0
    }
    current.push(video)
    currentWidth = currentWidth === 0 ? w : currentWidth + WATERFALL_GAP + w
  }
  if (current.length) rows.push(current)
  return rows
})

// 计算列数 - 列表模式固定1列
const columns = computed(() => {
  if (isListMode.value) return 1
  const width = containerWidth.value || 800
  const cfg = columnConfig.value
  const availableWidth = width - cfg.gap * 2 // 左右padding

  // 计算可容纳的列数（使用固定卡片宽度）
  const cols = Math.floor((availableWidth + cfg.gap) / (cfg.cardWidth + cfg.gap))

  return Math.max(cfg.minColumns, Math.min(cfg.maxColumns, cols))
})

// 计算行数
const rowCount = computed(() =>
  isWaterfall.value ? waterfallRows.value.length : Math.ceil(props.items.length / columns.value),
)

// 卡片高度（列表模式使用固定行高）
const rowHeight = computed(() => {
  if (isListMode.value) return 126 // 列表行高
  if (isWaterfall.value) return waterfallRowHeight
  const coverHeight = columnConfig.value.cardWidth * coverAspectRatio.value
  return coverHeight + 60 + columnConfig.value.gap // 封面高度 + 信息区域 + 行间距
})

const scrollTop = ref(0)
const savedScrollTop = ref(0)

// 获取某一行的视频
const getRowItems = (rowIndex: number): Video[] => {
  if (isWaterfall.value) return waterfallRows.value[rowIndex] ?? []
  const startIndex = rowIndex * columns.value
  return props.items.slice(startIndex, startIndex + columns.value)
}

interface VirtualRow {
  index: number
  key: string
  start: number
  size: number
}

const visibleRange = computed(() => {
  const itemCount = rowCount.value
  const currentRowHeight = rowHeight.value
  const viewportHeight = Math.max(containerHeight.value, currentRowHeight)

  if (itemCount === 0 || currentRowHeight <= 0) {
    return { start: 0, end: 0 }
  }

  const firstVisibleRow = Math.floor(scrollTop.value / currentRowHeight)
  const visibleRowCount = Math.ceil(viewportHeight / currentRowHeight)
  const start = Math.max(0, firstVisibleRow - OVERSCAN_ROWS)
  const end = Math.min(itemCount, firstVisibleRow + visibleRowCount + OVERSCAN_ROWS)

  return { start, end }
})

const virtualRows = computed<VirtualRow[]>(() => {
  const rows: VirtualRow[] = []
  const currentRowHeight = rowHeight.value

  for (let index = visibleRange.value.start; index < visibleRange.value.end; index += 1) {
    rows.push({
      index,
      key: String(index),
      start: index * currentRowHeight,
      size: currentRowHeight,
    })
  }

  return rows
})

const totalHeight = computed(() => rowCount.value * rowHeight.value)

// 处理视频点击
const handleVideoClick = (video: Video) => {
  emit('select', video)
}

const handleScrape = (video: Video) => {
  emit('scrape', video)
}

// 处理播放
const handleVideoPlay = async (video: Video) => {
  try {
    const settingsStore = useSettingsStore()
    const isSoftware = settingsStore.settings.general.playMethod === 'software'
    if (isSoftware) {
      await openVideoPlayerWindow(video.videoPath, video.title || video.originalTitle || 'Unknown Video', false)
    } else {
      await openWithPlayer(video.videoPath)
    }
  } catch (e) {
    console.error('Failed to play video:', e)
  }
}

// 恢复滚动并以容器真实 scrollTop 同步虚拟化基准，保证两者一致
const restoreScrollAndSync = () => {
  const container = containerRef.value
  if (!container) {
    return
  }

  if (savedScrollTop.value > 0 && container.scrollTop !== savedScrollTop.value) {
    container.scrollTop = savedScrollTop.value
  }

  // 关键：scrollTop.value 必须取自容器实际滚动值，否则虚拟化按错误偏移渲染，
  // 行被放到视口之外，表现为切回后空白、需手动滚动才显示
  scrollTop.value = container.scrollTop
}

// KeepAlive 切回时用双 rAF：第一帧等本帧布局（totalHeight 等）落地后恢复滚动，
// 第二帧再兜底同步一次（此时 ResizeObserver 已更新容器尺寸），避免 nextTick 微任务
// 早于布局/尺寸测量导致基准读到旧值。
const applySavedScrollPosition = () => {
  requestAnimationFrame(() => {
    restoreScrollAndSync()
    requestAnimationFrame(restoreScrollAndSync)
  })
}

const syncLayout = async () => {
  await nextTick()
  scrollTop.value = containerRef.value?.scrollTop ?? savedScrollTop.value
}

const handleScroll = () => {
  const currentScrollTop = containerRef.value?.scrollTop ?? 0
  scrollTop.value = currentScrollTop
  savedScrollTop.value = currentScrollTop
}

watch([() => props.items.length, columns, () => props.viewMode, containerWidth, containerHeight, coverLayout], () => {
  void syncLayout()
})

// KeepAlive 重新激活后同步滚动和容器尺寸，避免隐藏期间恢复为空白
onActivated(() => {
  applySavedScrollPosition()
})

onDeactivated(() => {
  // 注意：KeepAlive 停用时，Vue 已先把本组件 DOM 移入分离容器，此刻 container.scrollTop
  // 多半已被重置为 0。若用它覆盖 savedScrollTop 会把真实滚动进度清零（切回即丢失）。
  // 实际滚动位置已由 handleScroll 持续记录，这里仅在仍能读到有效值时才更新。
  const current = containerRef.value?.scrollTop ?? 0
  if (current > 0) {
    savedScrollTop.value = current
  }
})

defineExpose({
  refreshLayout: syncLayout,
})
</script>

<template>
  <div ref="containerRef" class="h-full overflow-auto px-1" @scroll="handleScroll">
    <!-- 加载状态 -->
    <div v-if="loading" class="flex items-center justify-center h-full">
      <div class="text-center text-muted-foreground">
        <div class="animate-spin size-8 border-4 border-primary border-t-transparent rounded-full mx-auto mb-4"></div>
        <p>加载中...</p>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else-if="items.length === 0" class="flex flex-col items-center justify-center h-full gap-4">
      <div class="text-center text-muted-foreground">
        <p class="text-lg mb-2">暂无视频</p>
        <p class="text-sm">请前往目录管理界面添加视频</p>
      </div>
      <Button variant="outline" @click="router.push('/directory')">
        去目录管理
      </Button>
    </div>

    <!-- 虚拟滚动网格 -->
    <div v-else :style="{
      height: `${totalHeight}px`,
      position: 'relative',
    }">
      <!-- 瀑布流(等高画廊)模式：封面固定高度、宽度按比例自适应，行虚拟化 -->
      <template v-if="isWaterfall">
        <div v-for="virtualRow in virtualRows" :key="virtualRow.index" class="flex gap-4 px-4 justify-center"
          :style="{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: `${virtualRow.size}px`,
            transform: `translateY(${virtualRow.start}px)`,
            paddingBottom: '16px',
          }">
          <VideoCard v-for="video in getRowItems(virtualRow.index)" :key="video.id" :video="video"
            :gallery-height="WATERFALL_ROW_HEIGHT" @click="handleVideoClick" @play="handleVideoPlay"
            @scrape="handleScrape" />
        </div>
      </template>

      <!-- 列表模式 -->
      <template v-else-if="isListMode">
        <div v-for="virtualRow in virtualRows" :key="virtualRow.index" :style="{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: `${virtualRow.size}px`,
          transform: `translateY(${virtualRow.start}px)`,
        }">
          <VideoListItem v-for="video in getRowItems(virtualRow.index)" :key="video.id" :video="video"
            @click="handleVideoClick" @play="handleVideoPlay" @scrape="handleScrape" />
        </div>
      </template>

      <!-- 卡片模式 -->
      <template v-else>
        <div v-for="virtualRow in virtualRows" :key="virtualRow.index" :style="{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: `${virtualRow.size}px`,
          transform: `translateY(${virtualRow.start}px)`,
          display: 'grid',
          gap: '16px',
          gridTemplateColumns: `repeat(${columns}, ${columnConfig.cardWidth}px)`,
          justifyContent: 'center',
          paddingBottom: '16px',
        }">
          <VideoCard v-for="video in getRowItems(virtualRow.index)" :key="video.id" :video="video"
            @click="handleVideoClick" @play="handleVideoPlay" @scrape="handleScrape" />
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* shadcn 风格滚动条 - 悬浮显示 */
.h-full.overflow-auto {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}

.h-full.overflow-auto:hover {
  scrollbar-color: hsl(0 0% 20%) transparent;
}

.h-full.overflow-auto::-webkit-scrollbar {
  width: 10px;
}

.h-full.overflow-auto::-webkit-scrollbar-track {
  background: transparent;
}

.h-full.overflow-auto::-webkit-scrollbar-thumb {
  background-color: transparent;
  border-radius: 9999px;
  border: 2px solid transparent;
  background-clip: content-box;
  transition: background-color 0.2s;
}

.h-full.overflow-auto:hover::-webkit-scrollbar-thumb {
  background-color: hsl(0 0% 20%);
}

.h-full.overflow-auto::-webkit-scrollbar-thumb:hover {
  background-color: hsl(0 0% 30%);
}
</style>
