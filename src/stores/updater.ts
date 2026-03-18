import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { toast } from 'vue-sonner'
import { checkAppUpdate, installAppUpdate, isTauriRuntime } from '@/lib/tauri'
import type { AppUpdateInfo } from '@/types'

export const useUpdaterStore = defineStore('updater', () => {
  const updateInfo = ref<AppUpdateInfo | null>(null)
  const checking = ref(false)
  const installing = ref(false)
  const promptOpen = ref(false)
  const detailsOpen = ref(false)
  const startupChecked = ref(false)

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
        detailsOpen.value = false
        promptOpen.value = true
      } else {
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
    if (installing.value) {
      return false
    }

    if (!updateInfo.value?.available) {
      const info = await checkForUpdates()
      if (!info?.available) {
        return false
      }
    }

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
    promptOpen,
    detailsOpen,
    hasUpdate,
    updateNotes,
    updatePublishedAt,
    checkForUpdates,
    checkForUpdatesOnStartup,
    openUpdateDetails,
    backToPrompt,
    installLatestUpdate,
  }
})