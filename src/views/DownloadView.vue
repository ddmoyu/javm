<script setup lang="ts">
import { onMounted, computed, ref, watch } from 'vue'

import { RotateCcw, Trash2, FolderOpen, StopCircle, ArrowUpDown, ArrowUp, ArrowDown, FileVideo, Edit, ListPlus, Copy, FolderSync, ChevronDown } from 'lucide-vue-next'
import { useDownloadStore, useSettingsStore } from '@/stores'
import { Button } from '@/components/ui/button'
import BatchDownloadDialog from '@/components/BatchDownloadDialog.vue'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { useVirtualizer } from '@tanstack/vue-virtual'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { formatFileSize, formatSpeed, formatProgress } from '@/utils/format'
import { DOWNLOAD_STATUS_TEXT, DOWNLOAD_STATUS_VARIANT } from '@/utils/constants'
import { openWithPlayer, openInExplorer, getDefaultDownloadPath, addDownloadTask, selectDirectory } from '@/lib/tauri'
import { toast } from 'vue-sonner'
import type { DownloadTask } from '@/types'


const downloadStore = useDownloadStore()

const settingsStore = useSettingsStore()

// 批量添加对话框
const showBatchDialog = ref(false)

// 重命名对话框
const showRenameDialog = ref(false)
const renameTaskId = ref('')
const renameFilename = ref('')

// 打开批量添加对话框
const handleOpenBatchDialog = () => {
  showBatchDialog.value = true
}

// 初始化默认下载路径
const downloadPath = ref('')

onMounted(async () => {
  downloadStore.fetchTasks()

  // 确保设置已加载
  if (!settingsStore.settings.download.savePath) {
    await settingsStore.loadSettings()
  }

  if (settingsStore.settings.download.savePath) {
    downloadPath.value = settingsStore.settings.download.savePath
  } else {
    try {
      downloadPath.value = await getDefaultDownloadPath()
    } catch (e) {
      console.error('Failed to get default download path:', e)
    }
  }
})

// 批量添加下载
const handleBatchSubmit = async (data: { tasks: Array<{ url: string, filename: string }>, savePath: string, setAsDefault: boolean }) => {
  const { tasks, savePath, setAsDefault } = data

  // 立即关闭对话框
  showBatchDialog.value = false

  // 显示开始提示
  const totalTasks = tasks.length
  toast.info(`开始添加 ${totalTasks} 个下载任务...`)

  // 如果需要设置为默认路径，更新设置
  if (setAsDefault) {
    try {
      await settingsStore.updateSettings({
        download: {
          ...settingsStore.settings.download,
          savePath
        }
      })
      downloadPath.value = savePath
      toast.success('已设置为默认下载路径')
    } catch (e) {
      console.error('Failed to update default path:', e)
      toast.error('设置默认路径失败')
    }
  }

  let successCount = 0
  let failCount = 0
  const errors: string[] = []

  // 逐个添加任务，每次添加后立即刷新列表
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i]
    try {
      // 直接调用后端 API 添加任务
      await addDownloadTask(task.url, savePath, task.filename)
      successCount++

      // 添加小延迟确保数据库写入完成
      await new Promise(resolve => setTimeout(resolve, 100))

      // 每次添加后立即刷新列表，让用户看到任务出现
      await downloadStore.fetchTasks()
    } catch (e) {
      failCount++
      const errorMsg = typeof e === 'string' ? e : '添加失败'
      errors.push(`${task.filename}: ${errorMsg}`)
      console.error('Failed to add task:', task.url, e)
    }
  }

  // 最后再刷新一次，确保所有任务都显示
  await downloadStore.fetchTasks()

  // 显示结果
  if (successCount > 0 && failCount === 0) {
    toast.success(`成功添加 ${successCount} 个下载任务`)
  } else if (successCount > 0 && failCount > 0) {
    toast.warning(`添加完成：成功 ${successCount} 个，失败 ${failCount} 个`, {
      description: errors.slice(0, 3).join('\n'),
      duration: 5000
    })
  } else if (failCount > 0) {
    toast.error(`所有任务添加失败`, {
      description: errors.slice(0, 3).join('\n'),
      duration: 5000
    })
  }
}

// 排序状态
type SortKey = 'filename' | 'status' | 'speed' | 'progress' | 'total'
type SortOrder = 'asc' | 'desc' | null
const sortKey = ref<SortKey | null>(null)
const sortOrder = ref<SortOrder>(null)

// 切换排序
const toggleSort = (key: SortKey) => {
  if (sortKey.value === key) {
    // 同一列：asc -> desc -> null
    if (sortOrder.value === 'asc') {
      sortOrder.value = 'desc'
    } else if (sortOrder.value === 'desc') {
      sortKey.value = null
      sortOrder.value = null
    }
  } else {
    // 新列：从 asc 开始
    sortKey.value = key
    sortOrder.value = 'asc'
  }
}

// 排序后的任务列表
const sortedTasks = computed(() => {
  if (!sortKey.value || !sortOrder.value) {
    return downloadStore.tasks
  }

  const key = sortKey.value
  const order = sortOrder.value

  return [...downloadStore.tasks].sort((a: DownloadTask, b: DownloadTask) => {
    let comparison = 0

    switch (key) {
      case 'filename':
        comparison = a.filename.localeCompare(b.filename, 'zh-CN')
        break
      case 'status':
        comparison = a.status.localeCompare(b.status)
        break
      case 'speed':
        comparison = a.speed - b.speed
        break
      case 'progress':
        comparison = a.progress - b.progress
        break
      case 'total':
        comparison = a.total - b.total
        break
    }

    return order === 'asc' ? comparison : -comparison
  })
})

// 获取排序图标
const getSortIcon = (key: SortKey) => {
  if (sortKey.value !== key) return ArrowUpDown
  return sortOrder.value === 'asc' ? ArrowUp : ArrowDown
}

// 统计信息
const stats = computed(() => ({
  total: downloadStore.tasks.length,
  downloading: downloadStore.downloadingTasks.length,
  completed: downloadStore.completedTasks.length,
  failed: downloadStore.failedTasks.length,
}))

// 批量操作
const handleBatchStop = async () => {
  // 停止所有未完成的任务（不包括已完成的）
  const incompleteTasks = downloadStore.tasks.filter(t => t.status !== 'completed')
  const taskIds = incompleteTasks.map(t => t.id)

  if (taskIds.length === 0) {
    toast.info('没有任务需要停止')
    return
  }

  try {
    await downloadStore.batchStopAll(taskIds)
    toast.success(`已停止 ${taskIds.length} 个下载任务`)
  } catch (e) {
    console.error('Failed to stop all tasks:', e)
    toast.error('停止任务失败')
  }
}

const handleBatchRetry = async () => {
  // 重试所有未完成的任务（不管是否选中）
  const incompleteTasks = downloadStore.tasks.filter(t => t.status !== 'completed')
  const taskIds = incompleteTasks.map(t => t.id)

  if (taskIds.length === 0) {
    toast.info('没有任务需要开始')
    return
  }

  try {
    await downloadStore.batchRetryAll(taskIds)
    toast.success(`已开始 ${taskIds.length} 个下载任务`)
  } catch (e) {
    console.error('Failed to retry all tasks:', e)
    toast.error('开始任务失败')
  }
}

const handleDeleteCompleted = async () => {
  const completedIds = downloadStore.completedTasks.map(task => task.id)
  await handleDeleteByIds(completedIds, '没有已完成的任务可删除', '完成任务')
}

const handleDeleteFailed = async () => {
  const failedIds = downloadStore.failedTasks.map(task => task.id)
  await handleDeleteByIds(failedIds, '没有失败的任务可删除', '失败任务')
}

const handleDeleteSelected = async () => {
  await handleDeleteByIds([...downloadStore.selectedIds], '请先选择要删除的任务', '勾选任务')
}

const handleDeleteByIds = async (taskIds: string[], emptyMessage: string, label: string) => {
  if (taskIds.length === 0) {
    toast.info(emptyMessage)
    return
  }

  try {
    const { deletedCount, failed } = await downloadStore.deleteTasks(taskIds)

    if (deletedCount > 0) {
      toast.success(`已删除 ${deletedCount} 个${label}`)
    }

    if (failed.length > 0) {
      toast.warning(`${failed.length} 个${label}删除失败`)
    }
  } catch (e) {
    console.error('Failed to delete tasks:', e)
    toast.error('删除任务失败')
  }
}

// 单个任务操作
const handleStop = (taskId: string) => downloadStore.stopTask(taskId)
const handleDelete = (taskId: string) => downloadStore.deleteTask(taskId)

// 右键菜单操作
const handleOpenFile = async (task: DownloadTask) => {
  if (task.status === 'completed') {
    try {
      await openWithPlayer(task.savePath)
    } catch (e) {
      console.error('Failed to open file:', e)
    }
  }
}

const handleOpenFolder = async (task: DownloadTask) => {
  try {
    await openInExplorer(task.savePath)
  } catch (e) {
    console.error('Failed to open folder:', e)
  }
}

const handleRedownload = async (taskId: string) => {
  await downloadStore.retryTask(taskId)
}

// 打开重命名对话框
const handleOpenRenameDialog = (task: DownloadTask) => {
  renameTaskId.value = task.id
  renameFilename.value = task.filename
  showRenameDialog.value = true
}

// 复制下载链接
const handleCopyUrl = async (task: DownloadTask) => {
  try {
    await navigator.clipboard.writeText(task.url)
    toast.success('下载链接已复制到剪贴板')
  } catch {
    toast.error('复制失败')
  }
}

// 执行重命名
const handleRenameTask = async () => {
  if (!renameFilename.value.trim()) {
    toast.error('请输入文件名')
    return
  }

  try {
    await downloadStore.renameTask(renameTaskId.value, renameFilename.value.trim())
    toast.success('重命名成功')
    showRenameDialog.value = false
    renameTaskId.value = ''
    renameFilename.value = ''
  } catch (e) {
    console.error('Failed to rename task:', e)
    const errorMessage = typeof e === 'string' ? e : '重命名失败'
    toast.error(errorMessage)
  }
}

// 修改保存路径对话框相关
const showChangePathDialog = ref(false)
const changePathTaskId = ref('')
const changePathOldDir = ref('')
const changePathNewDir = ref('')

// 打开修改保存路径对话框
const handleOpenChangePathDialog = async (task: DownloadTask) => {
  if (task.status === 'completed') {
    toast.warning('已完成的任务无法修改保存路径')
    return
  }
  changePathTaskId.value = task.id
  changePathOldDir.value = task.savePath
  changePathNewDir.value = task.savePath
  showChangePathDialog.value = true
}

// 在修改对话框中选择新路径
const handleSelectNewPath = async () => {
  try {
    const selected = await selectDirectory()
    if (selected) {
      changePathNewDir.value = selected
    }
  } catch (e) {
    console.error('Failed to select directory:', e)
  }
}

// 确认修改保存路径
const handleConfirmChangePath = async () => {
  if (!changePathNewDir.value) {
    toast.error('请选择新的保存路径')
    return
  }
  if (changePathNewDir.value === changePathOldDir.value) {
    showChangePathDialog.value = false
    return
  }

  try {
    await downloadStore.changeSavePath(changePathTaskId.value, changePathNewDir.value)
    toast.success('保存路径修改成功')
    showChangePathDialog.value = false
    changePathTaskId.value = ''
    changePathOldDir.value = ''
    changePathNewDir.value = ''
  } catch (e) {
    console.error('Failed to change save path:', e)
    const errorMessage = typeof e === 'string' ? e : '修改路径失败'
    toast.error(errorMessage)
  }
}


const handleSelectAll = () => {
  if (downloadStore.selectedIds.length === downloadStore.tasks.length) {
    downloadStore.deselectAll()
  } else {
    downloadStore.selectAll()
  }
}

// 全选复选框状态
const selectAllCheckbox = ref<HTMLInputElement | null>(null)
const isAllSelected = computed(() =>
  downloadStore.tasks.length > 0 && downloadStore.selectedIds.length === downloadStore.tasks.length
)
const isSomeSelected = computed(() =>
  downloadStore.selectedIds.length > 0 && downloadStore.selectedIds.length < downloadStore.tasks.length
)

// 监听选中状态，更新 indeterminate
watch([isSomeSelected, isAllSelected], () => {
  if (selectAllCheckbox.value) {
    selectAllCheckbox.value.indeterminate = isSomeSelected.value
  }
})

// 列宽调整
const columnWidths = ref({
  checkbox: 48,
  filename: 200,
  url: 256,
  status: 96,
  speed: 120,
  progress: 192,
  total: 120
})

const resizing = ref<string | null>(null)
const startX = ref(0)
const startWidth = ref(0)

const startResize = (e: MouseEvent, column: string) => {
  resizing.value = column
  startX.value = e.clientX
  startWidth.value = columnWidths.value[column as keyof typeof columnWidths.value]

  document.addEventListener('mousemove', handleResize)
  document.addEventListener('mouseup', stopResize)
  e.preventDefault()
}

const handleResize = (e: MouseEvent) => {
  if (!resizing.value) return

  const diff = e.clientX - startX.value
  const newWidth = Math.max(50, startWidth.value + diff)
  columnWidths.value[resizing.value as keyof typeof columnWidths.value] = newWidth
}

const stopResize = () => {
  resizing.value = null
  document.removeEventListener('mousemove', handleResize)
  document.removeEventListener('mouseup', stopResize)
}

// ============ 虚拟滚动 ============
// 仅渲染可视行，避免上千条任务时为每行实例化 ContextMenu/Tooltip 造成卡顿与内存暴涨
const tableContainerRef = ref<HTMLElement>()
const ROW_HEIGHT = 52

const rowVirtualizer = useVirtualizer({
  get count() { return sortedTasks.value.length },
  getScrollElement: () => tableContainerRef.value ?? null,
  estimateSize: () => ROW_HEIGHT,
  overscan: 8,
})
const virtualRows = computed(() => rowVirtualizer.value.getVirtualItems())
const totalHeight = computed(() => rowVirtualizer.value.getTotalSize())
// 列宽合计：表头与表体按同一宽度排布，超出容器时整体横向滚动（保留列宽拖拽体验）
const totalColumnsWidth = computed(() =>
  Object.values(columnWidths.value).reduce((sum, w) => sum + w, 0)
)

</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <!-- 工具栏 -->
    <div class="flex shrink-0 items-center justify-between border-b p-4">
      <div class="flex items-center gap-2">
        <Button variant="default" size="sm" @click="handleOpenBatchDialog">
          <ListPlus class="mr-2 size-4" />
          添加
        </Button>
        <Button variant="outline" size="sm" @click="handleBatchRetry">
          <RotateCcw class="mr-2 size-4" />
          开始
        </Button>
        <Button variant="outline" size="sm" @click="handleBatchStop">
          <StopCircle class="mr-2 size-4" />
          停止
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="outline" size="sm" :disabled="downloadStore.tasks.length === 0" class="gap-2">
              <Trash2 class="size-4" />
              删除
              <ChevronDown class="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" class="w-44">
            <DropdownMenuItem :disabled="downloadStore.completedTasks.length === 0" @click="handleDeleteCompleted">
              删除完成任务
            </DropdownMenuItem>
            <DropdownMenuItem :disabled="downloadStore.failedTasks.length === 0" @click="handleDeleteFailed">
              删除失败任务
            </DropdownMenuItem>
            <DropdownMenuItem :disabled="downloadStore.selectedIds.length === 0" @click="handleDeleteSelected">
              删除勾选任务
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div class="flex items-center gap-4 text-sm text-muted-foreground">
        <span>总计: {{ stats.total }}</span>
        <span>下载中: {{ stats.downloading }}</span>
        <span>已完成: {{ stats.completed }}</span>
        <span v-if="stats.failed > 0" class="text-destructive">
          失败: {{ stats.failed }}
        </span>
        <span v-if="downloadStore.downloadingTasks.length > 0">
          速度: {{ formatSpeed(downloadStore.totalSpeed) }}
        </span>
      </div>
    </div>

    <!-- 下载表格（虚拟滚动：仅渲染可视行） -->
    <TooltipProvider>
      <div ref="tableContainerRef" class="download-scroll min-h-0 flex-1 overflow-auto">
        <!-- 表头（粘顶，与表体按 columnWidths 对齐） -->
        <div
          class="sticky top-0 z-10 flex items-center border-b bg-background text-sm font-medium text-muted-foreground"
          :style="{ width: `${totalColumnsWidth}px` }"
        >
          <div :style="{ width: `${columnWidths.checkbox}px` }" class="relative shrink-0 px-4 py-2">
            <input ref="selectAllCheckbox" type="checkbox" :checked="isAllSelected" @change="handleSelectAll"
              class="size-4 rounded border" />
            <div class="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/50"
              @mousedown="startResize($event, 'checkbox')"></div>
          </div>
          <div :style="{ width: `${columnWidths.filename}px` }"
            class="relative shrink-0 cursor-pointer select-none px-4 py-2 hover:bg-muted/50" @click="toggleSort('filename')">
            <div class="flex items-center gap-1">
              文件名
              <component :is="getSortIcon('filename')" class="size-4 text-muted-foreground" />
            </div>
            <div class="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/50"
              @mousedown.stop="startResize($event, 'filename')"></div>
          </div>
          <div :style="{ width: `${columnWidths.url}px` }" class="relative shrink-0 px-4 py-2">
            下载链接
            <div class="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/50"
              @mousedown="startResize($event, 'url')"></div>
          </div>
          <div :style="{ width: `${columnWidths.status}px` }"
            class="relative shrink-0 cursor-pointer select-none px-4 py-2 hover:bg-muted/50" @click="toggleSort('status')">
            <div class="flex items-center gap-1">
              状态
              <component :is="getSortIcon('status')" class="size-4 text-muted-foreground" />
            </div>
            <div class="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/50"
              @mousedown.stop="startResize($event, 'status')"></div>
          </div>
          <div :style="{ width: `${columnWidths.speed}px` }"
            class="relative shrink-0 cursor-pointer select-none px-4 py-2 hover:bg-muted/50" @click="toggleSort('speed')">
            <div class="flex items-center gap-1">
              速度
              <component :is="getSortIcon('speed')" class="size-4 text-muted-foreground" />
            </div>
            <div class="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/50"
              @mousedown.stop="startResize($event, 'speed')"></div>
          </div>
          <div :style="{ width: `${columnWidths.progress}px` }"
            class="relative shrink-0 cursor-pointer select-none px-4 py-2 hover:bg-muted/50" @click="toggleSort('progress')">
            <div class="flex items-center gap-1">
              进度
              <component :is="getSortIcon('progress')" class="size-4 text-muted-foreground" />
            </div>
            <div class="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/50"
              @mousedown.stop="startResize($event, 'progress')"></div>
          </div>
          <div :style="{ width: `${columnWidths.total}px` }"
            class="relative shrink-0 cursor-pointer select-none px-4 py-2 hover:bg-muted/50" @click="toggleSort('total')">
            <div class="flex items-center gap-1">
              大小
              <component :is="getSortIcon('total')" class="size-4 text-muted-foreground" />
            </div>
            <div class="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/50"
              @mousedown.stop="startResize($event, 'total')"></div>
          </div>
        </div>

        <!-- 空状态 -->
        <div v-if="downloadStore.tasks.length === 0"
          class="flex h-32 items-center justify-center text-muted-foreground">
          暂无下载任务
        </div>

        <!-- 虚拟化表体 -->
        <div v-else :style="{ height: `${totalHeight}px`, width: `${totalColumnsWidth}px`, position: 'relative' }">
          <ContextMenu v-for="virtualRow in virtualRows" :key="sortedTasks[virtualRow.index].id">
            <ContextMenuTrigger as-child>
              <div
                data-context-menu
                :style="{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }"
                :class="['flex items-center border-b transition-colors hover:bg-muted/50', { 'bg-muted/50': downloadStore.selectedIds.includes(sortedTasks[virtualRow.index].id) }]"
              >
                <div :style="{ width: `${columnWidths.checkbox}px` }" class="shrink-0 px-4 text-sm">
                  <input type="checkbox" :checked="downloadStore.selectedIds.includes(sortedTasks[virtualRow.index].id)"
                    @change="downloadStore.toggleSelect(sortedTasks[virtualRow.index].id)" class="size-4 rounded border" />
                </div>
                <div :style="{ width: `${columnWidths.filename}px` }" class="shrink-0 overflow-hidden px-4 font-medium text-sm">
                  <Tooltip>
                    <TooltipTrigger as-child>
                      <div class="truncate cursor-help">{{ sortedTasks[virtualRow.index].filename }}</div>
                    </TooltipTrigger>
                    <TooltipContent class="max-w-md break-all">
                      <p>{{ sortedTasks[virtualRow.index].filename }}</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
                <div :style="{ width: `${columnWidths.url}px` }" class="shrink-0 overflow-hidden px-4 text-muted-foreground text-xs">
                  <Tooltip>
                    <TooltipTrigger as-child>
                      <div class="truncate cursor-help">{{ sortedTasks[virtualRow.index].url }}</div>
                    </TooltipTrigger>
                    <TooltipContent class="max-w-lg break-all">
                      <p>{{ sortedTasks[virtualRow.index].url }}</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
                <div :style="{ width: `${columnWidths.status}px` }" class="shrink-0 px-4 text-sm">
                  <Badge :variant="DOWNLOAD_STATUS_VARIANT[sortedTasks[virtualRow.index].status]">
                    {{ DOWNLOAD_STATUS_TEXT[sortedTasks[virtualRow.index].status] }}
                  </Badge>
                </div>
                <div :style="{ width: `${columnWidths.speed}px` }" class="shrink-0 px-4 tabular-nums text-sm whitespace-nowrap">
                  {{ (sortedTasks[virtualRow.index].status === 'downloading' && sortedTasks[virtualRow.index].speed > 0) ? formatSpeed(sortedTasks[virtualRow.index].speed) : '-' }}
                </div>
                <div :style="{ width: `${columnWidths.progress}px` }" class="shrink-0 px-4 text-sm">
                  <div class="flex items-center gap-2">
                    <Progress :model-value="sortedTasks[virtualRow.index].progress" class="h-2 w-24" />
                    <span class="w-12 text-xs text-muted-foreground tabular-nums">
                      {{ formatProgress(sortedTasks[virtualRow.index].progress) }}
                    </span>
                  </div>
                </div>
                <div :style="{ width: `${columnWidths.total}px` }" class="shrink-0 px-4 text-muted-foreground tabular-nums text-sm whitespace-nowrap">
                  {{ formatFileSize(sortedTasks[virtualRow.index].total) }}
                </div>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem :disabled="sortedTasks[virtualRow.index].status !== 'completed'" @click="handleOpenFile(sortedTasks[virtualRow.index])">
                <FileVideo class="mr-2 size-4" />
                打开
              </ContextMenuItem>
              <ContextMenuItem @click="handleOpenFolder(sortedTasks[virtualRow.index])">
                <FolderOpen class="mr-2 size-4" />
                打开目录
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem @click="handleOpenRenameDialog(sortedTasks[virtualRow.index])">
                <Edit class="mr-2 size-4" />
                重命名
              </ContextMenuItem>
              <ContextMenuItem :disabled="sortedTasks[virtualRow.index].status === 'completed'" @click="handleOpenChangePathDialog(sortedTasks[virtualRow.index])">
                <FolderSync class="mr-2 size-4" />
                修改保存路径
              </ContextMenuItem>
              <ContextMenuItem @click="handleCopyUrl(sortedTasks[virtualRow.index])">
                <Copy class="mr-2 size-4" />
                复制下载链接
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                :disabled="sortedTasks[virtualRow.index].status !== 'downloading' && sortedTasks[virtualRow.index].status !== 'preparing' && sortedTasks[virtualRow.index].status !== 'merging'"
                @click="handleStop(sortedTasks[virtualRow.index].id)" class="text-destructive">
                <StopCircle class="mr-2 size-4" />
                停止任务
              </ContextMenuItem>
              <ContextMenuItem @click="handleRedownload(sortedTasks[virtualRow.index].id)">
                <RotateCcw class="mr-2 size-4" />
                重新下载
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem @click="handleDelete(sortedTasks[virtualRow.index].id)" class="text-destructive">
                <Trash2 class="mr-2 size-4" />
                删除任务
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </div>
      </div>
    </TooltipProvider>

    <!-- 重命名对话框 -->
    <Dialog v-model:open="showRenameDialog">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重命名任务</DialogTitle>
          <DialogDescription>修改下载任务的文件名</DialogDescription>
        </DialogHeader>
        <div class="space-y-4 py-4">
          <div class="space-y-2">
            <Label for="rename-filename">文件名</Label>
            <Input id="rename-filename" v-model="renameFilename" placeholder="输入新的文件名" type="text"
              @keyup.enter="handleRenameTask" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="showRenameDialog = false">取消</Button>
          <Button @click="handleRenameTask">确定</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- 批量添加对话框 -->
    <BatchDownloadDialog :open="showBatchDialog" :default-path="downloadPath" @update:open="showBatchDialog = $event"
      @submit="handleBatchSubmit" />

    <!-- 修改保存路径对话框 -->
    <Dialog v-model:open="showChangePathDialog">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>修改保存路径</DialogTitle>
          <DialogDescription>修改该下载任务将要保存到的目录</DialogDescription>
        </DialogHeader>
        <div class="space-y-4 py-4">
          <div class="space-y-2">
            <Label>当前保存路径</Label>
            <Input :model-value="changePathOldDir" readonly class="bg-muted text-muted-foreground" />
          </div>
          <div class="space-y-2">
            <Label for="new-save-path">新保存路径</Label>
            <div class="flex gap-2">
              <Input id="new-save-path" v-model="changePathNewDir" placeholder="请选择新目录" readonly />
              <Button type="button" variant="secondary" @click="handleSelectNewPath">
                <FolderOpen class="h-4 w-4 mr-2" />
                浏览
              </Button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="showChangePathDialog = false">取消</Button>
          <Button @click="handleConfirmChangePath">确定</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

<style scoped>
/* shadcn 风格滚动条（替代原 ScrollArea 的样式） */
.download-scroll {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}

.download-scroll:hover {
  scrollbar-color: hsl(0 0% 20%) transparent;
}

.download-scroll::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

.download-scroll::-webkit-scrollbar-track {
  background: transparent;
}

.download-scroll::-webkit-scrollbar-thumb {
  background-color: transparent;
  border-radius: 9999px;
  border: 2px solid transparent;
  background-clip: content-box;
  transition: background-color 0.2s;
}

.download-scroll:hover::-webkit-scrollbar-thumb {
  background-color: hsl(0 0% 20%);
}

.download-scroll::-webkit-scrollbar-thumb:hover {
  background-color: hsl(0 0% 30%);
}
</style>
