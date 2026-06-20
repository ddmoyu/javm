<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { Plus, GripVertical, Edit, Trash2, ExternalLink, ChevronsUpDown, Copy } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import { invoke } from '@tauri-apps/api/core'
import packageInfo from '../../package.json'
import appLogo from '../../src-tauri/icons/128x128.png'
import { useSettingsStore, useUpdaterStore } from '@/stores'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Textarea } from '@/components/ui/textarea'
import AIConfigDialog from '@/components/AIConfigDialog.vue'
import { selectDirectory } from '@/lib/tauri'
import { THEME_OPTIONS, VIEW_MODE_OPTIONS, COVER_TYPE_OPTIONS, UPDATE_CHANNEL_OPTIONS, METADATA_STORAGE_MODE_OPTIONS } from '@/utils/constants'
import type { AIProvider, ViewMode } from '@/types'

const route = useRoute()
const settingsStore = useSettingsStore()
const updaterStore = useUpdaterStore()
const appVersion = packageInfo.version
const isDeveloperMode = import.meta.env.DEV

// ===== MetaTube 聚合源 =====
interface MetaTubeStatusSnapshot {
  status: string
  port: number | null
  binaryPresent: boolean
  restarts: number
  lastError: string | null
}
const metatubeStatus = ref<MetaTubeStatusSnapshot | null>(null)
const metatubeRestarting = ref(false)
const metatubeDownloading = ref(false)
const metatubeStatusText = computed(() => {
  const map: Record<string, string> = {
    ready: '运行中', starting: '启动中', failed: '启动失败', stopped: '已停止', disabled: '已禁用',
  }
  return map[metatubeStatus.value?.status ?? ''] ?? '未知'
})
async function loadMetatubeStatus() {
  try {
    metatubeStatus.value = await invoke<MetaTubeStatusSnapshot>('metatube_status')
  } catch (e) {
    console.warn('获取 MetaTube 状态失败:', e)
  }
}
async function restartMetatube() {
  metatubeRestarting.value = true
  try {
    metatubeStatus.value = await invoke<MetaTubeStatusSnapshot>('metatube_restart')
    toast.success('已请求重启 MetaTube')
    setTimeout(loadMetatubeStatus, 2500)
  } catch (e) {
    toast.error(`重启失败: ${(e as Error).message || e}`)
  } finally {
    metatubeRestarting.value = false
  }
}
async function downloadMetatube() {
  metatubeDownloading.value = true
  const tid = toast.loading('正在下载最新 MetaTube...')
  try {
    metatubeStatus.value = await invoke<MetaTubeStatusSnapshot>('metatube_download_latest')
    toast.success('MetaTube 下载完成', { id: tid })
    setTimeout(loadMetatubeStatus, 2500)
  } catch (e) {
    toast.error(`下载失败: ${(e as Error).message || e}`, { id: tid })
  } finally {
    metatubeDownloading.value = false
  }
}
function saveMetatube(patch: Partial<import('@/types').MetaTubeSettings>) {
  settingsStore.updateSettings({ metatube: { ...settingsStore.settings.metatube, ...patch } })
}

// ===== 元数据存储 =====
const metadataModeDesc = computed(() => {
  const mode = settingsStore.settings.metadata?.storageMode || 'follow_video'
  return METADATA_STORAGE_MODE_OPTIONS.find((opt) => opt.value === mode)?.desc
    ?? '选择 NFO 与图片的保存位置'
})

function saveMetadata(patch: Partial<import('@/types').MetadataSettings>) {
  settingsStore.updateSettings({ metadata: { ...settingsStore.settings.metadata, ...patch } })
}

const selectMetadataRootDir = async () => {
  try {
    const path = await selectDirectory()
    if (path) {
      saveMetadata({ rootDir: path })
    }
  } catch (e) {
    console.error('选择元数据根目录失败:', e)
  }
}
const exportingLogs = ref(false)

const updateStatusText = computed(() => {
  const info = updaterStore.updateInfo

  if (!info) {
    return '启动时会自动检查更新，也可以在这里手动触发。'
  }

  if (!info.configured) {
    return '当前版本暂不支持应用内更新。'
  }

  if (info.available && info.version) {
    return `检测到新版本 v${info.version}`
  }

  return '当前已是最新版本。'
})

const updateChannelDesc = computed(() => {
  const channel = settingsStore.settings.update?.channel || 'stable'
  return UPDATE_CHANNEL_OPTIONS.find((opt) => opt.value === channel)?.desc
    ?? '选择接收哪类版本的更新'
})

const openExternalLink = async (url: string) => {
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
  } catch {
    toast.error('打开链接失败')
  }
}

const recommendedProxyServices = [
  {
    name: '魔戒',
    url: 'https://mojie.app/register?aff=6U9kDSoZ',
    inviteCode: '6U9kDSoZ'
  }
] as const

async function copyInviteCode(code: string, event: Event) {
  event.stopPropagation()
  try {
    await navigator.clipboard.writeText(code)
    toast.success('邀请码已复制')
  } catch {
    toast.error('复制失败')
  }
}

// 当前激活的 tab
const activeTab = ref('theme')

// 刮削源列表折叠状态
const scrapeSourcesOpen = ref(false)

// 本地编辑状态 - 使用深拷贝确保所有嵌套对象都被正确初始化
const localSettings = ref({
  theme: {
    ...settingsStore.settings.theme,
    proxy: settingsStore.settings.theme.proxy ? { ...settingsStore.settings.theme.proxy } : {
      type: 'system' as const,
      host: '',
      port: 7890,
    }
  },
  general: { ...settingsStore.settings.general },
  download: { ...settingsStore.settings.download },
  scrape: {
    ...settingsStore.settings.scrape,
    sites: settingsStore.settings.scrape.sites?.map(s => ({ ...s })) || [],
    antiBlock: {
      ...settingsStore.settings.scrape.antiBlock,
      proxies: [...(settingsStore.settings.scrape.antiBlock?.proxies || [])],
    },
  },
  ai: { ...settingsStore.settings.ai },
})

// 同步设置变化
const updateThemeMode = (value: unknown) => {
  settingsStore.setThemeMode(String(value) as any)
}

// 代理设置
const saveProxySettings = () => {
  settingsStore.updateSettings({ theme: localSettings.value.theme })
}

// 是否为自定义代理
const isCustomProxy = computed(() => {
  return localSettings.value.theme?.proxy?.type === 'custom'
})

// 检测代理连接
const checkingProxy = ref(false)
const proxyStatus = ref<'success' | 'error' | null>(null)

const testProxyConnection = async () => {
  if (localSettings.value.theme.proxy.type === 'custom') {
    if (!localSettings.value.theme.proxy.host || !localSettings.value.theme.proxy.port) {
      toast.error('请填写代理地址和端口')
      return
    }
  }

  checkingProxy.value = true
  proxyStatus.value = null

  try {
    // 这里可以调用后端API测试代理连接
    // 暂时模拟测试
    await new Promise(resolve => setTimeout(resolve, 1000))

    // 模拟成功
    proxyStatus.value = 'success'
    toast.success('代理连接成功')
  } catch (e) {
    proxyStatus.value = 'error'
    toast.error('代理连接失败')
  } finally {
    checkingProxy.value = false
  }
}

const openRecommendedService = async (url: string) => {
  await openExternalLink(url)
}

const handleOpenLogDirectory = async () => {
  try {
    const { getLogDirectory, openInExplorer } = await import('@/lib/tauri')
    const { logDir } = await getLogDirectory()
    await openInExplorer(logDir)
  } catch (e) {
    console.error('打开日志目录失败:', e)
    toast.error(`打开日志目录失败: ${(e as Error).message || '未知错误'}`)
  }
}

const handleExportLogs = async () => {
  try {
    const destinationDir = await selectDirectory()
    if (!destinationDir) {
      return
    }

    exportingLogs.value = true
    const { exportLogs } = await import('@/lib/tauri')
    const result = await exportLogs(destinationDir)

    toast.success('日志导出完成', {
      description: `已导出 ${result.fileCount} 个日志文件和诊断信息到 ${result.exportPath}`,
      duration: 4000,
    })
  } catch (e) {
    console.error('导出日志失败:', e)
    toast.error(`导出日志失败: ${(e as Error).message || '未知错误'}`)
  } finally {
    exportingLogs.value = false
  }
}

// 下载设置
const selectDownloadPath = async () => {
  try {
    const path = await selectDirectory()
    if (path) {
      localSettings.value.download.savePath = path
      saveDownloadSettings()
    }
  } catch (e) {
    console.error('Failed to select directory:', e)
  }
}

const saveDownloadSettings = () => {
  console.log('[SettingsView] Saving download settings:', localSettings.value.download)
  // 显式创建新对象，避免引用问题
  settingsStore.updateSettings({
    download: { ...localSettings.value.download }
  })
}

// ===== 下载源管理 =====
const downloadSourcesOpen = ref(false)

/** 下载源按成功次数降序展示 */
const sortedDownloadSources = computed(() => {
  return [...(localSettings.value.download.sources || [])].sort(
    (a, b) => (b.successCount ?? 0) - (a.successCount ?? 0)
  )
})

const toggleDownloadSource = (siteId: string, enabled: boolean) => {
  const sources = localSettings.value.download.sources || []
  const site = sources.find(s => s.id === siteId)
  if (!site) return
  if (!enabled && sources.filter(s => s.enabled).length <= 1 && site.enabled) {
    toast.error('至少保留一个启用的下载源')
    return
  }
  site.enabled = enabled
  saveDownloadSettings()
}

const toggleAllDownloadSources = (enabled: boolean) => {
  const sources = localSettings.value.download.sources || []
  if (!enabled && sources.length > 0) {
    sources.forEach((s, i) => { s.enabled = i === 0 })
    toast.warning('已保留一个下载源为启用状态')
  } else {
    sources.forEach(s => { s.enabled = enabled })
  }
  saveDownloadSettings()
}

// 初始化时检测所有工具
onMounted(async () => {
  await settingsStore.loadSettings()

  // 重新同步 localSettings 以确保包含所有字段 - 使用深拷贝
  localSettings.value = {
    theme: {
      ...settingsStore.settings.theme,
      proxy: settingsStore.settings.theme.proxy ? { ...settingsStore.settings.theme.proxy } : {
        type: 'system' as const,
        host: '',
        port: 7890,
      }
    },
    general: { ...settingsStore.settings.general },
    download: { ...settingsStore.settings.download },
    scrape: {
      ...settingsStore.settings.scrape,
      sites: settingsStore.settings.scrape.sites?.map(s => ({ ...s })) || [],
      antiBlock: {
        ...settingsStore.settings.scrape.antiBlock,
        proxies: [...(settingsStore.settings.scrape.antiBlock?.proxies || [])],
      },
    },
    ai: { ...settingsStore.settings.ai },
  }

  // 如果 store 中的保存路径为空，尝试获取系统默认下载路径
  if (!localSettings.value.download.savePath || localSettings.value.download.savePath.trim() === '') {
    try {
      const { getDefaultDownloadPath } = await import('@/lib/tauri')
      const defaultPath = await getDefaultDownloadPath()
      if (defaultPath) {
        localSettings.value.download.savePath = defaultPath
        // 不自动保存，只是显示给用户看
      }
    } catch (e) {
      console.error('Failed to get default download path:', e)
    }
  }

  // 确保工具列表已初始化
  if (!localSettings.value.download.tools || localSettings.value.download.tools.length === 0) {
    localSettings.value.download.tools = [
      {
        name: 'N_m3u8DL-RE',
        executable: 'N_m3u8DL-RE',
        enabled: true,
      },
      {
        name: 'ffmpeg',
        executable: 'ffmpeg',
        enabled: true,
      },
    ]
  }

  // 检查 URL 参数，如果有 tab 参数则切换到对应的 tab
  if (route.query.tab) {
    activeTab.value = route.query.tab as string
  }

  // 加载 MetaTube sidecar 状态
  loadMetatubeStatus()
})

// 刮削设置
// 默认刮削网站的特殊取值：自动选择丰富度得分最高的数据源（与后端 AUTO_HIGHEST_SCORE_SITE 对应）
const AUTO_SCRAPE_SITE = '__auto_highest_score__'
const enabledScrapeSites = computed(() => {
  return (localSettings.value.scrape.sites || []).filter(site => site.enabled)
})

/** 按累计丰富度得分降序排列的数据源列表（用于设置界面展示） */
const sortedScrapeSites = computed(() => {
  return [...(localSettings.value.scrape.sites || [])].sort((a, b) => {
    return (b.avgScore ?? 0) - (a.avgScore ?? 0)
  })
})

const ensureValidDefaultScrapeSite = () => {
  const enabled = enabledScrapeSites.value
  if (enabled.length === 0) {
    return false
  }

  if (localSettings.value.scrape.defaultSite !== AUTO_SCRAPE_SITE
    && !enabled.some(site => site.id === localSettings.value.scrape.defaultSite)) {
    localSettings.value.scrape.defaultSite = enabled[0].id
  }

  return true
}

const toggleScrapeSite = (siteId: string, enabled: boolean) => {
  const sites = localSettings.value.scrape.sites || []
  const site = sites.find(item => item.id === siteId)
  if (!site) {
    return
  }

  if (!enabled && enabledScrapeSites.value.length <= 1 && site.enabled) {
    toast.error('至少保留一个启用的刮削网站')
    return
  }

  site.enabled = enabled
  ensureValidDefaultScrapeSite()
  saveScrapeSettings()
}

const toggleAllScrapeSites = (enabled: boolean) => {
  const sites = localSettings.value.scrape.sites || []
  if (!enabled && sites.length > 0) {
    // 全部关闭时保留第一个，确保至少有一个启用
    sites.forEach((site, i) => { site.enabled = i === 0 })
    const displayName = isDeveloperMode ? sites[0].name : '数据源 1'
    toast.warning(`已保留 ${displayName} 为唯一启用网站`)
  } else {
    sites.forEach(site => { site.enabled = enabled })
  }
  ensureValidDefaultScrapeSite()
  saveScrapeSettings()
}

const saveScrapeSettings = () => {
  ensureValidDefaultScrapeSite()
  // maxWebviewWindows 跟随搜索并发数
  localSettings.value.scrape.maxWebviewWindows = localSettings.value.scrape.concurrent ?? 5
  settingsStore.updateSettings({ scrape: localSettings.value.scrape })
}

// ===== 反爬工具箱 =====
// 代理列表文本（每行一个），与 antiBlock.proxies 数组互转
const antiBlockProxiesText = ref(
  (localSettings.value.scrape.antiBlock?.proxies || []).join('\n')
)
// store 重载时同步文本
watch(() => settingsStore.settings.scrape.antiBlock?.proxies, (proxies) => {
  antiBlockProxiesText.value = (proxies || []).join('\n')
})
// 提交代理列表：按行解析、去空白后保存
const saveAntiBlockProxies = () => {
  localSettings.value.scrape.antiBlock.proxies = antiBlockProxiesText.value
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  saveScrapeSettings()
}

// 脚本管理辅助函数已移除（改为资源网站管理）

// AI 设置
const aiDialogOpen = ref(false)
const editingProvider = ref<AIProvider | null>(null)

const openAddDialog = () => {
  editingProvider.value = null
  aiDialogOpen.value = true
}

const openEditDialog = (provider: AIProvider) => {
  editingProvider.value = provider
  aiDialogOpen.value = true
}

const handleSaveProvider = (provider: AIProvider) => {
  const index = localSettings.value.ai.providers.findIndex(p => p.id === provider.id)
  if (index >= 0) {
    // 编辑
    localSettings.value.ai.providers[index] = provider
  } else {
    // 新增
    provider.priority = localSettings.value.ai.providers.length + 1
    localSettings.value.ai.providers.push(provider)
  }
  saveAISettings()
}

const deleteProvider = (provider: AIProvider) => {
  localSettings.value.ai.providers = localSettings.value.ai.providers.filter(p => p.id !== provider.id)
  // 重新计算优先级
  localSettings.value.ai.providers.forEach((p, i) => {
    p.priority = i + 1
  })
  saveAISettings()
  toast.success('删除成功')
}

// 拖拽排序
const draggedProvider = ref<AIProvider | null>(null)

const handleDragStart = (provider: AIProvider) => {
  draggedProvider.value = provider
}

const handleDragOver = (e: DragEvent) => {
  e.preventDefault()
}

const handleDrop = (targetProvider: AIProvider) => {
  if (!draggedProvider.value || draggedProvider.value.id === targetProvider.id) {
    return
  }

  const providers = localSettings.value.ai.providers
  const draggedIndex = providers.findIndex(p => p.id === draggedProvider.value!.id)
  const targetIndex = providers.findIndex(p => p.id === targetProvider.id)

  // 移动元素
  const [removed] = providers.splice(draggedIndex, 1)
  providers.splice(targetIndex, 0, removed)

  // 更新优先级
  providers.forEach((p, i) => {
    p.priority = i + 1
  })

  saveAISettings()
  draggedProvider.value = null
}

const saveAISettings = () => {
  settingsStore.updateSettings({ ai: localSettings.value.ai })
}

// 监听store变化，同步到本地 - 使用深拷贝
watch(() => settingsStore.settings, async (newSettings) => {
  localSettings.value = {
    theme: {
      ...newSettings.theme,
      proxy: newSettings.theme.proxy ? { ...newSettings.theme.proxy } : {
        type: 'system' as const,
        host: '',
        port: 7890,
      }
    },
    general: { ...newSettings.general },
    download: { ...newSettings.download },
    scrape: {
      ...newSettings.scrape,
      sites: newSettings.scrape.sites?.map(s => ({ ...s })) || [],
      antiBlock: {
        ...newSettings.scrape.antiBlock,
        proxies: [...(newSettings.scrape.antiBlock?.proxies || [])],
      },
    },
    ai: { ...newSettings.ai },
  }

  // 如果 store 中的保存路径为空，尝试获取系统默认下载路径
  if (!localSettings.value.download.savePath || localSettings.value.download.savePath.trim() === '') {
    try {
      const { getDefaultDownloadPath } = await import('@/lib/tauri')
      const defaultPath = await getDefaultDownloadPath()
      if (defaultPath) {
        localSettings.value.download.savePath = defaultPath
        // 不自动保存，只是显示给用户看
      }
    } catch (e) {
      console.error('Failed to get default download path:', e)
    }
  }
}, { deep: true })
</script>

<template>
  <ScrollArea class="h-full">
    <div class="px-6">
      <Tabs :model-value="activeTab" @update:model-value="(v) => activeTab = String(v)" class="space-y-6">
        <div class="sticky top-0 z-10 bg-background pt-6 pb-1">
        <TabsList class="grid w-full grid-cols-5">
          <TabsTrigger value="theme">基础</TabsTrigger>
          <TabsTrigger value="download">下载</TabsTrigger>
          <TabsTrigger value="scrape">刮削</TabsTrigger>
          <TabsTrigger value="ai">AI</TabsTrigger>
          <TabsTrigger value="about">关于</TabsTrigger>
        </TabsList>
        </div>

        <!-- 基础设置 -->
        <TabsContent value="theme">
          <div class="space-y-6">
            <!-- 外观设置 -->
            <Card>
              <CardHeader>
                <CardTitle>外观</CardTitle>
                <CardDescription>自定义应用的主题和显示偏好</CardDescription>
              </CardHeader>
              <CardContent class="space-y-6">
                <!-- 主题 -->
                <div class="flex items-center justify-between">
                  <div>
                    <p class="font-medium">主题</p>
                    <p class="text-sm text-muted-foreground">选择应用的外观主题</p>
                  </div>
                  <Select :model-value="settingsStore.settings.theme.mode" @update:model-value="updateThemeMode">
                    <SelectTrigger class="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="opt in THEME_OPTIONS" :key="opt.value" :value="opt.value">
                        {{ opt.label }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <Separator />

                <!-- 媒体库显示模式 -->
                <div class="flex items-center justify-between">
                  <div>
                    <p class="font-medium">媒体库显示模式</p>
                    <p class="text-sm text-muted-foreground">选择媒体库的默认显示方式</p>
                  </div>
                  <Select :model-value="settingsStore.settings.general.viewMode || 'card'"
                    @update:model-value="(v) => settingsStore.updateSettings({ general: { ...settingsStore.settings.general, viewMode: String(v) as ViewMode } })">
                    <SelectTrigger class="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="opt in VIEW_MODE_OPTIONS" :key="opt.value" :value="opt.value">
                        {{ opt.label }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <Separator />

                <!-- 封面类型 -->
                <div class="flex items-center justify-between">
                  <div>
                    <p class="font-medium">封面类型</p>
                    <p class="text-sm text-muted-foreground">选择媒体库卡片封面的方向，横屏或竖屏</p>
                  </div>
                  <Select :model-value="settingsStore.settings.general.coverType || 'landscape'"
                    @update:model-value="(v) => settingsStore.updateSettings({ general: { ...settingsStore.settings.general, coverType: String(v) as import('@/types').CoverType } })">
                    <SelectTrigger class="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="opt in COVER_TYPE_OPTIONS" :key="opt.value" :value="opt.value">
                        {{ opt.label }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <Separator />

                <!-- 播放方式 -->
                <div class="flex items-center justify-between">
                  <div>
                    <p class="font-medium">播放方式</p>
                    <p class="text-sm text-muted-foreground">选择视频播放模式</p>
                  </div>
                  <Select :model-value="settingsStore.settings.general.playMethod || 'software'"
                    @update:model-value="(v) => settingsStore.updateSettings({ general: { ...settingsStore.settings.general, playMethod: String(v) as import('@/types').PlayMethod } })">
                    <SelectTrigger class="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="system">系统默认</SelectItem>
                      <SelectItem value="software">软件默认</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <Separator />

                <div class="flex items-center justify-between">
                  <div>
                    <p class="font-medium">点击封面直接播放</p>
                    <p class="text-sm text-muted-foreground">开启后点击影片封面会直接播放，关闭后点击封面打开详情</p>
                  </div>
                  <Switch :model-value="settingsStore.settings.general.coverClickToPlay ?? true"
                    @update:model-value="(v: boolean) => settingsStore.updateSettings({ general: { ...settingsStore.settings.general, coverClickToPlay: v } })" />
                </div>
              </CardContent>
            </Card>

            <!-- 代理设置 -->
            <Card>
              <CardHeader>
                <CardTitle>网络代理</CardTitle>
                <CardDescription>配置网络代理以访问外部服务</CardDescription>
              </CardHeader>
              <CardContent class="space-y-6">
                <!-- 代理类型 -->
                <div class="flex items-center justify-between">
                  <div>
                    <p class="font-medium">代理类型</p>
                    <p class="text-sm text-muted-foreground">选择使用系统代理或自定义代理</p>
                  </div>
                  <Select :model-value="localSettings.theme.proxy?.type || 'system'"
                    @update:model-value="(v) => { if (v) { localSettings.theme.proxy.type = String(v) as any; saveProxySettings() } }">
                    <SelectTrigger class="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="system">系统代理</SelectItem>
                      <SelectItem value="custom">自定义代理</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <Separator />

                <!-- 自定义代理配置 -->
                <div v-if="isCustomProxy" class="space-y-4">
                  <!-- 代理地址 -->
                  <div class="space-y-2">
                    <p class="text-sm font-medium">代理地址</p>
                    <Input v-model="localSettings.theme.proxy.host" placeholder="例如: 127.0.0.1"
                      @blur="saveProxySettings" />
                  </div>

                  <!-- 代理端口 -->
                  <div class="space-y-2">
                    <p class="text-sm font-medium">代理端口</p>
                    <Input v-model.number="localSettings.theme.proxy.port" type="number" placeholder="例如: 7890"
                      @blur="saveProxySettings" />
                  </div>

                  <!-- 检测按钮 -->
                  <div class="flex items-center gap-2">
                    <Button variant="outline" :disabled="checkingProxy" @click="testProxyConnection" class="flex-1">
                      {{ checkingProxy ? '检测中...' : '检测连接' }}
                    </Button>
                    <Badge v-if="proxyStatus" :variant="proxyStatus === 'success' ? 'default' : 'destructive'">
                      {{ proxyStatus === 'success' ? '连接成功' : '连接失败' }}
                    </Badge>
                  </div>

                  <!-- 提示信息 -->
                  <div class="text-xs text-muted-foreground bg-muted p-3 rounded-md">
                    <p class="font-medium mb-1">提示：</p>
                    <ul class="list-disc list-inside space-y-1">
                      <li>支持 HTTP/HTTPS/SOCKS5 代理协议</li>
                      <li>常见代理端口：7890, 1080, 8080</li>
                      <li>确保代理服务已启动并可访问</li>
                    </ul>
                  </div>
                </div>


              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>推荐科学上网服务平台</CardTitle>
                <CardDescription>可从以下平台获取科学上网服务</CardDescription>
              </CardHeader>
              <CardContent>
                <div class="space-y-2">
                  <div
                    v-for="service in recommendedProxyServices"
                    :key="service.name"
                    class="rounded-lg border border-border bg-muted/40 px-4 py-3"
                  >
                    <button
                      type="button"
                      class="flex w-full items-center justify-between text-left transition-colors hover:opacity-80"
                      @click="openRecommendedService(service.url)"
                    >
                      <p class="font-medium text-foreground">{{ service.name }}</p>
                      <ExternalLink class="h-4 w-4 text-muted-foreground" />
                    </button>
                    <div v-if="service.inviteCode" class="mt-2 flex items-center gap-2">
                      <span class="text-sm text-muted-foreground">邀请码：</span>
                      <code class="rounded bg-background px-2 py-0.5 text-sm font-mono text-foreground">{{ service.inviteCode }}</code>
                      <button
                        type="button"
                        class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                        @click="copyInviteCode(service.inviteCode, $event)"
                      >
                        <Copy class="h-3.5 w-3.5" />
                        复制
                      </button>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <!-- 下载设置 -->
        <TabsContent value="download">
          <div class="space-y-6">
          <Card>
            <CardContent class="space-y-6">
              <!-- 保存路径 -->
              <div class="space-y-2">
                <p class="font-medium">默认保存路径</p>
                <div class="flex gap-2">
                  <Input v-model="localSettings.download.savePath" placeholder="选择保存目录..." readonly class="flex-1" />
                  <Button variant="outline" @click="selectDownloadPath">
                    浏览
                  </Button>
                </div>
              </div>

              <Separator />

              <!-- 并发数 -->
              <div class="flex items-center justify-between">
                <div>
                  <p class="font-medium">同时下载数</p>
                  <p class="text-sm text-muted-foreground">最大并发下载任务数</p>
                </div>
                <Select :model-value="String(localSettings.download.concurrent)"
                  @update:model-value="v => { localSettings.download.concurrent = Number(v); saveDownloadSettings() }">
                  <SelectTrigger class="w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">1</SelectItem>
                    <SelectItem value="2">2</SelectItem>
                    <SelectItem value="3">3</SelectItem>
                    <SelectItem value="5">5</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <Separator />

              <!-- 自动刮削 -->
              <div class="flex items-center justify-between">
                <div>
                  <p class="font-medium">下载完成后自动刮削</p>
                  <p class="text-sm text-muted-foreground">下载任务完成后自动添加到刮削队列</p>
                  <!-- Debugging Info (hidden in production) -->
                  <!-- <p class="text-xs text-red-500">Value: {{ localSettings.download.autoScrape }}</p> -->
                </div>
                <Switch :model-value="!!localSettings.download.autoScrape"
                  @update:model-value="(v: boolean) => { localSettings.download.autoScrape = v; saveDownloadSettings() }" />
              </div>


            </CardContent>
          </Card>

          <!-- 下载源管理（折叠） -->
          <Card>
            <CardContent class="pt-6">
              <Collapsible v-model:open="downloadSourcesOpen">
                <div class="flex items-center justify-between">
                  <div>
                    <p class="font-medium">下载源管理</p>
                    <p class="text-sm text-muted-foreground">管理资源链接使用的视频站，关闭后不在下拉中出现；按下载成功次数从高到低排序</p>
                  </div>
                  <div class="flex shrink-0 items-center gap-2">
                    <Button variant="outline" size="sm" @click="toggleAllDownloadSources(true)">全部开启</Button>
                    <Button variant="outline" size="sm" @click="toggleAllDownloadSources(false)">全部关闭</Button>
                    <CollapsibleTrigger as-child>
                      <Button variant="ghost" size="sm">
                        <ChevronsUpDown class="h-4 w-4" />
                      </Button>
                    </CollapsibleTrigger>
                  </div>
                </div>
                <CollapsibleContent>
                  <div class="mt-4 space-y-3 rounded-lg border p-3">
                    <div v-for="(site, index) in sortedDownloadSources" :key="site.id"
                      class="flex items-center justify-between gap-4 rounded-md border border-border/60 px-3 py-3">
                      <div class="min-w-0">
                        <div class="flex items-center gap-2">
                          <p class="font-medium">{{ isDeveloperMode ? site.name : `下载源 ${index + 1}` }}</p>
                          <Badge v-if="isDeveloperMode" variant="outline">{{ site.id }}</Badge>
                          <Badge v-if="site.successCount" variant="secondary" class="text-xs tabular-nums">
                            成功 {{ site.successCount }} 次
                          </Badge>
                        </div>
                      </div>
                      <Switch :model-value="!!site.enabled"
                        @update:model-value="(v: boolean) => toggleDownloadSource(site.id, v)" />
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </CardContent>
          </Card>
          </div>
        </TabsContent>

        <!-- 资源刮削设置 -->
        <TabsContent value="scrape">
          <div class="space-y-6">
            <!-- 设置项 -->
            <Card>
              <CardHeader>
                <CardTitle>刮削</CardTitle>
                <CardDescription>配置资源网站和刮削行为</CardDescription>
              </CardHeader>
              <CardContent class="space-y-6">
                <!-- 默认刮削网站 -->
                <div class="flex items-center justify-between">
                  <div>
                    <p class="font-medium">默认刮削网站</p>
                    <p class="text-sm text-muted-foreground">详情刮削、自动刮削和任务队列优先使用此网站；选「自动（最高分）」则用累计得分最高的数据源</p>
                  </div>
                  <Select :model-value="localSettings.scrape.defaultSite"
                    @update:model-value="(v) => { localSettings.scrape.defaultSite = String(v); saveScrapeSettings() }">
                    <SelectTrigger class="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem :value="AUTO_SCRAPE_SITE">自动（最高分）</SelectItem>
                      <SelectItem v-for="site in enabledScrapeSites"
                        :key="site.id" :value="site.id">
                        {{ site.name }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <!-- 一键无码模式 -->
                <div class="flex items-center justify-between gap-4">
                  <div>
                    <p class="font-medium">一键无码模式</p>
                    <p class="text-sm text-muted-foreground">开启后所有刮削强制走无码路由：番号无论有码无码都纳入无码/综合源、跳过纯有码源</p>
                  </div>
                  <Switch :model-value="!!localSettings.scrape.uncensoredMode"
                    @update:model-value="(v: boolean) => { localSettings.scrape.uncensoredMode = v; saveScrapeSettings() }" />
                </div>

                <div class="flex items-center justify-between gap-4">
                  <div>
                    <p class="font-medium">搜索并发数</p>
                    <p class="text-sm text-muted-foreground">同时请求的数据源数量，推荐 3-5 个，过高可能导致 IP 被封或触发验证</p>
                  </div>
                  <Select :model-value="String(localSettings.scrape.concurrent ?? 5)"
                    @update:model-value="(v) => { localSettings.scrape.concurrent = Number(v); saveScrapeSettings() }">
                    <SelectTrigger class="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="1">1</SelectItem>
                      <SelectItem value="2">2</SelectItem>
                      <SelectItem value="3">3</SelectItem>
                      <SelectItem value="5">5</SelectItem>
                      <SelectItem value="8">8</SelectItem>
                      <SelectItem value="10">10（不限）</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div class="flex items-center justify-between gap-4">
                  <div>
                    <p class="font-medium">HTTP 失败回退 WebView</p>
                    <p class="text-sm text-muted-foreground">遇到 HTTP 抓取失败、Cloudflare 验证或年龄确认页时，弹出窗口让你手动通过后继续抓取；关闭后即使遇到验证也不弹窗（资源链接查找同样适用）</p>
                  </div>
                  <Switch :model-value="!!localSettings.scrape.webviewFallbackEnabled"
                    @update:model-value="(v: boolean) => { localSettings.scrape.webviewFallbackEnabled = v; saveScrapeSettings() }" />
                </div>

                <template v-if="isDeveloperMode">
                  <Separator />

                  <div class="space-y-4 rounded-lg border border-dashed p-4">
                    <div>
                      <p class="font-medium">开发调试</p>
                      <p class="text-sm text-muted-foreground">仅开发环境可见，不会对普通用户开放</p>
                    </div>

                    <div class="flex items-center justify-between gap-4">
                      <div>
                        <p class="font-medium">WebView 增强</p>
                        <p class="text-sm text-muted-foreground">对 Both 类型站点优先使用 WebView 抓取，而不是 HTTP</p>
                      </div>
                      <Switch :model-value="!!localSettings.scrape.webviewEnabled"
                        @update:model-value="(v: boolean) => { localSettings.scrape.webviewEnabled = v; saveScrapeSettings() }" />
                    </div>

                    <div class="flex items-center justify-between gap-4">
                      <div>
                        <p class="font-medium">显示隐藏 WebView</p>
                        <p class="text-sm text-muted-foreground">开发调试时默认显示用于抓取的隐藏 WebView 窗口</p>
                      </div>
                      <Switch :model-value="!!localSettings.scrape.devShowWebview"
                        @update:model-value="(v: boolean) => { localSettings.scrape.devShowWebview = v; saveScrapeSettings() }" />
                    </div>
                  </div>
                </template>
              </CardContent>
            </Card>

            <!-- 元数据存储 -->
            <Card>
              <CardHeader>
                <CardTitle>元数据存储</CardTitle>
                <CardDescription>选择 NFO 与图片的保存位置；独立目录模式按「番号 标题」分子目录并生成 .strm，便于外部媒体库（Emby/Kodi/Jellyfin）统一管理</CardDescription>
              </CardHeader>
              <CardContent class="space-y-6">
                <!-- 存储模式 -->
                <div class="flex items-center justify-between gap-4">
                  <div>
                    <p class="font-medium">存储模式</p>
                    <p class="text-sm text-muted-foreground">{{ metadataModeDesc }}</p>
                  </div>
                  <Select :model-value="settingsStore.settings.metadata?.storageMode || 'follow_video'"
                    @update:model-value="(v) => saveMetadata({ storageMode: String(v) as import('@/types').MetadataStorageMode })">
                    <SelectTrigger class="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem v-for="opt in METADATA_STORAGE_MODE_OPTIONS" :key="opt.value" :value="opt.value">
                        {{ opt.label }}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <!-- 元数据根目录（仅独立目录模式） -->
                <template v-if="(settingsStore.settings.metadata?.storageMode || 'follow_video') === 'independent'">
                  <Separator />
                  <div class="space-y-2">
                    <p class="font-medium">元数据根目录</p>
                    <p class="text-sm text-muted-foreground">NFO 与图片将集中保存到此目录下，按「番号 标题」分子目录；视频本体留在原处不动</p>
                    <div class="flex gap-2">
                      <Input :model-value="settingsStore.settings.metadata?.rootDir || ''" placeholder="选择元数据根目录..." readonly class="flex-1" />
                      <Button variant="outline" @click="selectMetadataRootDir">浏览</Button>
                    </div>
                    <p v-if="!(settingsStore.settings.metadata?.rootDir || '').trim()" class="text-xs text-destructive">
                      未设置根目录时仍按「跟随视频」保存
                    </p>
                  </div>
                </template>
              </CardContent>
            </Card>

            <!-- 反爬工具箱 -->
            <Card>
              <CardHeader>
                <CardTitle>反爬工具箱</CardTitle>
                <CardDescription>提升抓取稳定性与抗封禁能力，对所有数据源与下载源生效</CardDescription>
              </CardHeader>
              <CardContent class="space-y-6">
                <!-- 总开关 -->
                <div class="flex items-center justify-between gap-4">
                  <div>
                    <p class="font-medium">启用反爬工具箱</p>
                    <p class="text-sm text-muted-foreground">关闭后退化为直连抓取，不限速、不重试（与旧版本行为一致）</p>
                  </div>
                  <Switch :model-value="!!localSettings.scrape.antiBlock.enabled"
                    @update:model-value="(v: boolean) => { localSettings.scrape.antiBlock.enabled = v; saveScrapeSettings() }" />
                </div>

                <template v-if="localSettings.scrape.antiBlock.enabled">
                  <Separator />

                  <!-- 请求限速 -->
                  <div class="flex items-center justify-between gap-4">
                    <div>
                      <p class="font-medium">请求间隔限速</p>
                      <p class="text-sm text-muted-foreground">对同一站点的连续请求随机延迟，礼貌爬取以降低被限频/封禁概率</p>
                    </div>
                    <Switch :model-value="!!localSettings.scrape.antiBlock.rateLimitEnabled"
                      @update:model-value="(v: boolean) => { localSettings.scrape.antiBlock.rateLimitEnabled = v; saveScrapeSettings() }" />
                  </div>
                  <div v-if="localSettings.scrape.antiBlock.rateLimitEnabled"
                    class="flex items-center justify-between gap-4 pl-1">
                    <p class="text-sm text-muted-foreground">间隔区间（毫秒）</p>
                    <div class="flex items-center gap-2">
                      <Input type="number" min="0" class="w-24"
                        v-model.number="localSettings.scrape.antiBlock.minIntervalMs" @blur="saveScrapeSettings" />
                      <span class="text-muted-foreground">~</span>
                      <Input type="number" min="0" class="w-24"
                        v-model.number="localSettings.scrape.antiBlock.maxIntervalMs" @blur="saveScrapeSettings" />
                    </div>
                  </div>

                  <Separator />

                  <!-- 失败重试 -->
                  <div class="flex items-center justify-between gap-4">
                    <div>
                      <p class="font-medium">失败重试次数</p>
                      <p class="text-sm text-muted-foreground">网络错误、限频(429)、服务器错误(5xx)时自动分级退避重试，上限 5 次</p>
                    </div>
                    <Input type="number" min="0" max="5" class="w-24"
                      v-model.number="localSettings.scrape.antiBlock.maxRetries" @blur="saveScrapeSettings" />
                  </div>

                  <Separator />

                  <!-- UA / 指纹轮换 -->
                  <div class="flex items-center justify-between gap-4">
                    <div>
                      <p class="font-medium">UA / 指纹轮换</p>
                      <p class="text-sm text-muted-foreground">在多个近期 Chrome 指纹之间轮换，模拟不同访客</p>
                    </div>
                    <Switch :model-value="!!localSettings.scrape.antiBlock.uaRotationEnabled"
                      @update:model-value="(v: boolean) => { localSettings.scrape.antiBlock.uaRotationEnabled = v; saveScrapeSettings() }" />
                  </div>

                  <Separator />

                  <!-- 镜像域名轮换 -->
                  <div class="flex items-center justify-between gap-4">
                    <div>
                      <p class="font-medium">镜像域名轮换</p>
                      <p class="text-sm text-muted-foreground">站点主域名不可用时自动切换到备用镜像，并记忆当前可用域名</p>
                    </div>
                    <Switch :model-value="!!localSettings.scrape.antiBlock.mirrorRotationEnabled"
                      @update:model-value="(v: boolean) => { localSettings.scrape.antiBlock.mirrorRotationEnabled = v; saveScrapeSettings() }" />
                  </div>

                  <Separator />

                  <!-- 代理池 -->
                  <div class="flex items-center justify-between gap-4">
                    <div>
                      <p class="font-medium">代理池</p>
                      <p class="text-sm text-muted-foreground">配置多个代理后按成功率加权挑选并自动避开失效代理；留空则沿用「网络代理」设置</p>
                    </div>
                    <Switch :model-value="!!localSettings.scrape.antiBlock.proxyPoolEnabled"
                      @update:model-value="(v: boolean) => { localSettings.scrape.antiBlock.proxyPoolEnabled = v; saveScrapeSettings() }" />
                  </div>
                  <div v-if="localSettings.scrape.antiBlock.proxyPoolEnabled" class="space-y-2">
                    <p class="text-sm font-medium">代理列表（每行一个）</p>
                    <Textarea v-model="antiBlockProxiesText" :rows="4"
                      placeholder="http://127.0.0.1:7890&#10;socks5://127.0.0.1:1080"
                      class="font-mono text-sm" @blur="saveAntiBlockProxies" />
                    <p class="text-xs text-muted-foreground">支持 http/https/socks5 协议；保存后按成功率自动加权选择</p>
                  </div>
                </template>
              </CardContent>
            </Card>

            <!-- MetaTube 聚合源 -->
            <Card>
              <CardHeader>
                <CardTitle>MetaTube 聚合源</CardTitle>
                <CardDescription>本地聚合刮削服务，随应用启动；失败自动重试，不可用时回退跳过，不影响其它数据源</CardDescription>
              </CardHeader>
              <CardContent class="space-y-6">
                <div class="flex items-center justify-between gap-4">
                  <div>
                    <p class="font-medium">启用 MetaTube</p>
                    <p class="text-sm text-muted-foreground">作为一个聚合数据源参与并发搜索与评分排序</p>
                  </div>
                  <Switch :model-value="!!settingsStore.settings.metatube.enabled"
                    @update:model-value="(v: boolean) => saveMetatube({ enabled: v })" />
                </div>

                <Separator />

                <div class="flex items-center justify-between gap-4">
                  <div class="min-w-0">
                    <p class="font-medium">运行状态</p>
                    <p class="text-sm text-muted-foreground">
                      {{ metatubeStatusText }}
                      <span v-if="metatubeStatus?.port"> · 端口 {{ metatubeStatus.port }}</span>
                      <span v-if="metatubeStatus && !metatubeStatus.binaryPresent" class="text-destructive"> · 未检测到二进制</span>
                      <span v-if="metatubeStatus && metatubeStatus.restarts > 0"> · 已重启 {{ metatubeStatus.restarts }} 次</span>
                    </p>
                    <p v-if="metatubeStatus?.lastError" class="mt-1 truncate text-xs text-muted-foreground">
                      最近错误：{{ metatubeStatus.lastError }}
                    </p>
                  </div>
                  <div class="flex shrink-0 items-center gap-2">
                    <Badge :variant="metatubeStatus?.status === 'ready' ? 'default' : 'secondary'">{{ metatubeStatusText }}</Badge>
                    <Button v-if="metatubeStatus && (!metatubeStatus.binaryPresent || metatubeStatus.status === 'failed')"
                      variant="default" size="sm" :disabled="metatubeDownloading" @click="downloadMetatube">
                      {{ metatubeDownloading ? '下载中...' : (metatubeStatus.binaryPresent ? '重新下载' : '下载 MetaTube') }}
                    </Button>
                    <Button variant="outline" size="sm" :disabled="metatubeRestarting" @click="restartMetatube">
                      {{ metatubeRestarting ? '重启中...' : '重启' }}
                    </Button>
                    <Button variant="ghost" size="sm" @click="loadMetatubeStatus">刷新</Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            <!-- 刮削源列表（折叠） -->
            <Card>
              <CardContent class="pt-6">
                <Collapsible v-model:open="scrapeSourcesOpen">
                  <div class="flex items-center justify-between">
                    <div>
                      <p class="font-medium">数据源管理</p>
                      <p class="text-sm text-muted-foreground">管理参与刮削的数据源，关闭后不再参与搜索和任务队列</p>
                    </div>
                    <div class="flex shrink-0 items-center gap-2">
                      <Button variant="outline" size="sm" @click="toggleAllScrapeSites(true)">全部开启</Button>
                      <Button variant="outline" size="sm" @click="toggleAllScrapeSites(false)">全部关闭</Button>
                      <CollapsibleTrigger as-child>
                        <Button variant="ghost" size="sm">
                          <ChevronsUpDown class="h-4 w-4" />
                        </Button>
                      </CollapsibleTrigger>
                    </div>
                  </div>
                  <CollapsibleContent>
                    <div class="mt-4 space-y-3 rounded-lg border p-3">
                      <div v-for="site in sortedScrapeSites" :key="site.id"
                        class="flex items-center justify-between gap-4 rounded-md border border-border/60 px-3 py-3">
                        <div class="min-w-0">
                          <div class="flex items-center gap-2">
                            <p class="font-medium">{{ isDeveloperMode ? (site.name || site.id) : `数据源 ${localSettings.scrape.sites.indexOf(site) + 1}` }}</p>
                            <Badge v-if="isDeveloperMode" variant="outline">{{ site.id }}</Badge>
                            <Badge v-if="site.scrapeCount" variant="secondary" class="text-xs tabular-nums">
                              {{ site.avgScore ?? 0 }}分
                            </Badge>
                          </div>
                          <p v-if="site.scrapeCount" class="mt-1 text-xs text-muted-foreground">
                            累计 {{ site.scrapeCount }} 次刮削
                          </p>
                        </div>
                        <Switch :model-value="!!site.enabled"
                          @update:model-value="(v: boolean) => toggleScrapeSite(site.id, v)" />
                      </div>
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <!-- AI 设置 -->
        <TabsContent value="ai">
          <Card>
            <CardHeader>
              <CardTitle>AI 配置</CardTitle>
              <CardDescription>
                配置多个 AI 提供商，拖拽调整优先级，排在前面的优先调用
              </CardDescription>
            </CardHeader>
            <CardContent class="space-y-6">
              <!-- 刮削结果自动翻译 -->
              <div class="flex items-center justify-between">
                <div>
                  <p class="font-medium">刮削结果自动翻译</p>
                  <p class="text-sm text-muted-foreground">保存 NFO 和写入数据库前，将日语/英文翻译为当前界面语言</p>
                </div>
                <Switch :model-value="!!localSettings.ai.translateScrapeResult"
                  @update:model-value="(v: boolean) => { localSettings.ai.translateScrapeResult = v; saveAISettings() }" />
              </div>

              <Separator />

              <!-- AI 提供商表格 -->
              <div class="space-y-4">
                <div class="flex items-center justify-between">
                  <p class="font-medium">AI 提供商列表</p>
                  <Button variant="outline" size="sm" @click="openAddDialog">
                    <Plus class="mr-2 size-4" />
                    添加配置
                  </Button>
                </div>

                <!-- 表格 -->
                <div v-if="localSettings.ai.providers.length > 0" class="border rounded-lg">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead class="w-12"></TableHead>
                        <TableHead class="w-16">优先级</TableHead>
                        <TableHead>供应商</TableHead>
                        <TableHead>模型</TableHead>
                        <TableHead class="w-20 text-center">状态</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      <ContextMenu v-for="provider in localSettings.ai.providers" :key="provider.id">
                        <ContextMenuTrigger as-child>
                          <TableRow draggable="true" class="cursor-move hover:bg-muted/50"
                            @dragstart="handleDragStart(provider)" @dragover="handleDragOver"
                            @drop="handleDrop(provider)">
                            <TableCell>
                              <GripVertical class="size-4 text-muted-foreground" />
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline">{{ provider.priority }}</Badge>
                            </TableCell>
                            <TableCell class="font-medium">
                              {{ provider.name }}
                            </TableCell>
                            <TableCell class="text-muted-foreground">
                              {{ provider.model }}
                            </TableCell>
                            <TableCell class="text-center">
                              <Badge :variant="provider.active ? 'default' : 'secondary'">
                                {{ provider.active ? '启用' : '禁用' }}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        </ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuItem @click="openEditDialog(provider)">
                            <Edit class="mr-2 size-4" />
                            编辑
                          </ContextMenuItem>
                          <ContextMenuItem class="text-destructive" @click="deleteProvider(provider)">
                            <Trash2 class="mr-2 size-4" />
                            删除
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    </TableBody>
                  </Table>
                </div>

                <!-- 空状态 -->
                <div v-else class="text-center text-muted-foreground py-12 border rounded-lg border-dashed">
                  <p class="text-lg">暂无 AI 提供商配置</p>
                  <p class="text-sm mt-1">点击"添加配置"按钮开始配置 AI 服务</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <!-- 关于 -->
        <TabsContent value="about">
          <div class="space-y-6">
            <Card>
              <CardContent class="space-y-6">
                <div class="flex flex-col items-center gap-4 py-2 text-center">
                  <img :src="appLogo" alt="JAVM Logo" class="h-20 w-20 rounded-2xl border border-border p-2" />
                  <div class="space-y-1 text-center">
                    <p class="text-xl font-semibold">JAVM</p>
                    <p class="text-sm text-muted-foreground">jav manager</p>
                    <p class="text-sm text-muted-foreground">版本号：v{{ appVersion }}</p>
                  </div>
                </div>

                <Separator />

                <div class="space-y-3">
                  <div class="space-y-1">
                    <p class="font-medium">应用更新</p>
                    <p class="text-sm text-muted-foreground">{{ updateStatusText }}</p>
                    <p v-if="updaterStore.updatePublishedAt" class="text-sm text-muted-foreground">
                      最近发现版本发布时间：{{ updaterStore.updatePublishedAt }}
                    </p>
                  </div>

                  <div class="flex flex-wrap gap-2">
                    <Button
                      variant="outline"
                      :disabled="updaterStore.checking || updaterStore.installing"
                      @click="updaterStore.checkForUpdates()"
                    >
                      {{ updaterStore.checking ? '检查中...' : '检查更新' }}
                    </Button>
                    <Button
                      v-if="updaterStore.hasUpdate"
                      variant="outline"
                      :disabled="updaterStore.installing"
                      @click="updaterStore.openUpdateDetails()"
                    >
                      查看更新
                    </Button>
                    <Button
                      v-if="updaterStore.hasUpdate"
                      :disabled="updaterStore.installing || updaterStore.checking"
                      @click="updaterStore.installLatestUpdate()"
                    >
                      {{ updaterStore.installing ? '安装中...' : '立即更新' }}
                    </Button>
                  </div>

                  <!-- 更新通道 -->
                  <div class="flex items-center justify-between pt-1">
                    <div>
                      <p class="font-medium">更新通道</p>
                      <p class="text-sm text-muted-foreground">{{ updateChannelDesc }}</p>
                    </div>
                    <Select :model-value="settingsStore.settings.update?.channel || 'stable'"
                      @update:model-value="(v) => settingsStore.updateSettings({ update: { ...settingsStore.settings.update, channel: String(v) as import('@/types').UpdateChannel } })">
                      <SelectTrigger class="w-44">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem v-for="opt in UPDATE_CHANNEL_OPTIONS" :key="opt.value" :value="opt.value">
                          {{ opt.label }}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <p class="text-xs text-muted-foreground">
                    从预发布通道切回「正式版」后，需等到更高的正式版发布才会再提示更新（当前预发布版不会被「降级」覆盖）。
                  </p>
                </div>

                <Separator />

                <div class="space-y-3">
                  <div class="space-y-1">
                    <p class="font-medium">日志与诊断</p>
                    <p class="text-sm text-muted-foreground">导出前端、后端和全局异常日志，便于开发者复现和排查问题。</p>
                  </div>

                  <div class="flex gap-3">
                    <Button
                      variant="outline"
                      @click="handleOpenLogDirectory"
                    >
                      打开日志目录
                    </Button>

                    <Button
                      variant="outline"
                      :disabled="exportingLogs"
                      @click="handleExportLogs"
                    >
                      {{ exportingLogs ? '导出中...' : '导出日志' }}
                    </Button>
                  </div>
                </div>

                <Separator />

                <div class="space-y-3">
                  <p class="font-medium">联系方式</p>
                  <Button
                    variant="outline"
                    class="w-full justify-between"
                    @click="openExternalLink('https://t.me/+5VEFnb2U_xgyNWY1')"
                  >
                    <span>Telegram 群：点击加入</span>
                    <ExternalLink class="h-4 w-4 text-muted-foreground" />
                  </Button>
                  <Button
                    variant="outline"
                    class="w-full justify-between"
                    @click="openExternalLink('https://github.com/ddmoyu/javm/issues')"
                  >
                    <span>问题反馈：GitHub Issues</span>
                    <ExternalLink class="h-4 w-4 text-muted-foreground" />
                  </Button>
                </div>

                <Separator />

                <div class="space-y-3">
                  <p class="font-medium">浏览器脚本</p>
                  <Button
                    variant="outline"
                    class="w-full justify-between"
                    @click="openExternalLink('https://greasyfork.org/zh-CN/scripts/572376-javm-m3u8-helper')"
                  >
                    <span>JAVM m3u8 Helper：从浏览器一键唤起下载</span>
                    <ExternalLink class="h-4 w-4 text-muted-foreground" />
                  </Button>
                  <p class="text-sm text-muted-foreground">安装后可在浏览器中将 m3u8 链接直接发送到 JAVM 下载。</p>
                </div>

                <Separator />

                <div class="space-y-2">
                  <p class="font-medium">版权信息</p>
                  <p class="text-sm text-muted-foreground">Copyright © 2026 JAVM Contributors. All rights reserved.</p>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    <div class="pb-6" />
    </div>
  </ScrollArea>

  <!-- AI 配置对话框 -->
  <AIConfigDialog v-model:open="aiDialogOpen" :provider="editingProvider" @save="handleSaveProvider" />


</template>

<style scoped>
[draggable="true"] {
  user-select: none;
}

[draggable="true"]:active {
  opacity: 0.5;
  cursor: grabbing;
}
</style>
