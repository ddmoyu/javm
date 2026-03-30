<script setup lang="ts">
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import AppLayout from '@/components/layout/AppLayout.vue'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Toaster } from '@/components/ui/sonner'
import { useSettingsStore, useDownloadStore, useUpdaterStore, useVideoStore } from '@/stores'
import { computed, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter, RouterView } from 'vue-router'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { getCurrent as getCurrentDeepLinkUrls, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import { toast } from 'vue-sonner'
import { analyticsAddActiveSeconds, analyticsInit, getDefaultDownloadPath, parseDeepLink } from '@/lib/tauri'

const route = useRoute()
const router = useRouter()

const settingsStore = useSettingsStore()
const downloadStore = useDownloadStore()
const updaterStore = useUpdaterStore()
const videoStore = useVideoStore()

async function openReleasePage() {
  const { openUrl } = await import('@tauri-apps/plugin-opener')
  await openUrl('https://github.com/ddmoyu/javm/releases/latest')
}

marked.setOptions({
  gfm: true,
  breaks: true,
})

let unlistenResize: (() => void) | null = null
let unlistenMove: (() => void) | null = null
let unlistenDeepLink: UnlistenFn | null = null
let unlistenScrapeTaskProgress: UnlistenFn | null = null
let unlistenTaskQueueStatus: UnlistenFn | null = null
let saveTimeout: ReturnType<typeof setTimeout> | null = null
let activeSecondsTimer: ReturnType<typeof setInterval> | null = null
let isInitialized = false

const ACTIVE_SECONDS_INTERVAL = 60

const updateNotesHtml = computed(() => {
  const rendered = marked.parse(updaterStore.updateNotes, { async: false }) as string
  return DOMPurify.sanitize(rendered)
})

const handleDeepLinkUrls = async (urls: string[]) => {
  for (const rawUrl of urls) {
    try {
      const parsed = await parseDeepLink(rawUrl)

      if (parsed.action !== 'download') {
        continue
      }

      await router.push('/download')

      const defaultPath = await getDefaultDownloadPath()
      await downloadStore.addTask(parsed.url, defaultPath, parsed.title)

      toast.success('下载任务已添加', {
        description: `正在下载: ${parsed.title}`
      })
    } catch (error) {
      console.error('[deep-link] process failed:', error)
      toast.error('添加下载任务失败', {
        description: String(error)
      })
    }
  }
}

const saveMainWindowPosition = () => {
  if (!isInitialized) return

  if (saveTimeout) clearTimeout(saveTimeout)
  saveTimeout = setTimeout(async () => {
    const win = getCurrentWindow()
    if (win.label === 'main') {
      const size = await win.outerSize()
      const pos = await win.outerPosition()
      const sf = await win.scaleFactor()

      settingsStore.updateSettings({
        mainWindow: {
          width: size.width / sf,
          height: size.height / sf,
          x: pos.x,
          y: pos.y
        }
      })
    }
  }, 500)
}

onMounted(async () => {
  await settingsStore.loadSettings()

  try {
    await analyticsInit(navigator.language)
  } catch (e) {
    console.warn('[analytics] init failed:', e)
  }

  activeSecondsTimer = setInterval(async () => {
    if (document.hidden) return
    try {
      await analyticsAddActiveSeconds(ACTIVE_SECONDS_INTERVAL)
    } catch (e) {
      console.warn('[analytics] add active seconds failed:', e)
    }
  }, ACTIVE_SECONDS_INTERVAL * 1000)

  await downloadStore.init()

  unlistenScrapeTaskProgress = await listen<{ task_id: string; progress: number }>('scrape-task-progress', (event) => {
    if ((event.payload?.progress ?? 0) >= 5) {
      videoStore.scheduleRefresh()
    }
  })

  unlistenTaskQueueStatus = await listen<{ status: string }>('task-queue-status', (event) => {
    if (event.payload?.status === 'completed') {
      videoStore.scheduleRefresh()
    }
  })

  unlistenDeepLink = await onOpenUrl((urls) => {
    void handleDeepLinkUrls(urls)
  })

  document.addEventListener('contextmenu', (e) => {
    const target = e.target as HTMLElement
    const tagName = target.tagName.toLowerCase()

    if (tagName === 'input' || tagName === 'textarea' || target.isContentEditable) {
      return
    }

    if (target.closest('[data-context-menu]')) {
      return
    }

    e.preventDefault()
  })

  const win = getCurrentWindow()
  if (win.label === 'main') {
    unlistenResize = await win.onResized(() => saveMainWindowPosition())
    unlistenMove = await win.onMoved(() => saveMainWindowPosition())
    await updaterStore.initUpdaterEvents()
    await updaterStore.checkForUpdatesOnStartup()
  }

  const startupDeepLinkUrls = await getCurrentDeepLinkUrls()
  if (startupDeepLinkUrls?.length) {
    await handleDeepLinkUrls(startupDeepLinkUrls)
  }

  setTimeout(() => {
    isInitialized = true
  }, 1000)
})

onUnmounted(() => {
  if (unlistenResize) unlistenResize()
  if (unlistenMove) unlistenMove()
  if (unlistenDeepLink) unlistenDeepLink()
  if (unlistenScrapeTaskProgress) unlistenScrapeTaskProgress()
  if (unlistenTaskQueueStatus) unlistenTaskQueueStatus()
  updaterStore.disposeUpdaterEvents()
  if (saveTimeout) clearTimeout(saveTimeout)
  if (activeSecondsTimer) clearInterval(activeSecondsTimer)
})
</script>

<template>
  <div v-if="route.path === '/video-player'" class="w-full h-full bg-black">
    <RouterView />
  </div>
  <template v-else>
    <AppLayout />
    <Toaster />
  </template>

  <Dialog :open="updaterStore.dialogOpen" @update:open="updaterStore.setDialogOpen">
    <DialogContent class="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>{{ updaterStore.installing ? '正在安装更新' : '发现新版本' }}</DialogTitle>
        <DialogDescription>
          <template v-if="updaterStore.installing">
            更新下载与安装进度会显示在当前窗口中。
          </template>
          <template v-else>
            检测到新版本
            <template v-if="updaterStore.updateInfo?.version">
              v{{ updaterStore.updateInfo.version }}
            </template>
            ，可直接查看日志并安装。
          </template>
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-4">
        <div class="grid gap-3 rounded-lg border border-border bg-muted/30 p-4 text-sm sm:grid-cols-2">
          <div class="space-y-1">
            <p>当前版本：v{{ updaterStore.updateInfo?.currentVersion }}</p>
            <p v-if="updaterStore.updateInfo?.version">目标版本：v{{ updaterStore.updateInfo.version }}</p>
          </div>
          <div class="space-y-1 text-muted-foreground sm:text-right">
            <p v-if="updaterStore.updatePublishedAt">发布时间：{{ updaterStore.updatePublishedAt }}</p>
            <p v-if="updaterStore.updateInfo?.target">适用目标：{{ updaterStore.updateInfo.target }}</p>
          </div>
        </div>

        <div v-if="updaterStore.installing" class="space-y-3 rounded-lg border border-primary/20 bg-primary/5 p-4">
          <div class="flex items-center justify-between text-sm">
            <span class="font-medium">下载与安装进度</span>
            <span class="text-muted-foreground">{{ updaterStore.installProgressText }}</span>
          </div>
          <Progress :model-value="updaterStore.installProgressValue" class="h-2.5" />
          <p class="text-sm text-muted-foreground">{{ updaterStore.installStatusText }}</p>
        </div>

        <div class="space-y-2">
          <p class="text-sm font-medium">更新日志</p>
          <div
            class="update-markdown max-h-[45vh] overflow-y-auto rounded-lg border border-border bg-muted/20 p-4 text-sm leading-6 break-words"
            v-html="updateNotesHtml"
          />
        </div>
      </div>

      <DialogFooter class="flex-row sm:justify-between">
        <Button variant="link" class="text-muted-foreground px-0" @click="openReleasePage">
          手动下载更新
        </Button>
        <div class="flex gap-2">
          <Button variant="outline" :disabled="updaterStore.installing" @click="updaterStore.setDialogOpen(false)">
            稍后再说
          </Button>
          <Button v-if="updaterStore.hasUpdate" :disabled="updaterStore.installing || updaterStore.checking" @click="updaterStore.installLatestUpdate()">
            {{ updaterStore.installing ? '安装中...' : '立即更新' }}
          </Button>
        </div>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<style>
html,
body,
#app {
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
}

::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: hsl(var(--muted-foreground) / 0.3);
  border-radius: 4px;
}

::-webkit-scrollbar-thumb:hover {
  background: hsl(var(--muted-foreground) / 0.5);
}

.titlebar-drag {
  -webkit-app-region: drag;
}

.titlebar-no-drag {
  -webkit-app-region: no-drag;
}

.update-markdown > :first-child {
  margin-top: 0;
}

.update-markdown > :last-child {
  margin-bottom: 0;
}

.update-markdown h1,
.update-markdown h2,
.update-markdown h3,
.update-markdown h4 {
  margin: 1rem 0 0.5rem;
  font-weight: 600;
  line-height: 1.4;
}

.update-markdown h1 {
  font-size: 1.25rem;
}

.update-markdown h2 {
  font-size: 1.125rem;
}

.update-markdown h3,
.update-markdown h4 {
  font-size: 1rem;
}

.update-markdown p,
.update-markdown ul,
.update-markdown ol,
.update-markdown pre,
.update-markdown blockquote {
  margin: 0.75rem 0;
}

.update-markdown ul,
.update-markdown ol {
  padding-left: 1.25rem;
}

.update-markdown ul {
  list-style: disc;
}

.update-markdown ol {
  list-style: decimal;
}

.update-markdown li + li {
  margin-top: 0.25rem;
}

.update-markdown a {
  color: hsl(var(--primary));
  text-decoration: underline;
}

.update-markdown code {
  border-radius: 0.375rem;
  background: hsl(var(--muted));
  padding: 0.125rem 0.375rem;
  font-size: 0.875em;
}

.update-markdown pre {
  overflow-x: auto;
  border-radius: 0.75rem;
  background: hsl(var(--muted));
  padding: 0.875rem 1rem;
}

.update-markdown pre code {
  background: transparent;
  padding: 0;
}

.update-markdown blockquote {
  border-left: 3px solid hsl(var(--border));
  padding-left: 0.875rem;
  color: hsl(var(--muted-foreground));
}
</style>
