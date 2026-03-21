<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { Plus, GripVertical, Edit, Trash2, ExternalLink } from 'lucide-vue-next'
import { toast } from 'vue-sonner'
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
import AIConfigDialog from '@/components/AIConfigDialog.vue'
import { analyticsSyncNow, selectDirectory } from '@/lib/tauri'
import { THEME_OPTIONS, VIEW_MODE_OPTIONS } from '@/utils/constants'
import type { AIProvider, ViewMode } from '@/types'

const route = useRoute()
const settingsStore = useSettingsStore()
const updaterStore = useUpdaterStore()
const isDebugMode = import.meta.env.DEV
const appVersion = packageInfo.version

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
    url: 'https://mojie.app/register?aff=6U9kDSoZ'
  }
] as const

// 当前激活的 tab
const activeTab = ref('theme')

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
    sites: settingsStore.settings.scrape.sites?.map(s => ({ ...s })) || []
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

const syncingAnalyticsNow = ref(false)

const handleAnalyticsSyncNow = async () => {
  if (syncingAnalyticsNow.value) return

  syncingAnalyticsNow.value = true
  try {
    const synced = await analyticsSyncNow()
    if (synced > 0) {
      toast.success(`已立即同步 ${synced} 条数据到 Supabase`)
    } else {
      toast.info('没有待同步的数据')
    }
  } catch (e) {
    console.error('Failed to sync analytics now:', e)
    toast.error(e instanceof Error ? e.message : '立即同步失败')
  } finally {
    syncingAnalyticsNow.value = false
  }
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
      sites: settingsStore.settings.scrape.sites?.map(s => ({ ...s })) || []
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
})

// 刮削设置
const saveScrapeSettings = () => {
  settingsStore.updateSettings({ scrape: localSettings.value.scrape })
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
      sites: newSettings.scrape.sites?.map(s => ({ ...s })) || []
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
    <div class="p-6">
      <Tabs :model-value="activeTab" @update:model-value="(v) => activeTab = String(v)" class="space-y-6">
        <TabsList class="grid w-full" :class="isDebugMode ? 'grid-cols-6' : 'grid-cols-5'">
          <TabsTrigger value="theme">基础</TabsTrigger>
          <TabsTrigger value="download">下载</TabsTrigger>
          <TabsTrigger value="scrape">资源刮削</TabsTrigger>
          <TabsTrigger value="ai">AI</TabsTrigger>
          <TabsTrigger value="about">关于</TabsTrigger>
          <TabsTrigger v-if="isDebugMode" value="debug">Debug</TabsTrigger>
        </TabsList>

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
                  <button
                    v-for="service in recommendedProxyServices"
                    :key="service.name"
                    type="button"
                    class="flex w-full items-center justify-between rounded-lg border border-border bg-muted/40 px-4 py-3 text-left transition-colors hover:bg-muted"
                    @click="openRecommendedService(service.url)"
                  >
                    <div>
                      <p class="font-medium text-foreground">{{ service.name }}</p>
                    </div>
                    <ExternalLink class="h-4 w-4 text-muted-foreground" />
                  </button>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <!-- 下载设置 -->
        <TabsContent value="download">
          <Card>
            <CardHeader>
              <CardTitle>下载设置</CardTitle>
              <CardDescription>配置下载器和保存路径</CardDescription>
            </CardHeader>
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
        </TabsContent>

        <!-- 资源刮削设置 -->
        <TabsContent value="scrape">
          <Card>
            <CardHeader>
              <CardTitle>资源刮削</CardTitle>
              <CardDescription>配置资源网站和刮削行为</CardDescription>
            </CardHeader>
            <CardContent class="space-y-6">
              <!-- 默认刮削网站 -->
              <div class="flex items-center justify-between">
                <div>
                  <p class="font-medium">默认刮削网站</p>
                  <p class="text-sm text-muted-foreground">批量刮削时使用的默认数据源</p>
                </div>
                <Select :model-value="localSettings.scrape.defaultSite"
                  @update:model-value="(v) => { localSettings.scrape.defaultSite = String(v); saveScrapeSettings() }">
                  <SelectTrigger class="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem v-for="(site, index) in localSettings.scrape.sites?.filter(s => s.enabled)"
                      :key="site.id" :value="site.id">
                      节点 {{ index + 1 }}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>


            </CardContent>
          </Card>
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
              <!-- 视觉识别 -->
              <div class="flex items-center justify-between">
                <div>
                  <p class="font-medium">视觉识别</p>
                  <p class="text-sm text-muted-foreground">使用视觉模型分析视频截图</p>
                </div>
                <Switch :model-value="localSettings.ai.enableVision"
                  @update:model-value="(v: boolean) => { localSettings.ai.enableVision = v; saveAISettings() }" />
              </div>

              <Separator />

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

        <TabsContent v-if="isDebugMode" value="debug">
          <Card>
            <CardHeader>
              <CardTitle>Debug 调试</CardTitle>
              <CardDescription>仅在 Debug 模式可见，用于手动触发数据同步</CardDescription>
            </CardHeader>
            <CardContent>
              <div class="flex items-center justify-between gap-4">
                <div>
                  <p class="font-medium">数据同步</p>
                  <p class="text-sm text-muted-foreground">点击后立即同步当前待上报数据到 Supabase</p>
                </div>
                <Button :disabled="syncingAnalyticsNow" @click="handleAnalyticsSyncNow">
                  {{ syncingAnalyticsNow ? '同步中...' : '立即同步数据' }}
                </Button>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
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
