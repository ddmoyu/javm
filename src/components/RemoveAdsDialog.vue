<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { Trash2, Plus, Loader2, FolderOpen, RefreshCw, Ban } from 'lucide-vue-next'
import { invoke } from '@tauri-apps/api/core'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
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
import DeleteVideoDialog from './DeleteVideoDialog.vue'

interface Props {
  open?: boolean
}

interface Emits {
  (e: 'update:open', value: boolean): void
  (e: 'success'): void
}

interface AdVideo {
  id: string
  path: string
  filename: string
  fileSize: number
  reason: string
}

const props = withDefaults(defineProps<Props>(), {
  open: false,
})

const emit = defineEmits<Emits>()

const isOpen = computed({
  get: () => props.open,
  set: (value) => emit('update:open', value),
})

const isLoading = ref(false)
const adVideos = ref<AdVideo[]>([])
const selectedIds = ref<Set<string>>(new Set())
const keywordDialogOpen = ref(false)
const keywordText = ref('')
const keywords = ref<string[]>([])
const excludeKeywordDialogOpen = ref(false)
const excludeKeywordText = ref('')
const excludeKeywords = ref<string[]>([])
const checkDuplicate = ref(true) // 默认开启文件名重复检测

// 加载设置中的关键词
const loadKeywords = async () => {
  try {
    const settings = await invoke<any>('get_settings')
    if (settings.ad_filter) {
      if (settings.ad_filter.keywords) {
        keywords.value = settings.ad_filter.keywords
      }
      if (settings.ad_filter.exclude_keywords) {
        excludeKeywords.value = settings.ad_filter.exclude_keywords
      }
      console.log('[RemoveAdsDialog] 加载关键词:', keywords.value, '排除关键词:', excludeKeywords.value)
    }
  } catch (e) {
    console.error('[RemoveAdsDialog] 加载关键词失败:', e)
  }
}

// 保存关键词到设置
const saveKeywordsToSettings = async () => {
  try {
    const settings = await invoke<any>('get_settings')
    settings.ad_filter = settings.ad_filter || {}
    settings.ad_filter.keywords = keywords.value
    settings.ad_filter.exclude_keywords = excludeKeywords.value
    await invoke('save_settings', { settings })
    console.log('[RemoveAdsDialog] 保存关键词成功')
  } catch (e) {
    console.error('[RemoveAdsDialog] 保存关键词失败:', e)
  }
}

// 加载广告视频列表
const loadAdVideos = async () => {
  console.log('[RemoveAdsDialog] 开始加载广告视频...')
  isLoading.value = true
  try {
    console.log('[RemoveAdsDialog] 调用 find_ad_videos，关键词:', keywords.value, '排除关键词:', excludeKeywords.value, '检查重复:', checkDuplicate.value)
    const result = await invoke<AdVideo[]>('find_ad_videos', {
      keywords: keywords.value.length > 0 ? keywords.value : null,
      checkDuplicate: checkDuplicate.value,
      excludeKeywords: excludeKeywords.value.length > 0 ? excludeKeywords.value : null
    })
    console.log('[RemoveAdsDialog] 找到广告视频:', result.length, '个')
    console.log('[RemoveAdsDialog] 详细数据:', result)
    adVideos.value = result
    selectedIds.value.clear()
  } catch (e) {
    console.error('[RemoveAdsDialog] 加载失败:', e)
    alert('加载广告视频失败：' + e)
  } finally {
    isLoading.value = false
  }
}

// 监听对话框打开，自动查找
watch(() => props.open, async (newVal) => {
  console.log('[RemoveAdsDialog] watch 触发，open =', newVal)
  if (newVal) {
    console.log('[RemoveAdsDialog] 对话框打开，开始加载数据')
    // 对话框打开时才加载关键词
    await loadKeywords()
    loadAdVideos()
  }
})

// 全选/取消全选
const allSelected = computed({
  get: () => adVideos.value.length > 0 && selectedIds.value.size === adVideos.value.length,
  set: (value) => {
    if (value) {
      selectedIds.value = new Set(adVideos.value.map(v => v.id))
    } else {
      selectedIds.value.clear()
    }
  }
})

// 切换单个选择
const toggleSelect = (id: string) => {
  if (selectedIds.value.has(id)) {
    selectedIds.value.delete(id)
  } else {
    selectedIds.value.add(id)
  }
}

// 添加关键词
const handleAddKeyword = () => {
  keywordText.value = keywords.value.join('\n')
  keywordDialogOpen.value = true
}

// 保存关键词
const handleSaveKeywords = async () => {
  const lines = keywordText.value
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
  
  keywords.value = [...new Set(lines)] // 去重
  keywordDialogOpen.value = false
  
  // 保存到设置
  await saveKeywordsToSettings()
  
  // 重新加载
  loadAdVideos()
}

// 打开排除关键词编辑
const handleAddExcludeKeyword = () => {
  excludeKeywordText.value = excludeKeywords.value.join('\n')
  excludeKeywordDialogOpen.value = true
}

// 保存排除关键词
const handleSaveExcludeKeywords = async () => {
  const lines = excludeKeywordText.value
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
  
  excludeKeywords.value = [...new Set(lines)] // 去重
  excludeKeywordDialogOpen.value = false
  
  // 保存到设置
  await saveKeywordsToSettings()
  
  // 重新加载
  loadAdVideos()
}

// 从文件名添加关键词
const addFilenameAsKeyword = async (filename: string) => {
  // 移除扩展名
  const nameWithoutExt = filename.replace(/\.[^/.]+$/, '')
  if (!keywords.value.includes(nameWithoutExt)) {
    keywords.value.push(nameWithoutExt)
    await saveKeywordsToSettings()
    loadAdVideos()
  }
}

// 批量删除选中的视频
const showBatchDeleteDialog = ref(false)
const handleDeleteSelected = () => {
  if (selectedIds.value.size === 0) return
  showBatchDeleteDialog.value = true
}

const handleBatchDeleteSuccess = async () => {
  selectedIds.value.clear()
  await loadAdVideos()
  emit('success')
}

// 删除单个视频
const videoToDelete = ref<string | null>(null)
const showDeleteDialog = ref(false)

const handleDeleteVideo = (id: string) => {
  videoToDelete.value = id
  showDeleteDialog.value = true
}

const handleDeleteSuccess = async () => {
  videoToDelete.value = null
  await loadAdVideos()
  emit('success')
}

// 打开目录
const handleOpenDirectory = async (path: string) => {
  try {
    await invoke('open_in_explorer', { path })
  } catch (e) {
    console.error('Failed to open directory:', e)
    alert('打开目录失败：' + e)
  }
}
</script>

<template>
  <Dialog v-model:open="isOpen">
    <DialogContent class="max-w-[90vw] w-[1000px] max-h-[85vh] flex flex-col sm:max-w-[1000px]">
      <DialogHeader>
        <DialogTitle>移除广告视频</DialogTitle>
        <DialogDescription>
          查找并删除疑似广告的视频文件
        </DialogDescription>
      </DialogHeader>

      <!-- 工具栏 -->
      <div class="flex items-center gap-2 py-2 border-b">
        <Button 
          variant="outline" 
          size="sm"
          :disabled="isLoading"
          @click="loadAdVideos"
        >
          <RefreshCw class="mr-2 size-4" />
          重新扫描
        </Button>

        <Button 
          variant="destructive" 
          size="sm" 
          :disabled="selectedIds.size === 0 || isLoading"
          @click="handleDeleteSelected"
        >
          <Trash2 class="mr-2 size-4" />
          删除选中 ({{ selectedIds.size }})
        </Button>

        <Button 
          variant="outline" 
          size="sm"
          :disabled="isLoading"
          @click="handleAddKeyword"
        >
          <Plus class="mr-2 size-4" />
          添加关键词 ({{ keywords.length }})
        </Button>

        <Button 
          variant="outline" 
          size="sm"
          :disabled="isLoading"
          @click="handleAddExcludeKeyword"
        >
          <Ban class="mr-2 size-4" />
          排除关键词 ({{ excludeKeywords.length }})
        </Button>

        <div class="ml-auto text-sm text-muted-foreground">
          <span v-if="isLoading">正在扫描...</span>
          <span v-else>找到 {{ adVideos.length }} 个疑似广告视频</span>
        </div>
      </div>

      <!-- 表格 -->
      <div class="flex-1 overflow-auto border rounded-md relative min-h-[400px]">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead class="w-12">
                <input 
                  type="checkbox"
                  :checked="allSelected"
                  @change="allSelected = !allSelected"
                  class="size-4 rounded border cursor-pointer"
                />
              </TableHead>
              <TableHead class="w-[35%]">文件名</TableHead>
              <TableHead class="w-[50%]">移除原因</TableHead>
              <TableHead class="w-[15%] text-center">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-if="isLoading">
              <TableCell colspan="4" class="text-center py-12">
                <div class="flex flex-col items-center gap-3">
                  <Loader2 class="size-8 animate-spin text-primary" />
                  <span class="text-sm text-muted-foreground">正在扫描视频文件...</span>
                </div>
              </TableCell>
            </TableRow>
            <TableRow v-else-if="adVideos.length === 0">
              <TableCell colspan="4" class="text-center text-muted-foreground py-8">
                未找到疑似广告的视频
              </TableCell>
            </TableRow>
            <ContextMenu v-for="video in adVideos" :key="video.id" v-else>
              <ContextMenuTrigger as-child>
                <TableRow class="cursor-context-menu">
                  <TableCell>
                    <input 
                      type="checkbox"
                      :checked="selectedIds.has(video.id)"
                      @change="toggleSelect(video.id)"
                      class="size-4 rounded border cursor-pointer"
                    />
                  </TableCell>
                  <TableCell class="font-mono text-sm truncate max-w-0" :title="video.path">
                    {{ video.filename }}
                  </TableCell>
                  <TableCell class="text-sm text-muted-foreground">
                    {{ video.reason }}
                  </TableCell>
                  <TableCell>
                    <div class="flex items-center justify-center">
                      <Button 
                        variant="ghost" 
                        size="sm"
                        class="h-8 w-8 p-0 text-destructive hover:text-destructive"
                        :disabled="isLoading"
                        @click="handleDeleteVideo(video.id)"
                      >
                        <Trash2 class="size-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem @click="handleOpenDirectory(video.path)">
                  <FolderOpen class="mr-2 size-4" />
                  打开目录
                </ContextMenuItem>
                <ContextMenuItem @click="addFilenameAsKeyword(video.filename)">
                  <Plus class="mr-2 size-4" />
                  添加文件名到过滤关键词
                </ContextMenuItem>
                <ContextMenuItem 
                  class="text-destructive focus:text-destructive"
                  @click="handleDeleteVideo(video.id)"
                >
                  <Trash2 class="mr-2 size-4" />
                  删除视频
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </TableBody>
        </Table>
      </div>
    </DialogContent>
  </Dialog>

  <!-- 添加关键词对话框 -->
  <Dialog v-model:open="keywordDialogOpen">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle>添加过滤关键词</DialogTitle>
        <DialogDescription>
          每行一个关键词，路径、文件名或标题包含这些关键词的视频将被标记为广告
        </DialogDescription>
      </DialogHeader>
      
      <Textarea
        v-model="keywordText"
        placeholder="输入关键词，每行一个&#10;例如：&#10;全網網黃國&#10;广告&#10;宣传片"
        class="min-h-[200px] font-mono"
      />
      
      <DialogFooter>
        <Button variant="outline" @click="keywordDialogOpen = false">取消</Button>
        <Button @click="handleSaveKeywords">保存</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <!-- 排除关键词对话框 -->
  <Dialog v-model:open="excludeKeywordDialogOpen">
    <DialogContent class="max-w-md">
      <DialogHeader>
        <DialogTitle>排除关键词</DialogTitle>
        <DialogDescription>
          每行一个关键词，路径、文件名或标题包含这些关键词的视频将不会出现在广告列表中
        </DialogDescription>
      </DialogHeader>
      
      <Textarea
        v-model="excludeKeywordText"
        placeholder="输入排除关键词，每行一个&#10;例如：&#10;正片&#10;合集"
        class="min-h-[200px] font-mono"
      />
      
      <DialogFooter>
        <Button variant="outline" @click="excludeKeywordDialogOpen = false">取消</Button>
        <Button @click="handleSaveExcludeKeywords">保存</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <!-- 删除确认对话框 - 单个删除 -->
  <DeleteVideoDialog
    v-model:open="showDeleteDialog"
    :video-ids="videoToDelete ? [videoToDelete] : []"
    @success="handleDeleteSuccess"
  />

  <!-- 删除确认对话框 - 批量删除 -->
  <DeleteVideoDialog
    v-model:open="showBatchDeleteDialog"
    :video-ids="Array.from(selectedIds)"
    @success="handleBatchDeleteSuccess"
  />
</template>
