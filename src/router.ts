// Vue Router 配置
import { createRouter, createWebHistory } from 'vue-router'

const router = createRouter({
    history: createWebHistory(),
    routes: [
        {
            path: '/',
            name: 'media-library',
            component: () => import('@/views/MediaLibraryView.vue'),
            meta: {
                title: '媒体库',
            },
        },
        {
            path: '/directory',
            name: 'directory',
            component: () => import('@/views/DirectoryView.vue'),
            meta: {
                title: '目录管理',
            },
        },
        {
            path: '/download',
            name: 'download',
            component: () => import('@/views/DownloadView.vue'),
            meta: {
                title: '下载管理',
            },
        },
        {
            path: '/resource-scrape',
            name: 'resource-scrape',
            component: () => import('@/views/ResourceScrapeView.vue'),
            meta: {
                title: '刮削',
            },
        },
        {
            path: '/settings',
            name: 'settings',
            component: () => import('@/views/SettingsView.vue'),
            meta: {
                title: '系统设置',
            },
        },
        {
            path: '/video-player',
            name: 'video-player',
            component: () => import('@/views/VideoPlayerView.vue'),
            meta: {
                title: '视频播放',
            },
        },
    ],
})

// 路由守卫：更新页面标题
router.beforeEach((to) => {
    const title = to.meta.title as string
    if (title) {
        document.title = `${title} - JAVManager`
    }
})

export default router
