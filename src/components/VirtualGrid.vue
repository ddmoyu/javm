<script setup lang="ts">
import { ref, computed, watch, nextTick, onActivated } from 'vue'
import { useRouter } from 'vue-router'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { useElementSize } from '@vueuse/core'
import VideoCard from './VideoCard.vue'
import VideoListItem from './VideoListItem.vue'
import type { Video } from '@/types'
import type { ViewMode } from '@/types/settings'
import { openWithPlayer, openVideoPlayerWindow } from '@/lib/tauri'
import { useSettingsStore } from '@/stores/settings'
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

// 容器引用
const containerRef = ref<HTMLElement>()

// 使用 useElementSize 监听容器宽度变化
const { width: containerWidth } = useElementSize(containerRef)

// 响应式列数配置
const columnConfig = {
  cardWidth: 280,  // 固定卡片宽度
  gap: 16,         // 间距
  minColumns: 1,
  maxColumns: 10,
}

const coverAspectRatio = 536 / 800

// 是否为列表模式
const isListMode = computed(() => props.viewMode === 'list')

// 计算列数 - 列表模式固定1列
const columns = computed(() => {
  if (isListMode.value) return 1
  const width = containerWidth.value || 800
  const availableWidth = width - columnConfig.gap * 2 // 左右padding

  // 计算可容纳的列数（使用固定卡片宽度）
  const cols = Math.floor((availableWidth + columnConfig.gap) / (columnConfig.cardWidth + columnConfig.gap))

  return Math.max(columnConfig.minColumns, Math.min(columnConfig.maxColumns, cols))
})

// 计算行数
const rowCount = computed(() => Math.ceil(props.items.length / columns.value))

// 卡片高度（列表模式使用固定行高）
const cardHeight = computed(() => {
  if (isListMode.value) return 126 // 列表行高
  const coverHeight = columnConfig.cardWidth * coverAspectRatio
  return coverHeight + 60 + columnConfig.gap // 封面高度 + 信息区域 + 行间距
})

// 虚拟化器
const virtualizer = useVirtualizer({
  get count() { return rowCount.value },
  getScrollElement: () => containerRef.value ?? null,
  estimateSize: () => cardHeight.value,
  overscan: 3,
})

// 获取某一行的视频
const getRowItems = (rowIndex: number): Video[] => {
  const startIndex = rowIndex * columns.value
  return props.items.slice(startIndex, startIndex + columns.value)
}

// 虚拟行
const virtualRows = computed(() => virtualizer.value.getVirtualItems())

// 总高度
const totalHeight = computed(() => virtualizer.value.getTotalSize())

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

const remeasureVirtualizer = async () => {
  await nextTick()
  virtualizer.value.measure()
}

// 监听数据和布局变化，重新计算虚拟化
watch([() => props.items, columns, () => props.viewMode], () => {
  void remeasureVirtualizer()
})

// KeepAlive 重新激活后强制重测，避免隐藏期间的尺寸缓存导致列表空白
onActivated(() => {
  void remeasureVirtualizer()
})
</script>

<template>
  <div ref="containerRef" class="h-full overflow-auto px-1">
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
      <!-- 列表模式 -->
      <template v-if="isListMode">
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
          gridTemplateColumns: `repeat(${columns}, 280px)`,
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
