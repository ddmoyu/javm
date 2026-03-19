<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sparkles, Loader2 } from 'lucide-vue-next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'vue-sonner'
import { useResourceScrapeStore } from '@/stores/resourceScrape'
import type { ResourceItem } from '@/types'
import { toImageSrc } from '@/utils/image'
import { openImagePreview, isFancyboxOpen } from '@/composables/useImagePreview'
import type { PreviewImage } from '@/composables/useImagePreview'

// 引入 resourceScrape store，使用新架构的搜索方法
const scrapeStore = useResourceScrapeStore()

const isDev = import.meta.env.DEV

const open = ref(false)
const originalTitle = ref('')
const localId = ref('')
const videoId = ref('')
const videoPath = ref('')
const loading = ref(false)
const aiRecognizing = ref(false)
// 用户从多数据源搜索结果中选择的项
const selectedResult = ref<ResourceItem | null>(null)

// 番号不为空才能刮削
const canStartScrape = computed(() => {
  return localId.value.trim().length > 0 && !loading.value
})

// 监听 store 的搜索加载状态，同步到本地 loading
watch(() => scrapeStore.searchLoading, (newVal) => {
  loading.value = newVal
})

// 监听 store 的搜索结果变化
watch(() => scrapeStore.results, (newResults) => {
  if (newResults.length > 0 && !selectedResult.value) {
    // 自动选择第一个结果作为默认
    selectedResult.value = newResults[0]
  }
}, { deep: true })

// 监听搜索完成（loading 从 true 变为 false），处理无结果情况
watch(() => scrapeStore.searchLoading, (newVal, oldVal) => {
  if (oldVal && !newVal && open.value) {
    // 搜索完成
    if (scrapeStore.results.length === 0) {
      toast.error('未找到番号 ' + localId.value + ' 的数据')
    } else if (scrapeStore.results.length > 0 && !selectedResult.value) {
      selectedResult.value = scrapeStore.results[0]
    }
    if (scrapeStore.searchError) {
      toast.error('搜索失败: ' + scrapeStore.searchError)
    }
  }
})

// AI识别番号（直接使用 AI）
const recognizeLocalId = async () => {
  if (!originalTitle.value.trim()) {
    toast.error('请先输入原标题')
    return
  }

  aiRecognizing.value = true

  try {
    const result = await invoke<{ success: boolean; designation: string | null; method: string; message: string }>('recognize_designation_with_ai', {
      title: originalTitle.value.trim(),
      forceAi: true // 点击按钮时直接使用 AI
    })

    if (result.success && result.designation) {
      localId.value = result.designation
      toast.success(`${result.message}: ${result.designation}`)
    } else {
      toast.error(result.message || '未能识别出番号')
    }
  } catch (e) {
    console.error('AI识别失败:', e)
    toast.error('AI识别失败: ' + String(e))
  } finally {
    aiRecognizing.value = false
  }
}

const startScrape = async () => {
  if (!localId.value) return

  loading.value = true
  selectedResult.value = null

  try {
    // 使用 resourceScrape store 的 search 方法（调用 rs_search_resource）
    await scrapeStore.search(localId.value)
    // 搜索结果通过 store.results 响应式状态流式推送
    // loading 状态通过 watch(scrapeStore.searchLoading) 自动同步
  } catch (e) {
    console.error(e)
    toast.error('搜索失败: ' + String(e))
    loading.value = false
  }
}

const emit = defineEmits<{
  (e: 'success'): void
}>()

const saving = ref(false)

const saveData = async (shouldClose: boolean = true) => {
  if (!selectedResult.value) return

  saving.value = true
  try {
    // 使用 store 的 scrapeSave 方法（调用 rs_scrape_save）
    await scrapeStore.scrapeSave(videoId.value, selectedResult.value)
    toast.success('保存成功！')
    emit('success')
    if (shouldClose) {
      open.value = false
    }
  } catch (e) {
    toast.error('保存失败: ' + String(e))
  } finally {
    saving.value = false
  }
}

// 从标题中提取番号的函数
const extractLocalIdFromTitle = (title: string): string => {
  if (!title) return ''

  // 常见的番号格式：ABC-123, ABC123, ABCD-123 等
  // 支持多种格式：字母+数字，字母-数字，字母数字混合
  const patterns = [
    /([A-Z]{2,6}[-_]?\d{3,5})/i,  // ABC-123, ABC123, ABCD-1234
    /([A-Z]+\d+[A-Z]*)/i,          // ABC123, T28-123
    /(\d{6}[-_]\d{3})/,            // 数字格式 123456-789
  ]

  for (const pattern of patterns) {
    const match = title.match(pattern)
    if (match) {
      // 标准化格式：确保有连字符
      let localId = match[1].toUpperCase()
      // 如果没有连字符，尝试在字母和数字之间添加
      if (!localId.includes('-') && !localId.includes('_')) {
        localId = localId.replace(/([A-Z]+)(\d+)/, '$1-$2')
      }
      // 将下划线替换为连字符
      localId = localId.replace(/_/g, '-')
      return localId
    }
  }

  return ''
}

// Expose open method
const openDialog = (video: any) => {
  console.log('[ScrapeDialog] openDialog called with:', video)

  // 重置状态
  scrapeStore.reset()
  selectedResult.value = null
  loading.value = false

  if (typeof video === 'string') {
    // Backward compatibility or manual localId input
    localId.value = video
    originalTitle.value = ''
    videoId.value = ''
    videoPath.value = ''
  } else {
    // 设置原标题（通常是文件名）
    originalTitle.value = video.title || video.name || ''
    videoId.value = video.id || ''
    videoPath.value = video.path || video.videoPath || ''

    // 如果有视频标题，自动提取番号
    if (originalTitle.value) {
      const extractedLocalId = extractLocalIdFromTitle(originalTitle.value)
      // 优先使用提取的番号，如果提取失败则使用传入的 localId
      localId.value = extractedLocalId || video.localId || ''
    } else {
      // 没有标题时使用传入的 localId
      localId.value = video.localId || ''
    }
  }

  console.log('[ScrapeDialog] Dialog state after open:', {
    originalTitle: originalTitle.value,
    localId: localId.value,
    videoId: videoId.value,
    videoPath: videoPath.value
  })

  open.value = true

  if (localId.value) {
    // 不要自动开始刮削，让用户确认
    // startScrape()
  }
}

// 将逗号分隔字符串拆分为数组（用于标签和演员展示）
const tagsArray = computed(() => {
  if (!selectedResult.value?.tags) return []
  return selectedResult.value.tags.split(',').map(s => s.trim()).filter(Boolean)
})

const actorsArray = computed(() => {
  if (!selectedResult.value?.actors) return []
  return selectedResult.value.actors.split(',').map(s => s.trim()).filter(Boolean)
})

// 从标签数组中移除指定索引的标签，更新回逗号分隔字符串
const removeTag = (idx: number) => {
  const arr = tagsArray.value.slice()
  arr.splice(idx, 1)
  if (selectedResult.value) {
    selectedResult.value = { ...selectedResult.value, tags: arr.join(', ') }
  }
}

const removeActor = (idx: number) => {
  const arr = actorsArray.value.slice()
  arr.splice(idx, 1)
  if (selectedResult.value) {
    selectedResult.value = { ...selectedResult.value, actors: arr.join(', ') }
  }
}

// 选择搜索结果
const selectResult = (item: ResourceItem) => {
  selectedResult.value = { ...item }
}

// Fancybox 打开时阻止外部点击关闭弹框
const onInteractOutside = (e: Event) => {
  if (isFancyboxOpen()) e.preventDefault()
}

const previewThumbs = computed<PreviewImage[]>(() => {
  return (selectedResult.value?.thumbs ?? []).flatMap((thumb, idx) => {
    const src = toImageSrc(thumb) ?? thumb
    if (!src) return []

    return [{
      src,
      title: `预览图 ${idx + 1}`,
    }]
  })
})

const previewStartIndex = computed(() => {
  return selectedResult.value?.coverUrl ? 1 : 0
})

// 构建可预览的图片列表（封面 + 预览图）
const allPreviewImages = computed<PreviewImage[]>(() => {
  const images: PreviewImage[] = []
  if (selectedResult.value?.coverUrl) {
    const src = toImageSrc(selectedResult.value.coverUrl) ?? selectedResult.value.coverUrl
    images.push({ src, title: '封面' })
  }
  images.push(...previewThumbs.value)
  return images
})

// 打开图片预览（Fancybox）
const openImageViewer = (index: number) => {
  if (allPreviewImages.value.length === 0) return
  openImagePreview(allPreviewImages.value, index)
}

const openPreviewThumbViewer = (index: number) => {
  openImageViewer(previewStartIndex.value + index)
}

defineExpose({
  open: openDialog
})
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-4xl max-h-[85vh] flex flex-col overflow-hidden" @interact-outside="onInteractOutside">
      <DialogHeader>
        <DialogTitle>数据刮削</DialogTitle>
        <DialogDescription>
          输入番号获取视频元数据
        </DialogDescription>
      </DialogHeader>

      <!-- 顶部搜索区域 -->
      <div class="grid gap-4 py-2 flex-shrink-0">
        <div class="grid grid-cols-4 items-center gap-4">
          <Label for="originalTitle" class="text-right">原标题</Label>
          <Input id="originalTitle" v-model="originalTitle" class="col-span-3" placeholder="视频文件的原始标题" />
        </div>
        <div class="grid grid-cols-4 items-center gap-4">
          <Label for="localId" class="text-right">番号</Label>
          <div class="col-span-3 flex gap-2">
            <Input id="localId" v-model="localId" class="flex-1" placeholder="输入番号或从标题自动提取" @keyup.enter="canStartScrape && startScrape()" />
            <Button type="button" variant="outline" size="icon" :disabled="aiRecognizing || !originalTitle.trim()" @click="recognizeLocalId" title="使用AI识别番号">
              <Loader2 v-if="aiRecognizing" class="size-4 animate-spin" />
              <Sparkles v-else class="size-4" />
            </Button>
          </div>
        </div>
      </div>

      <!-- 左右分栏：搜索结果 + 详情编辑 -->
      <div v-if="scrapeStore.results.length > 0 || scrapeStore.searchLoading" class="flex gap-4 flex-1 min-h-0">
        <!-- 左侧：搜索结果列表 -->
        <div class="w-[220px] flex-shrink-0 border rounded-md overflow-hidden flex flex-col">
          <div class="px-3 py-2 bg-muted/50 text-xs font-medium border-b">
            搜索结果（{{ scrapeStore.results.length }} 条）
          </div>
          <div class="flex-1 overflow-y-auto">
            <div
              v-for="(item, idx) in scrapeStore.results"
              :key="item.code + (item.source ?? '') + idx"
              class="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-muted/50 transition-colors border-b last:border-b-0"
              :class="{ 'bg-muted': selectedResult && selectedResult.code === item.code && selectedResult.source === item.source }"
              @click="selectResult(item)"
            >
              <img v-if="item.coverUrl" :src="toImageSrc(item.coverUrl) ?? ''" class="w-9 h-12 object-cover rounded flex-shrink-0" referrerPolicy="no-referrer" />
              <div class="min-w-0 flex-1">
                <div class="text-xs font-medium truncate">{{ item.code }}</div>
                <div class="text-[10px] text-muted-foreground truncate">{{ item.title }}</div>
                <div v-if="isDev" class="text-[10px] text-muted-foreground">{{ item.source ?? '未知来源' }}</div>
              </div>
            </div>
            <!-- 加载中 -->
            <div v-if="scrapeStore.searchLoading" class="flex items-center justify-center py-4 text-xs text-muted-foreground">
              <Loader2 class="size-4 animate-spin mr-2" />
              搜索中...
            </div>
          </div>
        </div>

        <!-- 右侧：选中结果详情编辑 -->
        <div class="flex-1 min-w-0 overflow-y-auto">
          <div v-if="selectedResult" class="p-4 bg-muted rounded-md text-xs space-y-3">
            <div v-if="selectedResult.coverUrl" class="flex justify-center">
              <img :src="toImageSrc(selectedResult.coverUrl) ?? ''" class="max-w-[200px] rounded shadow-md cursor-pointer hover:ring-2 hover:ring-primary transition-all" referrerPolicy="no-referrer" @click="openImageViewer(0)" />
            </div>
            <div class="space-y-2">
              <div class="grid grid-cols-4 items-center gap-3">
                <Label class="text-right">标题</Label>
                <Input v-model="selectedResult.title" class="col-span-3 h-8 text-xs" />
              </div>
              <div class="grid grid-cols-4 items-center gap-3">
                <Label class="text-right">番号</Label>
                <Input v-model="selectedResult.code" class="col-span-3 h-8 text-xs" />
              </div>
              <div class="grid grid-cols-4 items-center gap-3">
                <Label class="text-right">发行日期</Label>
                <Input v-model="selectedResult.premiered" class="col-span-3 h-8 text-xs" />
              </div>
              <div class="grid grid-cols-4 items-center gap-3">
                <Label class="text-right">时长</Label>
                <Input v-model="selectedResult.duration" class="col-span-3 h-8 text-xs" />
              </div>
              <div class="grid grid-cols-4 items-center gap-3">
                <Label class="text-right">制作商</Label>
                <Input v-model="selectedResult.studio" class="col-span-3 h-8 text-xs" />
              </div>
              <div class="grid grid-cols-4 items-center gap-3">
                <Label class="text-right">导演</Label>
                <Input v-model="selectedResult.director" class="col-span-3 h-8 text-xs" />
              </div>
              <div class="grid grid-cols-4 items-center gap-3">
                <Label class="text-right">评分</Label>
                <Input v-model="selectedResult.rating" type="number" step="0.1" class="col-span-3 h-8 text-xs" />
              </div>
              <div class="grid grid-cols-4 items-start gap-3">
                <Label class="text-right mt-2">分类标签</Label>
                <div class="col-span-3 flex flex-wrap gap-1 p-2 border rounded-md min-h-[40px]">
                  <span v-for="(tag, idx) in tagsArray" :key="idx" class="bg-secondary px-1 rounded text-[10px] flex items-center gap-1">
                    {{ tag }}
                    <button class="hover:text-destructive" @click="removeTag(idx)">×</button>
                  </span>
                </div>
              </div>
              <div class="grid grid-cols-4 items-start gap-3">
                <Label class="text-right mt-2">演员</Label>
                <div class="col-span-3 flex flex-wrap gap-1 p-2 border rounded-md min-h-[40px]">
                  <span v-for="(actor, idx) in actorsArray" :key="idx" class="bg-secondary px-1 rounded text-[10px] flex items-center gap-1">
                    {{ actor }}
                    <button class="hover:text-destructive" @click="removeActor(idx)">×</button>
                  </span>
                </div>
              </div>
              <div class="grid grid-cols-4 items-start gap-3">
                <Label class="text-right mt-2">预览图</Label>
                <div class="col-span-3 space-y-2">
                  <div v-if="previewThumbs.length > 0" class="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    <button
                      v-for="(thumb, idx) in previewThumbs"
                      :key="thumb.src + idx"
                      type="button"
                      class="group overflow-hidden rounded border bg-background/70 shadow-sm transition-all hover:ring-2 hover:ring-primary"
                      @click="openPreviewThumbViewer(idx)"
                    >
                      <img
                        :src="thumb.src"
                        :alt="thumb.title ?? `预览图 ${idx + 1}`"
                        class="aspect-video w-full object-cover transition-transform group-hover:scale-[1.02]"
                        loading="lazy"
                        referrerPolicy="no-referrer"
                      />
                    </button>
                  </div>
                  <div v-else class="rounded border border-dashed bg-background/40 px-3 py-4 text-center text-[11px] text-muted-foreground">
                    暂无预览图
                  </div>
                </div>
              </div>
            </div>
          </div>
          <!-- 未选择时的占位 -->
          <div v-else class="flex items-center justify-center h-full text-sm text-muted-foreground">
            点击左侧结果查看详情
          </div>
        </div>
      </div>

      <!-- 搜索前的加载提示（无结果时） -->
      <div v-else-if="scrapeStore.searchLoading" class="flex items-center justify-center py-8 text-sm text-muted-foreground">
        <Loader2 class="size-4 animate-spin mr-2" />
        正在搜索...
      </div>

      <DialogFooter class="flex-shrink-0">
        <div v-if="selectedResult" class="flex gap-2 w-full justify-between">
          <Button variant="outline" type="button" @click="startScrape" :disabled="loading || saving">
            重新刮削
          </Button>
          <Button type="button" @click="saveData(true)" :disabled="saving">
            <Loader2 v-if="saving" class="mr-2 size-4 animate-spin" />
            {{ saving ? '保存中...' : '保存并关闭' }}
          </Button>
        </div>
        <Button v-else type="submit" @click="startScrape" :disabled="!canStartScrape">
          {{ loading ? '刮削中...' : '开始刮削' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
