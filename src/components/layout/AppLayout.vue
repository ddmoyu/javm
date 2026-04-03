<script setup lang="ts">
import { ref, watch } from 'vue'
import { RouterView } from 'vue-router'
import AppSidebar from './AppSidebar.vue'
import WindowControls from './WindowControls.vue'
import { SidebarProvider, SidebarInset, SidebarTrigger } from '@/components/ui/sidebar'
import { Separator } from '@/components/ui/separator'
import { useRoute } from 'vue-router'
import { computed } from 'vue'
import { toast } from 'vue-sonner'
import { useScanProgress } from '@/composables/useTauriEvents'

const route = useRoute()

// 获取当前页面标题
const pageTitle = computed(() => {
  return (route.meta.title as string) || 'JAVManager'
})

// 全局扫描进度 toast 管理
const scanToastId = ref<string | number | null>(null)
const { progress: scanProgress } = useScanProgress()

watch(scanProgress, (newProgress) => {
  if (newProgress) {
    if (!scanToastId.value) {
      scanToastId.value = toast.info('正在扫描视频文件...', {
        description: newProgress.total > 0
          ? `进度: ${newProgress.current}/${newProgress.total} 文件 (${Math.round((newProgress.current / newProgress.total) * 100)}%)`
          : '正在统计文件数量...',
        duration: Infinity
      })
    } else {
      toast.info('正在扫描视频文件...', {
        id: scanToastId.value,
        description: newProgress.total > 0
          ? `进度: ${newProgress.current}/${newProgress.total} 文件 (${Math.round((newProgress.current / newProgress.total) * 100)}%)`
          : newProgress.current_file || '正在统计文件数量...',
        duration: Infinity
      })
    }
  } else if (scanToastId.value) {
    toast.dismiss(scanToastId.value)
    scanToastId.value = null
  }
})
</script>

<template>
  <SidebarProvider class="h-screen overflow-hidden">
    <AppSidebar />
    <SidebarInset class="overflow-hidden">
      <!-- 顶部栏 -->
      <header class="flex h-9 shrink-0 items-center gap-2 border-b pl-4 pr-0" data-tauri-drag-region>
        <div class="flex items-center gap-2">
          <SidebarTrigger class="-ml-1" />
          <Separator orientation="vertical" class="mr-2 h-4" />
          <h1 class="text-sm font-normal">{{ pageTitle }}</h1>
        </div>

        <div class="ml-auto h-full">
          <WindowControls />
        </div>
      </header>

      <!-- 主内容区域 -->
      <div class="flex-1 overflow-hidden">
        <RouterView v-slot="{ Component, route: currentRoute }">
          <KeepAlive>
            <component :is="Component" :key="currentRoute.fullPath" />
          </KeepAlive>
        </RouterView>
      </div>
    </SidebarInset>
  </SidebarProvider>
</template>
