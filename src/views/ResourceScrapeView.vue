<script setup lang="ts">
import { onMounted, computed, watchEffect, ref, watch, nextTick } from 'vue'
import {
  Play,
  Square,
  Trash2,
  Search,
  Radar,
  Link as LinkIcon,
  ChevronDown,
} from 'lucide-vue-next'
import { toast } from 'vue-sonner'

// UI 组件
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

// 业务组件
import SearchInput from '@/components/SearchInput.vue'
import SearchResultList from '@/components/SearchResultList.vue'
import VirtualScrapeTable from '@/components/VirtualScrapeTable.vue'
import ScrapeDialog from '@/components/ScrapeDialog.vue'
import VideoLinkFinder from '@/components/VideoLinkFinder.vue'

// Store
import { useResourceScrapeStore } from '@/stores/resourceScrape'

// Composables - 事件监听
import {
  useScrapeProgress,
  useScrapeTaskProgress,
  useTaskQueueStatus,
  useScrapeTaskFailed,
} from '@/composables/useTauriEvents'

// 工具
import { openInExplorer } from '@/lib/tauri'
import { type ScrapeTask, ScrapeStatus } from '@/types'

// ============ Store 和事件监听 ============
const store = useResourceScrapeStore()
const { progress: scrapeProgress } = useScrapeProgress()
const { progress: taskProgress } = useScrapeTaskProgress()
const { status: queueStatus } = useTaskQueueStatus()
const taskFailed = useScrapeTaskFailed()

// ============ 组件引用 ============
const scrapeDialogRef = ref<InstanceType<typeof ScrapeDialog> | null>(null)
const videoLinkFinderRef = ref<InstanceType<typeof VideoLinkFinder> | null>(null)
const pendingSearchCode = ref('')

// ============ 搜索操作 ============

/** 处理搜索事件 */
function handleSearch(keyword: string) {
  store.search(keyword)
}

/** 停止搜索 */
function handleStopSearch() {
  store.cancelSearch()
}

/** 跳转到资源链接并自动搜索 */
function handleFindLinks(code: string) {
  activeTab.value = 'video-links'
  // 如果组件已挂载，直接搜索
  if (videoLinkFinderRef.value) {
    videoLinkFinderRef.value.autoSearch(code)
  } else {
    // 否则存入待处理，等待 watch 监听到 ref 变化
    pendingSearchCode.value = code
  }
}

// 监听 VideoLinkFinder 组件挂载
watch(videoLinkFinderRef, (finder) => {
  if (finder && pendingSearchCode.value) {
    // 使用 nextTick 确保组件内部状态就绪
    nextTick(() => {
      finder.autoSearch(pendingSearchCode.value)
      pendingSearchCode.value = ''
    })
  }
})

// ============ 事件监听（组件级别，不受 Tab 切换影响） ============

// 监听刮削进度
watchEffect(() => {
  if (scrapeProgress.value) {
    store.updateTaskProgress(scrapeProgress.value.taskId, {
      progress: scrapeProgress.value.processed,
    })
  }
})

// 监听任务进度更新
watchEffect(() => {
  if (taskProgress.value) {
    const { task_id, progress } = taskProgress.value

    const updates: Partial<ScrapeTask> = {
      progress: progress,
    }

    // 根据进度自动推断状态，解决前端状态不同步的问题
    if (progress >= 5) {
      updates.status = ScrapeStatus.Completed
      updates.progress = 5
      // 延迟刷新任务列表以确保后端状态同步
      setTimeout(() => store.fetchTasks(), 50)
    } else if (progress >= 0) {
      updates.status = ScrapeStatus.Running
    }

    store.updateTaskProgress(task_id, updates)

    // 完成后再次刷新确保同步
    if (progress >= 5) {
      setTimeout(() => store.fetchTasks(), 100)
    }
  }
})

// 监听刮削进度 - 更积极地更新状态
watchEffect(() => {
  if (scrapeProgress.value) {
    const { taskId, processed, total } = scrapeProgress.value
    if (processed >= total && total > 0) {
      store.updateTaskProgress(taskId, {
        status: ScrapeStatus.Completed,
        progress: 5,
      })
    }
  }
})

// 监听任务失败事件 - 使用 Set 追踪已处理的失败任务，避免重复提示
const processedFailures = new Set<string>()
let lastFailureTime = 0
const FAILURE_THROTTLE_MS = 500

function processFailure(task_id: string, error: string, failureKey: string) {
  processedFailures.add(failureKey)
  lastFailureTime = Date.now()

  // 更新任务状态
  store.updateTaskProgress(task_id, {
    status: ScrapeStatus.Failed,
  })

  // 显示错误提示
  toast.error('任务失败', {
    description: error,
    duration: 5000,
  })

  // 刷新任务列表
  store.fetchTasks()
}

watch(
  taskFailed,
  (failedTask) => {
    if (!failedTask) return

    const { task_id, error } = failedTask
    const failureKey = `${task_id}:${error}`

    if (processedFailures.has(failureKey)) return

    const now = Date.now()
    if (now - lastFailureTime < FAILURE_THROTTLE_MS) {
      setTimeout(() => {
        if (!processedFailures.has(failureKey)) {
          processFailure(task_id, error, failureKey)
        }
      }, FAILURE_THROTTLE_MS)
      return
    }

    processFailure(task_id, error, failureKey)
  },
  { deep: true },
)

// 监听队列状态变化
watch(
  () => queueStatus.value?.status,
  (status, prevStatus) => {
    if (!status || status === prevStatus) return

    // 队列停止或完成 - 重置处理标志
    if (status === 'completed' || status === 'stopped') {
      store.isProcessingQueue = false
      processedFailures.clear()
    }

    if (status === 'completed') {
      toast.success('所有任务已完成')

      // 将所有仍在运行的任务标记为完成
      const runningTasks = store.tasks.filter(t => t.status === ScrapeStatus.Running)
      runningTasks.forEach(task => {
        store.updateTaskProgress(task.id, {
          status: ScrapeStatus.Completed,
          progress: 5,
        })
      })

      store.fetchTasks()
    }

    if (status === 'stopped') {
      toast.info('任务队列已停止')
      store.fetchTasks()
    }
  },
)

// ============ 统计信息 ============
const stats = computed(() => store.stats)

// ============ 批量刮削操作 ============

// 开始所有等待中的任务
const handleStartAll = async () => {
  if (store.runningTasks.length > 0) {
    const confirmed = confirm(
      `检测到 ${store.runningTasks.length} 个任务处于运行状态，是否要重置这些任务并重新开始？`,
    )
    if (confirmed) {
      for (const task of store.runningTasks) {
        await store.resetTask(task.id)
      }
    } else {
      return
    }
  }

  await store.startAll()
}

// 停止所有运行中的任务
const handleStopAll = async () => {
  await store.stopAll()
}

// 删除已完成的任务
const handleDeleteCompleted = async () => {
  await store.deleteCompletedTasks()
}

const handleDeleteFailed = async () => {
  await store.deleteFailedTasks()
}

const handleDeleteAll = async () => {
  await store.deleteAllTasks()
}

// ============ 右键菜单操作 ============

const handleOpenFolder = async (task: ScrapeTask) => {
  try {
    await openInExplorer(task.path)
  } catch (e) {
    console.error('Failed to open folder:', e)
    toast.error('打开文件夹失败', {
      description: (e as Error).message,
    })
  }
}

const handleStartTask = async (task: ScrapeTask) => {
  if (task.status === 'waiting' || task.status === 'failed' || task.status === 'partial') {
    if (scrapeDialogRef.value) {
      const fileName = task.path.split(/[/\\]/).pop() || ''
      const fileNameWithoutExt = fileName.replace(/\.[^/.]+$/, '')

      scrapeDialogRef.value.open({
        id: task.id,
        title: fileNameWithoutExt,
        path: task.path,
        videoPath: task.path,
      })
    }
  }
}

const handleStopTask = async (task: ScrapeTask) => {
  if (task.status === 'running') {
    await store.stopTask(task.id)
  }
}

const handleRemoveTask = async (task: ScrapeTask) => {
  try {
    await store.removeTask(task.id)
    toast.success('删除成功', {
      description: '任务已删除'
    })
  } catch (e) {
    console.error('Failed to remove task:', e)
    toast.error('删除失败', {
      description: (e as Error).message
    })
  }
}

// ============ 初始化 ============
const activeTab = ref('search')

onMounted(async () => {
  store.fetchTasks()
})
</script>

<template>
  <div class="flex h-full flex-col">
    <Tabs v-model="activeTab" :unmount-on-hide="false" class="flex h-full flex-col">
    <!-- Tab 切换栏 -->
    <TabsList class="mx-4 mt-4 w-fit">
      <TabsTrigger value="search">
        <Search class="mr-2 size-4" />
        搜索
      </TabsTrigger>
      <TabsTrigger value="batch">
        <Radar class="mr-2 size-4" />
        批量刮削
      </TabsTrigger>
      <TabsTrigger value="video-links">
        <LinkIcon class="mr-2 size-4" />
        资源链接
      </TabsTrigger>
    </TabsList>

    <!-- 搜索 Tab -->
    <TabsContent value="search" class="flex-1 overflow-hidden flex flex-col">
      <!-- 搜索输入区域：搜索前居中，搜索后上移 -->
      <div
        class="flex w-full justify-center transition-all duration-300 ease-in-out"
        :class="store.searched ? 'pt-6 pb-4 px-6' : 'flex-1 items-center px-6'"
      >
        <div class="w-full max-w-xl">
          <SearchInput :loading="store.searchLoading" @search="handleSearch" @stop="handleStopSearch" />
        </div>
      </div>

      <!-- 搜索结果区域 -->
      <div v-if="store.searched || store.searchLoading" class="flex-1 overflow-auto px-6">
        <SearchResultList
          :results="store.results"
          :loading="store.searchLoading"
          :searched="store.searched"
          @find-links="handleFindLinks"
        />
      </div>
    </TabsContent>

    <!-- 批量刮削 Tab -->
    <TabsContent value="batch" class="flex-1 overflow-hidden flex flex-col">
      <!-- 工具栏 -->
      <div class="flex items-center justify-between border-b p-4">
        <div class="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            :disabled="store.isProcessingQueue || store.stats.waiting === 0"
            @click="handleStartAll"
          >
            <Play class="mr-2 size-4" />
            开始
          </Button>
          <Button variant="outline" size="sm" @click="handleStopAll">
            <Square class="mr-2 size-4" />
            停止
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="outline" size="sm" :disabled="store.tasks.length === 0" class="gap-2">
                <Trash2 class="size-4" />
                删除
                <ChevronDown class="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" class="w-44">
              <DropdownMenuItem :disabled="store.stats.completed === 0" @click="handleDeleteCompleted">
                删除完成任务
              </DropdownMenuItem>
              <DropdownMenuItem :disabled="store.stats.failed === 0" @click="handleDeleteFailed">
                删除失败任务
              </DropdownMenuItem>
              <DropdownMenuItem :disabled="store.tasks.length === 0" @click="handleDeleteAll">
                删除全部任务
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <!-- 总进度 -->
      <div v-if="store.tasks.length > 0" class="px-4 py-3 border-b">
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-4">
            <span class="text-sm font-medium">任务统计</span>
            <div class="flex items-center gap-2 text-xs text-muted-foreground">
              <span>总计: {{ stats.total }}</span>
              <span class="text-blue-500">运行中: {{ stats.running }}</span>
              <span class="text-green-500">完成: {{ stats.completed }}</span>
              <span v-if="stats.failed > 0" class="text-destructive">失败: {{ stats.failed }}</span>
            </div>
          </div>
        </div>
        <Progress :model-value="stats.total > 0 ? (stats.completed / stats.total) * 100 : 0" class="h-2" />
      </div>

      <!-- 主内容区域 -->
      <div class="flex flex-1 min-h-0 overflow-hidden">
        <div class="flex-1 overflow-hidden flex flex-col">
          <!-- 表头 -->
          <div class="border-b bg-background sticky top-0 z-10">
            <div class="flex items-center h-12">
              <div class="flex-1 min-w-0 px-4 font-medium text-sm text-muted-foreground">路径</div>
              <div class="w-40 shrink-0 px-4 font-medium text-sm text-muted-foreground">进度</div>
              <div class="w-24 shrink-0 px-4 font-medium text-sm text-muted-foreground">状态</div>
            </div>
          </div>

          <!-- 虚拟滚动表格 -->
          <VirtualScrapeTable
            v-if="store.tasks.length > 0"
            :tasks="store.tasks"
            @open-folder="handleOpenFolder"
            @start-task="handleStartTask"
            @stop-task="handleStopTask"
            @remove-task="handleRemoveTask"
          />

          <!-- 空状态 -->
          <div v-else class="flex-1 flex items-center justify-center text-muted-foreground">
            暂无刮削任务，需要科学上网
          </div>
        </div>
      </div>
    </TabsContent>
    <!-- 资源链接 Tab -->
    <TabsContent value="video-links" class="flex-1 overflow-hidden">
      <VideoLinkFinder ref="videoLinkFinderRef" />
    </TabsContent>
  </Tabs>

  <!-- 刮削对话框 -->
  <ScrapeDialog ref="scrapeDialogRef" @success="store.fetchTasks()" />
  </div>
</template>
