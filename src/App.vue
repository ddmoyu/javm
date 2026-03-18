<script setup lang="ts">
import AppLayout from '@/components/layout/AppLayout.vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Toaster } from '@/components/ui/sonner'
import { useSettingsStore, useDownloadStore, useUpdaterStore } from '@/stores'
import { onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter, RouterView } from 'vue-router'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { getCurrent as getCurrentDeepLinkUrls, onOpenUrl } from '@tauri-apps/plugin-deep-link'
import { toast } from 'vue-sonner'
import { analyticsAddActiveSeconds, analyticsInit, getDefaultDownloadPath, parseDeepLink } from '@/lib/tauri'

const route = useRoute()
const router = useRouter()

const settingsStore = useSettingsStore()
const downloadStore = useDownloadStore()
const updaterStore = useUpdaterStore()

let unlistenResize: (() => void) | null = null
let unlistenMove: (() => void) | null = null
let unlistenDeepLink: UnlistenFn | null = null
let saveTimeout: ReturnType<typeof setTimeout> | null = null
let activeSecondsTimer: ReturnType<typeof setInterval> | null = null
let isInitialized = false

const ACTIVE_SECONDS_INTERVAL = 60

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

  <Dialog v-model:open="updaterStore.promptOpen">
    <DialogContent class="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>发现新版本</DialogTitle>
        <DialogDescription>
          检测到新版本
          <template v-if="updaterStore.updateInfo?.version">
            v{{ updaterStore.updateInfo.version }}
          </template>
          ，是否现在安装？
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-3 rounded-lg border border-border bg-muted/30 p-4 text-sm">
        <p>当前版本：v{{ updaterStore.updateInfo?.currentVersion }}</p>
        <p v-if="updaterStore.updatePublishedAt">发布时间：{{ updaterStore.updatePublishedAt }}</p>
        <p class="line-clamp-4 whitespace-pre-wrap text-muted-foreground">{{ updaterStore.updateNotes }}</p>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="updaterStore.promptOpen = false">
          稍后再说
        </Button>
        <Button variant="outline" @click="updaterStore.openUpdateDetails()">
          查看详情
        </Button>
        <Button :disabled="updaterStore.installing" @click="updaterStore.installLatestUpdate()">
          {{ updaterStore.installing ? '安装中...' : '立即更新' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <Dialog v-model:open="updaterStore.detailsOpen">
    <DialogContent class="sm:max-w-2xl">
      <DialogHeader>
        <DialogTitle>
          更新日志
          <template v-if="updaterStore.updateInfo?.version">
            v{{ updaterStore.updateInfo.version }}
          </template>
        </DialogTitle>
        <DialogDescription>
          <template v-if="updaterStore.updatePublishedAt">
            发布时间：{{ updaterStore.updatePublishedAt }}
          </template>
          <template v-else>
            查看本次版本说明后决定是否安装。
          </template>
        </DialogDescription>
      </DialogHeader>

      <div class="max-h-[55vh] overflow-y-auto rounded-lg border border-border bg-muted/20 p-4 text-sm leading-6 whitespace-pre-wrap break-words">
        {{ updaterStore.updateNotes }}
      </div>

      <DialogFooter>
        <Button variant="outline" @click="updaterStore.detailsOpen = false">
          关闭
        </Button>
        <Button v-if="updaterStore.hasUpdate" variant="outline" @click="updaterStore.backToPrompt()">
          返回提示
        </Button>
        <Button v-if="updaterStore.hasUpdate" :disabled="updaterStore.installing" @click="updaterStore.installLatestUpdate()">
          {{ updaterStore.installing ? '安装中...' : '立即更新' }}
        </Button>
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
</style>
