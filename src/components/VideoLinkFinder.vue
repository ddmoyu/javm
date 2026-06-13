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
  X,
  ChevronDown,
  Globe,
  Search,
  Play,
} from 'lucide-vue-next'
import {
  findVideoLinks,
  closeVideoFinder,
  getVideoSites,
  openVideoPlayerWindow,
  type VideoLink,
  type VideoSite,
  checkVideoExists,
  type VideoExistCheckResult
} from '@/lib/tauri'
import { getDefaultDownloadPath, analyzeHls } from '@/lib/tauri'
import { useDownloadStore, useSettingsStore } from '@/stores'
import { toast } from 'vue-sonner'

// 状态
const downloadStore = useDownloadStore()
const settingsStore = useSettingsStore()
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

// 开发者模式显示真实站点名，否则一律用代号「资源 N」，不暴露真实网站名
const isDeveloperMode = import.meta.env.DEV

// 当前选中网站名称
const selectedSiteName = computed(() => {
  const index = sites.value.findIndex(s => s.id === selectedSiteId.value)
  if (index === -1) return '资源 1'
  return isDeveloperMode ? (sites.value[index].name || sites.value[index].id) : `资源 ${index + 1}`
})

// 可直接预览的 HLS 链接数量
const hlsCount = computed(() => links.value.filter(l => l.isHls).length)

// 能否开始查找
const canStart = computed(() => code.value.trim().length > 0 && !scanning.value)

// 处理捕获到的链接。
// 这里只做最小过滤，具体能否下载交给 N_m3u8DL-RE 自己判断。
async function handleCapturedUrl(url: string) {
  if (seenUrls.has(url)) return
  seenUrls.add(url)

  const lowerUrlPath = url.split('?')[0].toLowerCase()
  const hasPlaylistLikeSuffix = lowerUrlPath.endsWith('.m3u8') || lowerUrlPath.endsWith('.txt')

  // 屏蔽 mp4 链接
  if (lowerUrlPath.endsWith('.mp4')) return
  // 过滤 .ts 片段
  if (lowerUrlPath.endsWith('.ts')) return

  let resolution: string | null = url.match(/(?:2160p|1080p|720p|480p|360p|4k)/i)?.[0]?.toLowerCase() ?? null
  const isHls = hasPlaylistLikeSuffix
  const linkType = hasPlaylistLikeSuffix ? 'm3u8' : 'auto'
  const link: VideoLink = { url, linkType, isHls, resolution }
  links.value = [...links.value, link]

  // 获取一个就解析一个：抓取 m3u8 求时长/分辨率，用于识别真实正片
  if (isHls) {
    void analyzeLink(url)
  }
}

// 以不可变方式更新某条链接（替换数组元素才能可靠触发 Vue 更新）
function patchLink(url: string, patch: Partial<VideoLink>) {
  links.value = links.value.map(l => (l.url === url ? { ...l, ...patch } : l))
}

/** 分析单个 HLS 链接，写回时长/分辨率 */
async function analyzeLink(url: string) {
  patchLink(url, { analyzing: true })
  try {
    const info = await analyzeHls(url)
    patchLink(url, {
      durationSecs: info.durationSecs,
      width: info.width,
      height: info.height,
      isMaster: info.isMaster,
      isVod: info.isVod,
      analyzed: true,
      analyzing: false,
    })
  } catch {
    // 分析失败：清除"分析中"，保留链接供手动选择
    patchLink(url, { analyzing: false, analyzed: true })
  }
}

// 列表排序：识别出的正片排最前，其余按分辨率高、时长长在前
const sortedLinks = computed(() => {
  const real = realLink.value
  return [...links.value].sort((a, b) => {
    if (real) {
      if (a.url === real.url) return -1
      if (b.url === real.url) return 1
    }
    const hDiff = (b.height ?? 0) - (a.height ?? 0)
    if (hDiff !== 0) return hDiff
    return (b.durationSecs ?? 0) - (a.durationSecs ?? 0)
  })
})

// 真实正片：时长最长（≥5 分钟）的那一条；同片多清晰度时优先主列表、再高分辨率
const realLink = computed(() => {
  const analyzed = links.value.filter(l => (l.durationSecs ?? 0) > 0)
  if (!analyzed.length) return null
  const maxDur = Math.max(...analyzed.map(l => l.durationSecs ?? 0))
  if (maxDur < 300) return null
  const candidates = analyzed.filter(l => (l.durationSecs ?? 0) >= maxDur * 0.9)
  candidates.sort((a, b) => {
    if (!!b.isMaster !== !!a.isMaster) return (b.isMaster ? 1 : 0) - (a.isMaster ? 1 : 0)
    const hDiff = (b.height ?? 0) - (a.height ?? 0)
    if (hDiff !== 0) return hDiff
    return (b.durationSecs ?? 0) - (a.durationSecs ?? 0)
  })
  return candidates[0] ?? null
})

function formatDuration(secs?: number): string {
  if (!secs || secs <= 0) return ''
  const s = Math.round(secs)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`
}

function formatRes(link: VideoLink): string {
  if (link.height && link.height > 0) return `${link.height}p`
  return link.resolution ?? ''
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

  // 下载路径直接使用下载设置中的默认保存路径
  await resolveSavePath()

  // 监听事件
  try {
    unlisten = await listen<string>('video-finder-link', (event) => {
      handleCapturedUrl(event.payload)
    })

    unlistenCf = await listen<{ status: 'idle' | 'active' | 'passed' | 'timeout' | 'failed'; active: boolean }>('video-finder-cf-state', (event) => {
      const payload = event.payload
      if (!payload) return

      cfChallengeActive.value = Boolean(payload.active)
      if (payload.status === 'active') {
        if (settingsStore.settings.scrape.webviewFallbackEnabled) {
          toast.info('触发 Cloudflare 验证，请在弹出的 WebView 中完成验证')
        } else {
          toast.warning('该站点触发了 Cloudflare 验证，但"HTTP 失败回退 WebView"已关闭，未弹出验证窗口')
        }
      } else if (payload.status === 'passed') {
        toast.success('Cloudflare 验证已通过，继续监听视频链接')
      } else if (payload.status === 'timeout') {
        toast.error('Cloudflare 验证超时，已停止监听视频链接')
      } else if (payload.status === 'failed') {
        toast.error('Cloudflare 验证失败，视频链接监听未完成')
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

// 选择资源站点（统一入口）：持久化选择，并按是否正在扫描决定是否立即切换
function pickSite(siteId: string) {
  persistSelectedSite(siteId)
  if (scanning.value) {
    switchSite(siteId)
  } else {
    selectedSiteId.value = siteId
  }
}

// 持久化资源站点选择，使软件重启后保留上次选择
async function persistSelectedSite(siteId: string) {
  if (settingsStore.settings.scrape.linkFinderSite === siteId) return
  try {
    await settingsStore.updateSettings({
      scrape: { ...settingsStore.settings.scrape, linkFinderSite: siteId },
    })
  } catch (e) {
    console.error('保存资源站点选择失败:', e)
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

// 下载路径直接取自下载设置；未配置时回退到系统默认下载目录
async function resolveSavePath() {
  const configured = settingsStore.settings.download.savePath
  if (configured) {
    savePath.value = configured
    return
  }
  try {
    savePath.value = await getDefaultDownloadPath()
  } catch { /* 忽略 */ }
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
      await downloadStore.addTask(url, savePath.value, filename, selectedSiteId.value)
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
    toast.error('未设置默认下载路径，请在系统设置 - 下载设置中配置')
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
    await downloadStore.addTask(link.url, savePath.value, filename, selectedSiteId.value)
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
  // 恢复上次选择的资源站点（设置已在应用启动时加载）
  const saved = settingsStore.settings.scrape.linkFinderSite
  if (saved) selectedSiteId.value = saved
  // 预先解析下载路径，直接使用下载设置中的默认保存路径
  await resolveSavePath()
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
            @click="pickSite(site.id)">
            {{ isDeveloperMode ? (site.name || site.id) : `资源 ${index + 1}` }}
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
        <div v-if="settingsStore.settings.scrape.webviewFallbackEnabled">
          当前页面触发了 Cloudflare 验证，辅助 WebView 已显示。请先在弹出的窗口中完成验证，链接捕获会自动继续。
        </div>
        <div v-else>
          当前页面触发了 Cloudflare 验证，但"HTTP 失败回退 WebView"开关已关闭，未弹出验证窗口，可能无法获取该站点链接。如需手动验证，请在设置中开启该开关。
        </div>
      </div>

      <!-- 扫描中，无结果 -->
      <div v-if="scanning && links.length === 0" class="flex flex-col items-center justify-center py-16 gap-3">
        <Loader2 class="size-8 animate-spin text-primary" />
        <span class="text-sm text-muted-foreground">{{ cfChallengeActive ? '等待 Cloudflare 验证完成...' : 'WebView 已打开，正在监听 HLS 链接...' }}</span>
        <span class="text-xs text-muted-foreground">{{ cfChallengeActive ? (settingsStore.settings.scrape.webviewFallbackEnabled ? '请在弹出的窗口中完成验证后返回' : '验证弹窗已关闭，可能无法获取该站点链接') : `正在访问 ${selectedSiteName}，请等待页面加载` }}</span>
      </div>

      <!-- 未开始 -->
      <div v-else-if="!scanning && links.length === 0"
        class="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
        <LinkIcon class="size-8 opacity-30" />
        <span class="text-sm">输入番号并点击查找，自动捕获候选下载链接，需要科学上网</span>
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
                {{ hlsCount }} 个可预览 HLS
            </Badge>
          </div>
          <div class="flex items-center gap-2">
            <Button variant="ghost" size="sm" @click="selectAll">全选</Button>
            <Button variant="ghost" size="sm" @click="selectNone">取消</Button>
          </div>
        </div>

        <ScrollArea class="flex-1 min-h-0 rounded-md border">
          <div class="p-2 space-y-1">
            <ContextMenu v-for="link in sortedLinks" :key="link.url">
              <ContextMenuTrigger as-child>
                <div class="flex items-start gap-3 rounded-md p-2.5 hover:bg-muted/50 transition-colors cursor-pointer"
                  :class="[
                    link.url === realLink?.url ? 'ring-2 ring-green-500/70 bg-green-500/5' : (selectedUrls.has(link.url) ? 'bg-primary/5 ring-1 ring-primary/20' : '')
                  ]"
                  @click="toggleSelect(link.url)">
                  <Checkbox :model-value="selectedUrls.has(link.url)" class="mt-0.5" @click.stop
                    @update:model-value="toggleSelect(link.url)" />
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-1 flex-wrap">
                      <Badge :variant="link.isHls ? 'default' : 'secondary'" class="text-[10px] uppercase">
                        {{ link.linkType }}
                      </Badge>
                      <Badge v-if="formatRes(link)" variant="outline" class="text-[10px]">
                        {{ formatRes(link) }}
                      </Badge>
                      <Badge v-if="link.analyzing" variant="outline" class="text-[10px]">分析中…</Badge>
                      <Badge v-else-if="link.durationSecs" variant="outline" class="text-[10px] tabular-nums">
                        {{ formatDuration(link.durationSecs) }}
                      </Badge>
                      <Badge v-if="link.url === realLink?.url" class="text-[10px] bg-green-600">正片</Badge>
                      <Badge v-else-if="link.analyzed && link.durationSecs && link.durationSecs < 120"
                        variant="secondary" class="text-[10px]">广告/片段</Badge>
                      <Badge v-if="link.isHls && link.url !== realLink?.url" variant="default" class="text-[10px] bg-green-600">
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
                <ContextMenuItem :disabled="!link.isHls" @click="handlePreview(link)">
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

        <!-- 保存路径（使用下载设置中的默认路径）和下载 -->
        <div class="flex items-center gap-2 mt-auto pt-2 border-t">
          <div class="flex-1 min-w-0 truncate text-xs text-muted-foreground">
            保存到：{{ savePath || '未设置默认下载路径，请在系统设置 - 下载设置中配置' }}
          </div>
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
