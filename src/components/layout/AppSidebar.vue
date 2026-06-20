<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router'
import {
  Film,
  Compass,
  FolderOpen,
  Download,
  Radar,
  Settings
} from 'lucide-vue-next'
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
} from '@/components/ui/sidebar'

const route = useRoute()

// 导航菜单项
const navItems = [
  {
    title: '媒体库',
    icon: Film,
    path: '/',
  },
  {
    title: '发现',
    icon: Compass,
    path: '/discover',
  },
  {
    title: '目录管理',
    icon: FolderOpen,
    path: '/directory',
  },
  {
    title: '下载管理',
    icon: Download,
    path: '/download',
  },
  {
    title: '刮削',
    icon: Radar,
    path: '/resource-scrape',
  },
  {
    title: '系统设置',
    icon: Settings,
    path: '/settings',
  },
]

// 检查路由是否激活
const isActive = (path: string) => {
  if (path === '/') {
    return route.path === '/'
  }
  return route.path.startsWith(path)
}
</script>

<template>
  <Sidebar collapsible="icon">
    <SidebarContent>
      <SidebarGroup>
        <SidebarGroupContent>
          <SidebarMenu>
            <SidebarMenuItem v-for="item in navItems" :key="item.path">
              <SidebarMenuButton
                as-child
                :tooltip="item.title"
                :isActive="isActive(item.path)"
              >
                <RouterLink :to="item.path">
                  <component :is="item.icon" />
                  <span>{{ item.title }}</span>
                </RouterLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    </SidebarContent>
  </Sidebar>
</template>
