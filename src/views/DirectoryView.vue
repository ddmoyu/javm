<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { Trash2, RefreshCw, FolderPlus, Copy, FolderOpen, Radar } from 'lucide-vue-next'
import { useVideoStore, useResourceScrapeStore } from '@/stores'
import { selectDirectory, openInExplorer } from '@/lib/tauri'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import DuplicateVideosDialog from '@/components/DuplicateVideosDialog.vue'
import RemoveAdsDialog from '@/components/RemoveAdsDialog.vue'
import { toast } from 'vue-sonner'

const formatScanSummary = (successCount: number, failedCount: number, failedDirectories = 0) => {
  const parts = [`成功 ${successCount} 个`, `失败 ${failedCount} 个`]
  if (failedDirectories > 0) {
    parts.push(`${failedDirectories} 个目录未完成`)
  }
  return parts.join('，')
}

const videoStore = useVideoStore()
const scrapeStore = useResourceScrapeStore()

// 同步状态
const syncingIds = ref<Set<string>>(new Set())
const addingToScrapePaths = ref<Set<string>>(new Set())
const duplicateDialogOpen = ref(false)
const removeAdsDialogOpen = ref(false)
const scrapeToastTimers = new Map<string, ReturnType<typeof setTimeout>>()

// 扫描状态 - 分别管理添加目录和刷新目录的状态
const isAddingDirectory = ref(false)
const isRefreshingAll = ref(false)

onMounted(() => {
  videoStore.fetchDirectories()
})

onUnmounted(() => {
  for (const timer of scrapeToastTimers.values()) {
    clearTimeout(timer)
  }
  scrapeToastTimers.clear()
})

const clearScrapeToastTimer = (toastId: string) => {
  const timer = scrapeToastTimers.get(toastId)
  if (timer) {
    clearTimeout(timer)
    scrapeToastTimers.delete(toastId)
  }
}

const scheduleScrapeToastDismiss = (toastId: string, delay: number) => {
  clearScrapeToastTimer(toastId)
  const timer = setTimeout(() => {
    toast.dismiss(toastId)
    scrapeToastTimers.delete(toastId)
  }, delay)
  scrapeToastTimers.set(toastId, timer)
}

// 添加目录
const handleAddDirectory = async () => {
  try {
    const path = await selectDirectory()
    if (path) {
      isAddingDirectory.value = true
      const summary = await videoStore.addDirectory(path)
      toast.success('目录扫描完成', {
        description: formatScanSummary(summary.success_count, summary.failed_count),
      })
      
      // 扫描进度通知由 AppLayout 全局管理
      isAddingDirectory.value = false
    }
  } catch (e: any) {
    isAddingDirectory.value = false
    if (e.message === 'Directory already exists') {
      toast.error('该目录已存在！')
    } else {
      console.error('Failed to add directory:', e)
      toast.error('添加目录失败: ' + (e.message || '未知错误'))
    }
  }
}

// 刷新所有目录
const handleRefreshAll = async () => {
  try {
    isRefreshingAll.value = true
    const ids = videoStore.directories
      .filter(dir => !syncingIds.value.has(dir.id))
      .map(dir => dir.id)

    for (const id of ids) {
      syncingIds.value.add(id)
    }

    const summary = await videoStore.syncDirectoryCountBatch(ids)
    toast.success('目录刷新完成', {
      description: formatScanSummary(summary.success_count, summary.failed_count, summary.failed_directories),
    })
  } catch (e) {
    console.error('Failed to refresh all:', e)
    toast.error('刷新失败')
  } finally {
    videoStore.directories.forEach(dir => syncingIds.value.delete(dir.id))
    isRefreshingAll.value = false
  }
}

// 删除目录
const handleRemoveDirectory = async (id: string) => {
  try {
    await videoStore.removeDirectory(id)
    toast.success('目录已删除')
  } catch (e) {
    console.error('Failed to remove directory:', e)
    toast.error('删除目录失败')
  }
}

// 同步目录数量
const handleSyncDirectory = async (id: string) => {
  syncingIds.value.add(id)
  try {
    const summary = await videoStore.syncDirectoryCount(id)
    if (summary) {
      toast.success('目录扫描完成', {
        description: formatScanSummary(summary.success_count, summary.failed_count),
      })
    }
  } catch (e) {
    console.error('Failed to sync directory:', e)
    toast.error('同步失败')
  } finally {
    syncingIds.value.delete(id)
  }
}

// 打开目录
const handleOpenDirectory = async (path: string) => {
  try {
    await openInExplorer(path)
  } catch (e) {
    console.error('Failed to open directory:', e)
    toast.error('打开目录失败')
  }
}

// 检查是否正在同步
const isSyncing = (id: string) => syncingIds.value.has(id)

// 检查是否正在添加到批量刮削
const isAddingToScrapeCenter = (path: string) => addingToScrapePaths.value.has(path)

// 计算总视频数
const totalVideoCount = computed(() => {
  return videoStore.directories.reduce((sum, dir) => sum + (dir.videoCount || 0), 0)
})

// 视频去重
const handleDeduplication = () => {
  duplicateDialogOpen.value = true
}

// 移除广告视频
const handleRemoveAds = () => {
  removeAdsDialogOpen.value = true
}

// 添加到批量刮削
const handleAddToScrapeCenter = async (directory: any) => {
  if (addingToScrapePaths.value.has(directory.path)) {
    toast.info('该目录正在添加到批量刮削')
    return
  }

  const toastId = `scrape-center-${directory.path}`
  clearScrapeToastTimer(toastId)
  addingToScrapePaths.value.add(directory.path)
  toast.info('正在添加到批量刮削', {
    id: toastId,
    description: '正在扫描目录并筛选未刮削视频，请稍候...',
    duration: Infinity,
  })

  try {
    const result = await scrapeStore.createTask(directory.path)
    if (result === 'created') {
      toast.success('已添加到批量刮削', {
        id: toastId,
        description: '目录中的新视频已加入批量刮削队列。',
        duration: 2500,
      })
      scheduleScrapeToastDismiss(toastId, 2500)
    } else if (result === 'updated') {
      toast.success('刮削任务已更新', {
        id: toastId,
        duration: 2500,
      })
      scheduleScrapeToastDismiss(toastId, 2500)
    } else if (result === 'duplicate') {
      toast.info('该目录已在批量刮削中', {
        id: toastId,
        description: '目录中没有发现需要新增的刮削任务。',
        duration: 2500,
      })
      scheduleScrapeToastDismiss(toastId, 2500)
    }
  } catch (e) {
    console.warn(`Failed to add directory ${directory.path} to scrape tasks:`, e)
    toast.error('添加失败', {
      id: toastId,
      description: (e as Error).message,
      duration: 3500,
    })
    scheduleScrapeToastDismiss(toastId, 3500)
  } finally {
    addingToScrapePaths.value.delete(directory.path)
  }
}
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <!-- 工具栏 -->
    <div class="flex shrink-0 items-center justify-between border-b p-4">
      <div class="flex items-center gap-2">
        <Button variant="default" size="sm" @click="handleAddDirectory" :disabled="isAddingDirectory">
          <FolderPlus class="mr-2 size-4" />
          {{ isAddingDirectory ? '扫描中...' : '添加目录' }}
        </Button>
        <Button variant="outline" size="sm" @click="handleRefreshAll" :disabled="isRefreshingAll">
          <RefreshCw class="mr-2 size-4" :class="{ 'animate-spin': isRefreshingAll }" />
          {{ isRefreshingAll ? '扫描中...' : '刷新目录' }}
        </Button>
        <Button variant="outline" size="sm" @click="handleDeduplication">
          <Copy class="mr-2 size-4" />
          视频去重
        </Button>
        <Button variant="outline" size="sm" @click="handleRemoveAds">
          <Trash2 class="mr-2 size-4" />
          移除广告视频
        </Button>
      </div>

      <div class="flex items-center gap-4 text-sm text-muted-foreground">
        <span>总视频数量: {{ totalVideoCount }}</span>
      </div>
    </div>

    <!-- 目录表格 -->
    <ScrollArea class="min-h-0 flex-1">
      <Table>
        <TableHeader class="sticky top-0 z-10 bg-background">
          <TableRow class="hover:bg-transparent">
            <TableHead class="w-[60%]">路径</TableHead>
            <TableHead class="w-[20%] text-center">视频数量</TableHead>
            <TableHead class="w-[20%] text-center">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-if="videoStore.directories.length === 0" class="hover:bg-transparent">
            <TableCell colspan="3" class="h-32 text-center text-muted-foreground">
              暂无目录，点击"添加目录"按钮开始添加
            </TableCell>
          </TableRow>
          <ContextMenu v-for="directory in videoStore.directories" :key="directory.id">
            <ContextMenuTrigger as-child>
              <TableRow class="cursor-context-menu">
                <TableCell class="text-sm truncate max-w-0">{{ directory.path }}</TableCell>
                <TableCell class="text-center text-sm tabular-nums">{{ directory.videoCount }}</TableCell>
                <TableCell class="text-sm">
                  <div class="flex items-center justify-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      class="h-8 w-8 p-0"
                      title="打开目录"
                      @click="handleOpenDirectory(directory.path)"
                    >
                      <FolderOpen class="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      class="h-8 w-8 p-0"
                      title="同步数量"
                      :disabled="isSyncing(directory.id)"
                      @click="handleSyncDirectory(directory.id)"
                    >
                      <RefreshCw
                        class="size-4"
                        :class="{ 'animate-spin': isSyncing(directory.id) }"
                      />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      class="h-8 w-8 p-0 text-destructive hover:text-destructive"
                      title="删除目录"
                      @click="handleRemoveDirectory(directory.id)"
                    >
                      <Trash2 class="size-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem @click="handleOpenDirectory(directory.path)">
                <FolderOpen class="mr-2 size-4" />
                打开目录
              </ContextMenuItem>
              <ContextMenuItem
                :disabled="isSyncing(directory.id)"
                @click="handleSyncDirectory(directory.id)"
              >
                <RefreshCw
                  class="mr-2 size-4"
                  :class="{ 'animate-spin': isSyncing(directory.id) }"
                />
                同步数量
              </ContextMenuItem>
              <ContextMenuItem
                :disabled="isAddingToScrapeCenter(directory.path)"
                @click="handleAddToScrapeCenter(directory)"
              >
                <Radar
                  class="mr-2 size-4"
                  :class="{ 'animate-pulse': isAddingToScrapeCenter(directory.path) }"
                />
                {{ isAddingToScrapeCenter(directory.path) ? '添加中...' : '添加到批量刮削' }}
              </ContextMenuItem>
              <ContextMenuItem
                class="text-destructive focus:text-destructive"
                @click="handleRemoveDirectory(directory.id)"
              >
                <Trash2 class="mr-2 size-4" />
                删除目录
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </TableBody>
      </Table>
    </ScrollArea>

    <!-- 视频去重对话框 -->
    <DuplicateVideosDialog v-model:open="duplicateDialogOpen" />

    <!-- 移除广告视频对话框 -->
    <RemoveAdsDialog v-model:open="removeAdsDialogOpen" @success="videoStore.fetchVideos()" />
  </div>
</template>
