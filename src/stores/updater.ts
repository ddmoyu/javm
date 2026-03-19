import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { toast } from 'vue-sonner'
import { checkAppUpdate, downloadAppUpdate, installAppUpdate, isTauriRuntime } from '@/lib/tauri'
import type { AppUpdateDownloadFinished, AppUpdateDownloadProgress, AppUpdateInfo } from '@/types'
import { formatFileSize, formatProgress } from '@/utils/format'

export const useUpdaterStore = defineStore('updater', () => {
  const updateInfo = ref<AppUpdateInfo | null>(null)
  const checking = ref(false)
  const downloading = ref(false)
  const installing = ref(false)
  const promptOpen = ref(false)
  const detailsOpen = ref(false)
  const startupChecked = ref(false)
  const downloadProgress = ref<AppUpdateDownloadProgress | null>(null)
  const readyToInstall = ref(false)
  let progressUnlisten: UnlistenFn | null = null
  let finishedUnlisten: UnlistenFn | null = null

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

  const hasUpdate = computed(() => Boolean(updateInfo.value?.available))
  const hasDownloadProgress = computed(() => Boolean(downloadProgress.value))
  const updating = computed(() => downloading.value || installing.value)
  const updateNotes = computed(() => updateInfo.value?.body?.trim() || '当前版本未提供更新日志。')
  const installButtonText = computed(() => {
    if (installing.value) {
      return '启动安装器...'
    }

    if (downloading.value) {
      const progress = downloadProgress.value?.progress
      if (typeof progress === 'number') {
        return `下载中 ${formatProgress(progress)}`
      }

      return '下载中...'
    }

    if (readyToInstall.value) {
      return '立即安装'
    }

    return '下载更新'
  })
  const downloadProgressText = computed(() => {
    const progress = downloadProgress.value
    if (!progress) {
      return ''
    }

    const downloaded = formatFileSize(progress.downloadedBytes)
    if (progress.totalBytes && progress.totalBytes > 0) {
      return `${downloaded} / ${formatFileSize(progress.totalBytes)}`
    }

    return `已下载 ${downloaded}`
  })
  const installStatusText = computed(() => {
    if (installing.value) {
      return '正在启动安装程序，请稍候。'
    }

    if (readyToInstall.value) {
      return '更新包已下载完成，请确认是否现在开始安装。'
    }

    if (!downloading.value) {
      return ''
    }

    const progress = downloadProgress.value?.progress
    if (typeof progress === 'number') {
      return `正在下载更新包，当前进度 ${formatProgress(progress)}。`
    }

    return '正在准备更新包，请稍候。'
  })
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

  function resetInstallProgress() {
    downloadProgress.value = null
    readyToInstall.value = false
  }

  async function init() {
    if (progressUnlisten || finishedUnlisten || !isTauriRuntime()) {
      return
    }

    progressUnlisten = await listen<AppUpdateDownloadProgress>('updater-download-progress', (event) => {
      downloadProgress.value = event.payload
      readyToInstall.value = false
    })

    finishedUnlisten = await listen<AppUpdateDownloadFinished>('updater-download-finished', (event) => {
      const totalBytes = event.payload.totalBytes ?? event.payload.downloadedBytes
      downloadProgress.value = {
        downloadedBytes: event.payload.downloadedBytes,
        totalBytes,
        progress: 100,
      }
      downloading.value = false
      readyToInstall.value = true
      promptOpen.value = !detailsOpen.value

      toast.success('更新包下载完成', {
        description: '请确认是否现在开始安装。',
      })
    })
  }

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
        if (!readyToInstall.value) {
          detailsOpen.value = false
          promptOpen.value = true
        }
      } else {
        resetInstallProgress()
        detailsOpen.value = false
        promptOpen.value = false

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
        detailsOpen.value = false
        promptOpen.value = false

        if (!options?.silentIfNoUpdate) {
          toast.info('当前版本暂不支持应用内更新')
        }

        return updateInfo.value
      }

      if (!options?.silentIfNoUpdate) {
        toast.error('检查更新失败，请稍后重试')
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
    await init()
    await checkForUpdates({ silentIfNoUpdate: true, isStartup: true })
  }

  function openUpdateDetails() {
    if (!updateInfo.value?.available) {
      return
    }

    promptOpen.value = false
    detailsOpen.value = true
  }

  function backToPrompt() {
    if (!updateInfo.value?.available) {
      return
    }

    detailsOpen.value = false
    promptOpen.value = true
  }

  async function installLatestUpdate() {
    if (updating.value) {
      return false
    }

    await init()

    if (!updateInfo.value?.available) {
      const info = await checkForUpdates()
      if (!info?.available) {
        return false
      }
    }

    if (readyToInstall.value) {
      installing.value = true
      try {
        const message = await installAppUpdate()
        promptOpen.value = false
        detailsOpen.value = false

        if (message) {
          toast.success(message)
        }

        return true
      } catch (error) {
        if (isUpdaterConfigError(error)) {
          updateInfo.value = createUnavailableUpdateInfo()
          resetInstallProgress()
          toast.info('当前版本暂不支持应用内更新')
        } else {
          toast.error(error instanceof Error ? error.message : '安装更新失败，请稍后重试')
        }
        return false
      } finally {
        installing.value = false
      }
    }

    resetInstallProgress()
    downloading.value = true
    try {
      await downloadAppUpdate()

      return true
    } catch (error) {
      resetInstallProgress()
      toast.error(error instanceof Error ? error.message : '下载更新失败，请稍后重试')
      return false
    } finally {
      downloading.value = false
    }
  }

  return {
    init,
    updateInfo,
    checking,
    downloading,
    installing,
    updating,
    downloadProgress,
    readyToInstall,
    promptOpen,
    detailsOpen,
    hasUpdate,
    hasDownloadProgress,
    installButtonText,
    downloadProgressText,
    installStatusText,
    updateNotes,
    updatePublishedAt,
    checkForUpdates,
    checkForUpdatesOnStartup,
    openUpdateDetails,
    backToPrompt,
    installLatestUpdate,
  }
})