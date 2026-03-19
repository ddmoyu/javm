<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Checkbox } from '@/components/ui/checkbox'
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
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  Loader2,
  Download,
  Link as LinkIcon,
  CheckCircle2,
  FolderOpen,
  X,
  ChevronDown,
  Globe,
  Search,
  Play,
} from 'lucide-vue-next'
import {
  findVideoLinks,
  closeVideoFinder,
  verifyHls,
  addDownloadTask,
  getVideoSites,
  getSiteReferer,
  openVideoPlayerWindow,
  type VideoLink,
  type VideoSite,
  type HlsVerifyResult,
  checkVideoExists,
  type VideoExistCheckResult
} from '@/lib/tauri'
import { getSettings, selectDirectory } from '@/lib/tauri'
import { toast } from 'vue-sonner'

// 状态
const code = ref('')
const scanning = ref(false)
const links = ref<VideoLink[]>([])
const selectedUrls = ref<Set<string>>(new Set())
const savePath = ref('')
const adding = ref(false)
const sites = ref<VideoSite[]>([])
const selectedSiteId = ref('missav')
const cfChallengeActive = ref(false)
const seenUrls = new Set<string>()
let unlisten: UnlistenFn | null = null
let unlistenCf: UnlistenFn | null = null

// 下载查重状态
const duplicateCheckOpen = ref(false)
const duplicateVideoInfo = ref<VideoExistCheckResult['video']>()
// 保存当前等待确认的回调
const pendingDownloadContext = ref<{ type: 'single', link: VideoLink } | { type: 'batch' } | null>(null)

// 当前选中网站名称
const selectedSiteName = computed(() => {
  const index = sites.value.findIndex(s => s.id === selectedSiteId.value)
  return index !== -1 ? `资源 ${index + 1}` : '资源 1'
})

// HLS 链接数量
const hlsCount = computed(() => links.value.filter(l => l.isHls).length)

// 能否开始查找
const canStart = computed(() => code.value.trim().length > 0 && !scanning.value)

// 处理捕获到的链接（屏蔽 mp4，只保留 HLS）
async function handleCapturedUrl(url: string) {
  if (seenUrls.has(url)) return
  seenUrls.add(url)

  const lowerUrlPath = url.split('?')[0].toLowerCase()

  // 屏蔽 mp4 链接
  if (lowerUrlPath.endsWith('.mp4')) return
  // 过滤 .ts 片段
  if (lowerUrlPath.endsWith('.ts')) return

  const linkType = (lowerUrlPath.endsWith('.m3u8') || lowerUrlPath.endsWith('.txt')) ? 'm3u8' : 'unknown'

  // 只处理 m3u8 (含模拟的.txt) 链接
  if (linkType !== 'm3u8') return

  let isHls = false
  let isVod = true
  let resolution: string | null = url.match(/(?:2160p|1080p|720p|480p|360p|4k)/i)?.[0]?.toLowerCase() ?? null

  try {
    const site = sites.value.find(s => s.id === selectedSiteId.value)
    const referer = getSiteReferer(site)
    const result: HlsVerifyResult = await verifyHls(url, referer)
    isHls = result.isHls
    isVod = result.isVod
    if (!resolution && result.resolution) resolution = result.resolution
    // 过滤直播流
    if (!isVod && isHls) return
  } catch { /* 忽略 */ }

  const link: VideoLink = { url, linkType, isHls, resolution }
  links.value = [...links.value, link]

}

// 开始查找
async function startFinding() {
  const trimmed = code.value.trim().toUpperCase()
  if (!trimmed) return

  scanning.value = true
  links.value = []
  selectedUrls.value = new Set()
  seenUrls.clear()

  // 加载网站列表
  try { sites.value = await getVideoSites() } catch { /* 忽略 */ }

  // 获取默认下载路径
  try {
    const settings = await getSettings()
    if (settings.download?.savePath) savePath.value = settings.download.savePath
  } catch { /* 忽略 */ }

  // 监听事件
  try {
    unlisten = await listen<string>('video-finder-link', (event) => {
      handleCapturedUrl(event.payload)
    })

    unlistenCf = await listen<boolean>('video-finder-cf-state', (event) => {
      const nextActive = Boolean(event.payload)
      if (cfChallengeActive.value === nextActive) return

      cfChallengeActive.value = nextActive
      if (nextActive) {
        toast.info('触发 Cloudflare 验证，请在弹出的 WebView 中完成验证')
      } else {
        toast.success('Cloudflare 验证已通过，继续监听视频链接')
      }
    })
  } catch (e) {
    console.error('监听事件失败:', e)
  }

  // 打开 WebView
  try {
    await findVideoLinks(trimmed, selectedSiteId.value)
  } catch (e: any) {
    toast.error(`打开查找窗口失败: ${e}`)
    scanning.value = false
    cfChallengeActive.value = false
  }
}

// 切换网站
async function switchSite(siteId: string) {
  selectedSiteId.value = siteId
  try { await closeVideoFinder() } catch { /* 忽略 */ }
  links.value = []
  selectedUrls.value = new Set()
  seenUrls.clear()
  cfChallengeActive.value = false
  scanning.value = true
  try {
    await findVideoLinks(code.value.trim().toUpperCase(), siteId)
  } catch (e: any) {
    toast.error(`打开查找窗口失败: ${e}`)
    scanning.value = false
    cfChallengeActive.value = false
  }
}

// 停止查找
async function stopFinding() {
  scanning.value = false
  if (unlisten) { unlisten(); unlisten = null }
  if (unlistenCf) { unlistenCf(); unlistenCf = null }
  cfChallengeActive.value = false
  try { await closeVideoFinder() } catch { /* 忽略 */ }
}

function toggleSelect(url: string) {
  const next = new Set(selectedUrls.value)
  if (next.has(url)) next.delete(url)
  else next.add(url)
  selectedUrls.value = next
}

function selectAll() {
  selectedUrls.value = new Set(links.value.map(l => l.url))
}

function selectNone() {
  selectedUrls.value = new Set()
}

async function handleSelectPath() {
  try {
    const selected = await selectDirectory()
    if (selected) savePath.value = selected
  } catch { toast.error('选择目录失败') }
}

async function handleAddTasks(ignoreDuplicate: boolean = false) {
  if (selectedUrls.value.size === 0 || !savePath.value) return

  const filename = code.value.trim().toUpperCase()

  if (!ignoreDuplicate) {
    try {
      const checkResult = await checkVideoExists(filename)
      if (checkResult.exists) {
        duplicateVideoInfo.value = checkResult.video
        pendingDownloadContext.value = { type: 'batch' }
        duplicateCheckOpen.value = true
        return
      }
    } catch (e) {
      toast.error(`查重失败: ${e}`)
      return
    }
  }

  adding.value = true
  let success = 0
  let failed = 0

  for (const url of selectedUrls.value) {
    try {
      await addDownloadTask(url, savePath.value, filename)
      success++
    } catch { failed++ }
  }

  adding.value = false
  if (success > 0) toast.success(`已添加 ${success} 个下载任务`)
  if (failed > 0) toast.error(`${failed} 个任务添加失败（已存在）`)
}

// 回车键触发查找
function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && canStart.value) startFinding()
}

// 预览 HLS 视频
async function handlePreview(link: VideoLink) {
  if (!link.isHls) {
    toast.error('该链接不是 HLS，无法直接预览')
    return
  }
  const title = `${code.value.trim().toUpperCase()} - 在线预览`
  try {
    await openVideoPlayerWindow(link.url, title, true)
  } catch (e) {
    toast.error('打开预览失败: ' + String(e))
  }
}

// 下载单个视频
async function handleDownloadSingle(link: VideoLink, ignoreDuplicate: boolean = false) {
  if (!savePath.value) {
    toast.error('请先选择保存目录')
    return
  }
  const filename = code.value.trim().toUpperCase()

  if (!ignoreDuplicate) {
    try {
      const checkResult = await checkVideoExists(filename)
      if (checkResult.exists) {
        duplicateVideoInfo.value = checkResult.video
        pendingDownloadContext.value = { type: 'single', link }
        duplicateCheckOpen.value = true
        return
      }
    } catch (e) {
      toast.error(`查重失败: ${e}`)
      return
    }
  }

  try {
    await addDownloadTask(link.url, savePath.value, filename)
    toast.success('已添加下载任务')
  } catch {
    toast.error('添加任务失败（已存在）')
  }
}

// 确认强制下载
function forceDownload() {
  duplicateCheckOpen.value = false
  if (pendingDownloadContext.value?.type === 'batch') {
    handleAddTasks(true)
  } else if (pendingDownloadContext.value?.type === 'single') {
    handleDownloadSingle(pendingDownloadContext.value.link, true)
  }
  pendingDownloadContext.value = null
}

// 取消下载
function cancelDownload() {
  duplicateCheckOpen.value = false
  pendingDownloadContext.value = null
}

// 复制下载链接到剪贴板
async function copyDownloadLink(url: string) {
  try {
    await navigator.clipboard.writeText(url)
    toast.success('下载链接已复制到剪贴板')
  } catch (e) {
    toast.error('复制失败: ' + String(e))
  }
}

// 暴露给父组件的方法
defineExpose({
  autoSearch: (newCode: string) => {
    code.value = newCode
    // 使用 setTimeout 确保视图更新后再执行搜索
    setTimeout(() => {
      if (canStart.value) startFinding()
    }, 100)
  }
})

onMounted(async () => {
  try { sites.value = await getVideoSites() } catch { /* 忽略 */ }
})

onUnmounted(() => {
  if (unlisten) { unlisten(); unlisten = null }
  if (unlistenCf) { unlistenCf(); unlistenCf = null }
  cfChallengeActive.value = false
  closeVideoFinder().catch(() => { /* 忽略 */ })
})
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- 输入区域 -->
    <div class="flex items-center gap-2 border-b p-4">
      <Input v-model="code" placeholder="输入番号，如 ABC-123（需要科学上网）" class="max-w-xs" :disabled="scanning"
        @keydown="handleKeydown" />
      <Button v-if="!scanning" :disabled="!canStart" size="sm" @click="startFinding">
        <Search class="mr-2 size-4" />
        查找链接
      </Button>
      <Button v-else variant="outline" size="sm" @click="stopFinding">
        <X class="mr-2 size-4" />
        停止
      </Button>

      <!-- 网站选择 -->
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="outline" size="sm" class="gap-1.5">
            <Globe class="size-3.5" />
            {{ selectedSiteName }}
            <ChevronDown class="size-3.5 opacity-50" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" class="w-48">
          <DropdownMenuItem v-for="(site, index) in sites" :key="site.id"
            :class="selectedSiteId === site.id ? 'bg-accent' : ''"
            @click="scanning ? switchSite(site.id) : (selectedSiteId = site.id)">
            资源 {{ index + 1 }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <!-- 内容区域 -->
    <div class="flex-1 flex flex-col min-h-0 p-4 gap-3">
      <div
        v-if="cfChallengeActive"
        class="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900"
      >
        <Globe class="mt-0.5 size-4 shrink-0" />
        <div>
          当前页面触发了 Cloudflare 验证，辅助 WebView 已显示。请先在弹出的窗口中完成验证，链接捕获会自动继续。
        </div>
      </div>

      <!-- 扫描中，无结果 -->
      <div v-if="scanning && links.length === 0" class="flex flex-col items-center justify-center py-16 gap-3">
        <Loader2 class="size-8 animate-spin text-primary" />
        <span class="text-sm text-muted-foreground">{{ cfChallengeActive ? '等待 Cloudflare 验证完成...' : 'WebView 已打开，正在监听 HLS 链接...' }}</span>
        <span class="text-xs text-muted-foreground">{{ cfChallengeActive ? '请在弹出的窗口中完成验证后返回' : `正在访问 ${selectedSiteName}，请等待页面加载` }}</span>
      </div>

      <!-- 未开始 -->
      <div v-else-if="!scanning && links.length === 0"
        class="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
        <LinkIcon class="size-8 opacity-30" />
        <span class="text-sm">输入番号并点击查找，自动捕获 HLS 视频链接，需要科学上网</span>
        <span class="text-xs">已屏蔽 MP4 链接，仅显示 HLS 流</span>
      </div>

      <!-- 链接列表 -->
      <template v-if="links.length > 0">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <Badge variant="outline">
              已捕获 {{ links.length }} 个链接
              <Loader2 v-if="scanning" class="ml-1 size-3 animate-spin" />
            </Badge>
            <Badge v-if="hlsCount > 0" variant="default">
              <CheckCircle2 class="mr-1 size-3" />
              {{ hlsCount }} 个 HLS
            </Badge>
          </div>
          <div class="flex items-center gap-2">
            <Button variant="ghost" size="sm" @click="selectAll">全选</Button>
            <Button variant="ghost" size="sm" @click="selectNone">取消</Button>
          </div>
        </div>

        <ScrollArea class="flex-1 min-h-0 rounded-md border">
          <div class="p-2 space-y-1">
            <ContextMenu v-for="link in links" :key="link.url">
              <ContextMenuTrigger as-child>
                <div class="flex items-start gap-3 rounded-md p-2.5 hover:bg-muted/50 transition-colors cursor-pointer"
                  :class="selectedUrls.has(link.url) ? 'bg-primary/5 ring-1 ring-primary/20' : ''"
                  @click="toggleSelect(link.url)">
                  <Checkbox :model-value="selectedUrls.has(link.url)" class="mt-0.5" @click.stop
                    @update:model-value="toggleSelect(link.url)" />
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-1">
                      <Badge :variant="link.isHls ? 'default' : 'secondary'" class="text-[10px] uppercase">
                        {{ link.linkType }}
                      </Badge>
                      <Badge v-if="link.resolution" variant="outline" class="text-[10px]">
                        {{ link.resolution }}
                      </Badge>
                      <Badge v-if="link.isHls" variant="default" class="text-[10px] bg-green-600">
                        HLS ✓
                      </Badge>
                    </div>
                    <div class="font-mono text-xs text-muted-foreground break-all leading-relaxed">
                      {{ link.url }}
                    </div>
                  </div>
                  <div class="shrink-0 flex items-center gap-1 self-center pr-2">
                    <Button v-if="link.isHls" variant="ghost" size="icon" class="h-8 w-8" title="预览播放"
                      @click.stop="handlePreview(link)">
                      <Play class="size-4" />
                    </Button>
                    <Button variant="ghost" size="icon" class="h-8 w-8" title="下载资源"
                      @click.stop="handleDownloadSingle(link)">
                      <Download class="size-4" />
                    </Button>
                  </div>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent class="w-40">
                <ContextMenuItem @click="handlePreview(link)">
                  <Play class="mr-2 size-4" />
                  <span>播放</span>
                </ContextMenuItem>
                <ContextMenuItem @click="handleDownloadSingle(link)">
                  <Download class="mr-2 size-4" />
                  <span>下载</span>
                </ContextMenuItem>
                <ContextMenuItem @click="() => copyDownloadLink(link.url)">
                  <LinkIcon class="mr-2 size-4" />
                  <span>复制下载链接</span>
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </div>
        </ScrollArea>

        <!-- 保存路径和下载 -->
        <div class="flex items-center gap-2 mt-auto pt-2 border-t">
          <input v-model="savePath" readonly placeholder="选择保存目录"
            class="flex-1 h-9 rounded-md border border-input bg-transparent px-3 text-sm" />
          <Button variant="outline" size="sm" class="h-9" @click="handleSelectPath">
            <FolderOpen class="size-4" />
          </Button>
          <Button :disabled="selectedUrls.size === 0 || !savePath || adding" size="sm" class="h-9"
            @click="() => handleAddTasks(false)">
            <Loader2 v-if="adding" class="mr-2 size-4 animate-spin" />
            <Download v-else class="mr-2 size-4" />
            添加 {{ selectedUrls.size }} 个任务
          </Button>
        </div>
      </template>
    </div>

    <!-- 重复提醒弹窗 -->
    <Dialog :open="duplicateCheckOpen" @update:open="(v) => !v && cancelDownload()">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>检测到已存视频</DialogTitle>
          <DialogDescription>
            该番号的视频 <strong>{{ code.trim().toUpperCase() }}</strong> 已存在于媒体库中。
          </DialogDescription>
        </DialogHeader>
        <div v-if="duplicateVideoInfo" class="space-y-4 py-4 text-sm text-muted-foreground break-all">
          <div>标题：<span class="text-foreground">{{ duplicateVideoInfo.title || '未知' }}</span></div>
          <div>目录：<span class="text-foreground">{{ duplicateVideoInfo.videoPath }}</span></div>
        </div>
        <DialogFooter class="flex sm:justify-end gap-2 text-right">
          <Button type="button" variant="secondary" @click="cancelDownload">取消添加</Button>
          <Button type="button" variant="destructive" @click="forceDownload">忽略并强制下载</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
