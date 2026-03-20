import { computed, ref } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { defineStore } from 'pinia'
import { toast } from 'vue-sonner'
import { checkAppUpdate, installAppUpdate, isTauriRuntime } from '@/lib/tauri'
import type { AppUpdateInfo, AppUpdateProgress } from '@/types'

export const useUpdaterStore = defineStore('updater', () => {
  const updateInfo = ref<AppUpdateInfo | null>(null)
  const checking = ref(false)
  const installing = ref(false)
  const dialogOpen = ref(false)
  const installProgress = ref<AppUpdateProgress | null>(null)
  const startupChecked = ref(false)
  let progressUnlisten: UnlistenFn | null = null

  function createUnavailableUpdateInfo(): AppUpdateInfo {
    return {
      configured: false,
      available: false,
      currentVersion: '',
      version: null,
      body: null,
      date: null,
      target: null,
    }
  }

  function isUpdaterConfigError(error: unknown) {
    if (!(error instanceof Error)) {
      return false
    }

    return error.message.includes('UPDATER_NOT_CONFIGURED')
  }

  function formatBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) {
      return '0 B'
    }

    const units = ['B', 'KB', 'MB', 'GB']
    let size = bytes
    let unitIndex = 0

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024
      unitIndex += 1
    }

    const digits = size >= 10 || unitIndex === 0 ? 0 : 1
    return `${size.toFixed(digits)} ${units[unitIndex]}`
  }

  function resetInstallProgress() {
    installProgress.value = null
  }

  async function initUpdaterEvents() {
    if (!isTauriRuntime() || progressUnlisten) {
      return
    }

    progressUnlisten = await listen<AppUpdateProgress>('app-update-download-progress', (event) => {
      installProgress.value = event.payload
      if (installing.value) {
        dialogOpen.value = true
      }
    })
  }

  function disposeUpdaterEvents() {
    progressUnlisten?.()
    progressUnlisten = null
  }

  function setDialogOpen(open: boolean) {
    if (!open && installing.value) {
      return
    }

    dialogOpen.value = open

    if (!open && !installing.value) {
      resetInstallProgress()
    }
  }

  const hasUpdate = computed(() => Boolean(updateInfo.value?.available))
  const updateNotes = computed(() => updateInfo.value?.body?.trim() || '当前版本未提供更新日志。')
  const updatePublishedAt = computed(() => {
    const raw = updateInfo.value?.date
    if (!raw) {
      return ''
    }

    const parsed = new Date(raw)
    if (Number.isNaN(parsed.getTime())) {
      return raw
    }

    return new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(parsed)
  })
  const installProgressValue = computed(() => {
    if (installProgress.value?.phase === 'installing') {
      return 100
    }

    const percentage = installProgress.value?.percentage
    if (typeof percentage !== 'number') {
      return 0
    }

    return Math.max(0, Math.min(100, Math.round(percentage)))
  })
  const installProgressText = computed(() => {
    if (!installing.value) {
      return ''
    }

    if (installProgress.value?.phase === 'installing') {
      return '100%'
    }

    if (typeof installProgress.value?.percentage === 'number') {
      return `${Math.round(installProgress.value.percentage)}%`
    }

    return '下载中'
  })
  const installStatusText = computed(() => {
    if (!installing.value) {
      return ''
    }

    if (!installProgress.value) {
      return '正在准备下载更新包...'
    }

    if (installProgress.value.phase === 'installing') {
      return '下载完成，正在启动安装程序...'
    }

    if (installProgress.value.totalBytes) {
      return `正在下载更新包：${formatBytes(installProgress.value.downloadedBytes)} / ${formatBytes(installProgress.value.totalBytes)}`
    }

    if (installProgress.value.downloadedBytes > 0) {
      return `正在下载更新包：已下载 ${formatBytes(installProgress.value.downloadedBytes)}`
    }

    return '正在下载更新包...'
  })

  async function checkForUpdates(options?: {
    silentIfNoUpdate?: boolean
    isStartup?: boolean
  }) {
    if (!isTauriRuntime()) {
      return null
    }

    if (checking.value) {
      return updateInfo.value
    }

    checking.value = true
    try {
      const info = await checkAppUpdate()
      updateInfo.value = info

      if (info.available) {
        resetInstallProgress()
        dialogOpen.value = true
      } else {
        resetInstallProgress()
        dialogOpen.value = false

        if (!options?.silentIfNoUpdate) {
          if (info.configured) {
            toast.success('当前已是最新版本')
          } else {
            toast.info('当前构建未启用应用内更新')
          }
        }
      }

      return info
    } catch (error) {
      if (isUpdaterConfigError(error)) {
        updateInfo.value = createUnavailableUpdateInfo()
        resetInstallProgress()
        dialogOpen.value = false

        if (!options?.silentIfNoUpdate) {
          toast.info('当前版本暂不支持应用内更新')
        }

        return updateInfo.value
      }

      const errMsg = error instanceof Error ? error.message : String(error)
      console.error('检查更新失败:', errMsg)
      if (!options?.silentIfNoUpdate) {
        toast.error(`检查更新失败: ${errMsg}`)
      }
      return null
    } finally {
      checking.value = false
    }
  }

  async function checkForUpdatesOnStartup() {
    if (startupChecked.value) {
      return
    }

    startupChecked.value = true
    await checkForUpdates({ silentIfNoUpdate: true, isStartup: true })
  }

  function openUpdateDetails() {
    if (!updateInfo.value?.available) {
      return
    }

    dialogOpen.value = true
  }

  async function installLatestUpdate() {
    if (installing.value) {
      return false
    }

    if (!updateInfo.value?.available) {
      const info = await checkForUpdates()
      if (!info?.available) {
        return false
      }
    }

    await initUpdaterEvents()
    installProgress.value = {
      phase: 'downloading',
      downloadedBytes: 0,
      totalBytes: null,
      percentage: null,
    }
    dialogOpen.value = true
    installing.value = true
    try {
      const message = await installAppUpdate()
      resetInstallProgress()
      dialogOpen.value = false

      if (message) {
        toast.success(message)
      }

      return true
    } catch (error) {
      resetInstallProgress()
      dialogOpen.value = Boolean(updateInfo.value?.available)

      if (isUpdaterConfigError(error)) {
        updateInfo.value = createUnavailableUpdateInfo()
        dialogOpen.value = false
        toast.info('当前版本暂不支持应用内更新')
      } else {
        toast.error('安装更新失败，请稍后重试')
      }
      return false
    } finally {
      installing.value = false
    }
  }

  return {
    updateInfo,
    checking,
    installing,
    dialogOpen,
    installProgress,
    hasUpdate,
    updateNotes,
    updatePublishedAt,
    installProgressValue,
    installProgressText,
    installStatusText,
    initUpdaterEvents,
    disposeUpdaterEvents,
    setDialogOpen,
    checkForUpdates,
    checkForUpdatesOnStartup,
    openUpdateDetails,
    installLatestUpdate,
  }
})