<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import { Search, ArrowUpDown, Filter, X, LayoutGrid, List, RefreshCw } from 'lucide-vue-next'
import { useVideoStore, useSettingsStore } from '@/stores'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Checkbox } from '@/components/ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import VirtualGrid from '@/components/VirtualGrid.vue'
import VideoDetailDialog from '@/components/VideoDetailDialog.vue'
import ScrapeDialog from '@/components/ScrapeDialog.vue'
import type { Video, ViewMode } from '@/types'

const videoStore = useVideoStore()
const settingsStore = useSettingsStore()

const searchQuery = ref('')
const detailDialogOpen = ref(false)
const scrapeDialogRef = ref<InstanceType<typeof ScrapeDialog> | null>(null)
const selectedVideo = ref<Video | null>(null)

// 视图模式 - 从设置中读取
const viewMode = computed(() => settingsStore.settings.general.viewMode || 'card')

const toggleViewMode = () => {
  const newMode: ViewMode = viewMode.value === 'card' ? 'list' : 'card'
  settingsStore.updateSettings({ general: { ...settingsStore.settings.general, viewMode: newMode } })
}

const refreshMediaLibrary = async () => {
  await videoStore.fetchVideos()
}

// 输入法组合状态
const isComposing = ref(false)

const handleVideoSelect = (video: Video) => {
  selectedVideo.value = video
  detailDialogOpen.value = true
}

const handleVideoUpdated = (video: Video) => {
  selectedVideo.value = video
}

const handleScrape = (video: Video) => {
  if (scrapeDialogRef.value) {
    scrapeDialogRef.value.open(video)
  }
}

// 本地状态管理，用于 UI 绑定
const activeSortBy = ref('title')
const activeSortOrder = ref('desc')

const getFileCreatedAfter = (range?: string) => {
  if (!range) {
    return undefined
  }

  const now = new Date()

  if (range === 'today') {
    const startOfDay = new Date(now)
    startOfDay.setHours(0, 0, 0, 0)
    return startOfDay.toISOString()
  }

  const days = Number.parseInt(range, 10)
  if (Number.isNaN(days)) {
    return undefined
  }

  const threshold = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
  return threshold.toISOString()
}

const filterState = ref({
  minRating: undefined as string | undefined,
  maxRating: undefined as string | undefined, // Not explicitly requested but good for range
  fileCreatedRange: undefined as string | undefined,
  resolution: [] as string[],
  scraped: [] as string[], // 刮削状态筛选：'scraped' 已刮削, 'unscraped' 未刮削
})

// 监听排序变化并应用到 Store
watch([activeSortBy, activeSortOrder], ([newBy, newOrder]) => {
  videoStore.setFilter({
    sortBy: newBy as any,
    sortOrder: newOrder as any
  })
})

// 应用筛选
const applyFilters = () => {
  console.log('applyFilters 被调用, filterState:', JSON.stringify(filterState.value))
  videoStore.setFilter({
    minRating: filterState.value.minRating ? parseFloat(filterState.value.minRating) : undefined,
    fileCreatedAfter: getFileCreatedAfter(filterState.value.fileCreatedRange),
    resolution: filterState.value.resolution.length > 0 ? filterState.value.resolution : undefined,
    scraped: filterState.value.scraped.length > 0 ? filterState.value.scraped : undefined,
  })
  console.log('setFilter 后的 store.filter:', JSON.stringify(videoStore.filter))
}

// 监听筛选变化自动应用 (或者也可以加 '应用' 按钮，这里选择自动)
watch(filterState, () => {
  applyFilters()
}, { deep: true })

// 搜索
const handleSearch = () => {
  // 如果正在输入法组合中，不触发搜索
  if (isComposing.value) {
    return
  }
  videoStore.setFilter({ search: searchQuery.value })
}

// 输入法组合开始
const handleCompositionStart = () => {
  isComposing.value = true
}

// 输入法组合结束
const handleCompositionEnd = () => {
  isComposing.value = false
  // 组合结束后立即触发搜索
  handleSearch()
}

// 清除搜索
const clearSearch = () => {
  searchQuery.value = ''
  videoStore.setFilter({ search: '' })
}

onMounted(() => {
  videoStore.fetchVideos()
  videoStore.fetchDirectories()
})

// 为了演示，计算属性直接从 Store 取
const displayVideos = computed(() => videoStore.filteredVideos)
const hasFilteredResults = computed(() => displayVideos.value.length > 0)
const isFilteredEmpty = computed(() => !videoStore.loading && !hasFilteredResults.value && videoStore.totalCount > 0)

// 视频总数显示
const videoCount = computed(() => {
  return `共 ${displayVideos.value.length} 个视频`
})

// 用于重置筛选
const clearFilters = () => {
  filterState.value = {
    minRating: undefined,
    maxRating: undefined,
    fileCreatedRange: undefined,
    resolution: [],
    scraped: [],
  }
}

const clearMediaFilters = () => {
  clearSearch()
  clearFilters()
}

// 筛选徽章计数
const activeFilterCount = computed(() => {
  let count = 0
  if (filterState.value.minRating) count++
  if (filterState.value.fileCreatedRange) count++
  if (filterState.value.resolution.length > 0) count++
  if (filterState.value.scraped.length > 0) count++
  return count
})

// 分辨率 checkbox 计算属性
const resolution4K = computed({
  get: () => filterState.value.resolution.includes('4K'),
  set: (val) => {
    if (val) {
      filterState.value.resolution = [...filterState.value.resolution, '4K']
    } else {
      filterState.value.resolution = filterState.value.resolution.filter(i => i !== '4K')
    }
  }
})

const resolution1080p = computed({
  get: () => filterState.value.resolution.includes('1080p'),
  set: (val) => {
    if (val) {
      filterState.value.resolution = [...filterState.value.resolution, '1080p']
    } else {
      filterState.value.resolution = filterState.value.resolution.filter(i => i !== '1080p')
    }
  }
})

const resolution720p = computed({
  get: () => filterState.value.resolution.includes('720p'),
  set: (val) => {
    if (val) {
      filterState.value.resolution = [...filterState.value.resolution, '720p']
    } else {
      filterState.value.resolution = filterState.value.resolution.filter(i => i !== '720p')
    }
  }
})

const resolutionSD = computed({
  get: () => filterState.value.resolution.includes('SD'),
  set: (val) => {
    if (val) {
      filterState.value.resolution = [...filterState.value.resolution, 'SD']
    } else {
      filterState.value.resolution = filterState.value.resolution.filter(i => i !== 'SD')
    }
  }
})

// 刮削状态 checkbox 计算属性
const scrapedChecked = computed({
  get: () => filterState.value.scraped.includes('scraped'),
  set: (val) => {
    if (val) {
      filterState.value.scraped = [...filterState.value.scraped, 'scraped']
    } else {
      filterState.value.scraped = filterState.value.scraped.filter(i => i !== 'scraped')
    }
  }
})

const unscrapedChecked = computed({
  get: () => filterState.value.scraped.includes('unscraped'),
  set: (val) => {
    if (val) {
      filterState.value.scraped = [...filterState.value.scraped, 'unscraped']
    } else {
      filterState.value.scraped = filterState.value.scraped.filter(i => i !== 'unscraped')
    }
  }
})

</script>

<template>
  <div class="flex h-full flex-col">
    <!-- 工具栏 -->
    <div class="flex items-center gap-2 border-b p-4">
      <!-- 搜索框 -->
      <div class="relative mr-2" style="width: 200px;">
        <Input 
          v-model="searchQuery" 
          placeholder="搜索" 
          class="pr-16 h-9" 
          @input="handleSearch"
          @compositionstart="handleCompositionStart"
          @compositionend="handleCompositionEnd"
        />
        <div class="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1">
          <button
            v-if="searchQuery"
            @click="clearSearch"
            class="text-muted-foreground hover:text-foreground transition-colors"
            type="button"
          >
            <X class="size-4" />
          </button>
          <button
            @click="handleSearch"
            class="text-muted-foreground hover:text-foreground transition-colors p-1 rounded-sm hover:bg-accent"
            type="button"
          >
            <Search class="size-4" />
          </button>
        </div>
      </div>

      <!-- 排序下拉菜单 -->
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="outline" size="sm" class="h-9 gap-1">
            <ArrowUpDown class="size-4 text-muted-foreground" />
            排序
            <Badge v-if="activeSortBy !== 'title'" variant="secondary" class="ml-1 h-5 px-1 text-[10px]">
              {{ activeSortBy === 'premiered' ? '发行日期' : activeSortBy === 'fileCreatedAt' ? '文件创建时间' : activeSortBy === 'duration' ? '时长' : activeSortBy === 'rating' ? '评分' : activeSortBy === 'fileSize' ? '大小' : '自定义' }}
            </Badge>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-48">
          <DropdownMenuLabel>排序依据</DropdownMenuLabel>
          <DropdownMenuRadioGroup v-model="activeSortBy">
            <DropdownMenuRadioItem value="title">名称</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="fileCreatedAt">文件创建时间</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="premiered">发行日期</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="duration">时长</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="rating">评分</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="fileSize">大小</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>顺序</DropdownMenuLabel>
          <DropdownMenuRadioGroup v-model="activeSortOrder">
            <DropdownMenuRadioItem value="desc">降序 (9-0)</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="asc">升序 (0-9)</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <!-- 复合筛选 Popover -->
      <Popover>
        <PopoverTrigger as-child>
          <Button variant="outline" size="sm" class="h-9 gap-1" :class="activeFilterCount > 0 ? 'bg-secondary/50' : ''">
            <Filter class="size-4 text-muted-foreground" />
            筛选
            <Badge v-if="activeFilterCount > 0" variant="default"
              class="ml-1 h-5 w-5 p-0 flex items-center justify-center rounded-full text-[10px]">
              {{ activeFilterCount }}
            </Badge>
          </Button>
        </PopoverTrigger>
        <PopoverContent class="w-80 p-4" align="start">
          <div class="space-y-4">
            <div class="flex items-center justify-between">
              <h4 class="font-medium leading-none">筛选条件</h4>
              <Button variant="ghost" size="sm" class="h-auto p-0 text-muted-foreground" @click="clearFilters">
                清空
              </Button>
            </div>
            <Separator />

            <!-- 评分筛选 -->
            <div class="space-y-2">
              <Label class="text-xs text-muted-foreground">最低评分</Label>
              <Select v-model="filterState.minRating">
                <SelectTrigger class="h-8">
                  <SelectValue placeholder="不限" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">0 分</SelectItem>
                  <SelectItem value="1">1 分</SelectItem>
                  <SelectItem value="2">2 分</SelectItem>
                  <SelectItem value="3">3 分</SelectItem>
                  <SelectItem value="4">4 分</SelectItem>
                  <SelectItem value="5">5 分</SelectItem>
                  <SelectItem value="6">6 分</SelectItem>
                  <SelectItem value="7">7 分</SelectItem>
                  <SelectItem value="8">8 分</SelectItem>
                  <SelectItem value="9">9 分</SelectItem>
                  <SelectItem value="10">10 分</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div class="space-y-2">
              <Label class="text-xs text-muted-foreground">文件创建时间</Label>
              <Select v-model="filterState.fileCreatedRange">
                <SelectTrigger class="h-8">
                  <SelectValue placeholder="不限" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="today">今天</SelectItem>
                  <SelectItem value="1">最近 24 小时</SelectItem>
                  <SelectItem value="3">最近 3 天</SelectItem>
                  <SelectItem value="7">最近 7 天</SelectItem>
                  <SelectItem value="30">最近 30 天</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <!-- 分辨率筛选 -->
            <div class="space-y-2">
              <Label class="text-xs text-muted-foreground">分辨率</Label>
              <div class="grid grid-cols-2 gap-2">
                <div class="flex items-center space-x-2">
                  <Checkbox id="res-4k" v-model="resolution4K" />
                  <label for="res-4k"
                    class="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer">4K</label>
                </div>
                <div class="flex items-center space-x-2">
                  <Checkbox id="res-1080p" v-model="resolution1080p" />
                  <label for="res-1080p"
                    class="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer">1080p</label>
                </div>
                <div class="flex items-center space-x-2">
                  <Checkbox id="res-720p" v-model="resolution720p" />
                  <label for="res-720p"
                    class="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer">720p</label>
                </div>
                <div class="flex items-center space-x-2">
                  <Checkbox id="res-sd" v-model="resolutionSD" />
                  <label for="res-sd"
                    class="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer">SD</label>
                </div>
              </div>
            </div>

            <!-- 刮削状态筛选 -->
            <div class="space-y-2">
              <Label class="text-xs text-muted-foreground">刮削状态</Label>
              <div class="grid grid-cols-2 gap-2">
                <div class="flex items-center space-x-2">
                  <Checkbox id="scraped" v-model="scrapedChecked" />
                  <label for="scraped"
                    class="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer">已刮削</label>
                </div>
                <div class="flex items-center space-x-2">
                  <Checkbox id="unscraped" v-model="unscrapedChecked" />
                  <label for="unscraped"
                    class="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70 cursor-pointer">未刮削</label>
                </div>
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      <div class="ml-auto flex items-center gap-2">
        <!-- 统计信息 -->
        <span class="text-sm text-muted-foreground">{{ videoCount }}</span>

        <!-- 视图模式切换 -->
        <Button
          variant="ghost"
          size="icon"
          class="h-9 w-9"
          :title="viewMode === 'card' ? '切换到列表模式' : '切换到卡片模式'"
          @click="toggleViewMode"
        >
          <List v-if="viewMode === 'card'" class="size-4" />
          <LayoutGrid v-else class="size-4" />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          class="h-9 w-9"
          title="刷新多媒体页"
          :disabled="videoStore.loading"
          @click="refreshMediaLibrary"
        >
          <RefreshCw class="size-4" :class="{ 'animate-spin': videoStore.loading }" />
        </Button>
      </div>
    </div>

    <!-- 视频网格 -->
    <div class="flex-1 overflow-hidden py-4">
      <div v-if="isFilteredEmpty" class="flex h-full flex-col items-center justify-center gap-4 text-center">
        <div class="space-y-2 text-muted-foreground">
          <p class="text-lg text-foreground">当前筛选条件下暂无视频</p>
          <p class="text-sm">批量刮削结束后，若当前只显示未刮削视频，列表会变为空。清空搜索或筛选后可恢复显示。</p>
        </div>
        <Button variant="outline" @click="clearMediaFilters">
          清空筛选
        </Button>
      </div>
      <VirtualGrid
        v-else
        :items="displayVideos"
        :loading="videoStore.loading && videoStore.totalCount === 0"
        :view-mode="viewMode"
        @select="handleVideoSelect"
        @scrape="handleScrape"
      />
    </div>

    <!-- 视频详情对话框 -->
    <VideoDetailDialog v-model:open="detailDialogOpen" :video="selectedVideo" @video-updated="handleVideoUpdated" />

    <!-- 刮削对话框 -->
    <ScrapeDialog ref="scrapeDialogRef" @success="videoStore.fetchVideos()" />
  </div>
</template>
