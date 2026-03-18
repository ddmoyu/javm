// Tauri IPC 璋冪敤灏佽
import { invoke } from '@tauri-apps/api/core'
import type { Video, VideoFilter, DownloadTask, ScrapeTask, AppSettings, Directory, AppUpdateInfo } from '@/types'

export function isTauriRuntime() {
    return typeof window !== 'undefined' && Boolean((window as any).__TAURI_INTERNALS__)
}

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>) {
    if (!isTauriRuntime()) {
        throw new Error('Tauri runtime unavailable')
    }
    return invoke<T>(command, args)
}

export function isTsVideoPath(path: string): boolean {
    return /\.(m2ts|ts)$/i.test(path)
}

// ============ 瑙嗛鐩稿叧 ============

/** 鎵弿鐩綍 */
export async function scanDirectory(path: string): Promise<number> {
    return tauriInvoke<number>('scan_directory', { path })
}

/** 娣诲姞鐩綍鍒版暟鎹簱 */
export async function addDirectory(path: string): Promise<string> {
    return tauriInvoke<string>('add_directory', { path })
}

/** 鑾峰彇鎵弿杩囩殑鐩綍鍒楄〃 */
export async function getDirectories(): Promise<Directory[]> {
    return tauriInvoke<Directory[]>('get_directories')
}

/** 鍒犻櫎鐩綍鍙婂叾涓嬫墍鏈夎棰?*/
export async function deleteDirectory(id: string): Promise<void> {
    return tauriInvoke('delete_directory', { id })
}

/** 鑾峰彇瑙嗛鍒楄〃 */
export async function getVideos(filter?: VideoFilter): Promise<Video[]> {
    return tauriInvoke<Video[]>('get_videos', { filter })
}

/** 鑾峰彇閲嶅瑙嗛鍒楄〃锛堢洿鎺ユ煡搴擄級 */
export async function getDuplicateVideos(): Promise<Video[]> {
    return tauriInvoke<Video[]>('get_duplicate_videos')
}

/** 鑾峰彇鍗曚釜瑙嗛璇︽儏 */
export async function getVideo(id: string): Promise<Video> {
    return tauriInvoke<Video>('get_video', { id })
}

/** 鏇存柊瑙嗛淇℃伅 */
export async function updateVideo(id: string, data: Partial<Video>): Promise<void> {
    return tauriInvoke('update_video', { id, data })
}

/** 鍒犻櫎瑙嗛 (浠呮暟鎹簱) */
export async function deleteVideoDb(id: string): Promise<void> {
    return tauriInvoke('delete_video_db', { id })
}

/** 鍒犻櫎瑙嗛 (鏁版嵁搴?鏂囦欢) */
export async function deleteVideoFile(id: string): Promise<void> {
    return tauriInvoke('delete_video_file', { id })
}

/** 绉诲姩瑙嗛鏂囦欢 */
export async function moveVideoFile(id: string, targetDir: string): Promise<void> {
    return tauriInvoke('move_video_file', { id, targetDir })
}

// ============ 涓嬭浇鐩稿叧 ============

/** 鑾峰彇涓嬭浇浠诲姟鍒楄〃 */
export async function getDownloadTasks(): Promise<DownloadTask[]> {
    return tauriInvoke<DownloadTask[]>('get_download_tasks')
}

/** 娣诲姞涓嬭浇浠诲姟 */
export async function addDownloadTask(url: string, savePath: string, filename?: string): Promise<string> {
    return tauriInvoke<string>('add_download_task', { url, savePath, filename })
}

export interface ParsedDeepLink {
    action: 'download'
    url: string
    title: string
}

export async function parseDeepLink(url: string): Promise<ParsedDeepLink> {
    return tauriInvoke<ParsedDeepLink>('parse_deep_link', { url })
}

/** 鍋滄涓嬭浇浠诲姟 */
export async function stopDownloadTask(taskId: string): Promise<void> {
    return tauriInvoke('stop_download_task', { taskId })
}

/** 閲嶈瘯涓嬭浇浠诲姟 */
export async function retryDownloadTask(taskId: string): Promise<void> {
    return tauriInvoke('retry_download_task', { taskId })
}

/** 鍒犻櫎涓嬭浇浠诲姟 */
export async function deleteDownloadTask(taskId: string): Promise<void> {
    return tauriInvoke('delete_download_task', { taskId })
}

/** 閲嶅懡鍚嶄笅杞戒换鍔?*/
export async function renameDownloadTask(taskId: string, newFilename: string): Promise<void> {
    return tauriInvoke('rename_download_task', { taskId, newFilename })
}

/** 淇敼涓嬭浇浠诲姟淇濆瓨璺緞 */
export async function changeDownloadSavePath(taskId: string, newSavePath: string): Promise<void> {
    return tauriInvoke('change_download_save_path', { taskId, newSavePath })
}



/** 鑾峰彇榛樿涓嬭浇璺緞 */
export async function getDefaultDownloadPath(): Promise<string> {
    return tauriInvoke<string>('get_default_download_path')
}

/** 鎵归噺鍋滄涓嬭浇浠诲姟 */
export async function batchStopTasks(taskIds: string[]): Promise<string[]> {
    return tauriInvoke<string[]>('batch_stop_tasks', { taskIds })
}

/** 鎵归噺閲嶈瘯涓嬭浇浠诲姟 */
export async function batchRetryTasks(taskIds: string[]): Promise<string[]> {
    return tauriInvoke<string[]>('batch_retry_tasks', { taskIds })
}

/** 鎵归噺鍒犻櫎涓嬭浇浠诲姟 */
export async function batchDeleteTasks(taskIds: string[]): Promise<string[]> {
    return tauriInvoke<string[]>('batch_delete_tasks', { taskIds })
}

// ============ 鍒墛鐩稿叧 ============

/** 鑾峰彇鍒墛浠诲姟鍒楄〃 */
export async function getScrapeTasks(): Promise<ScrapeTask[]> {
    return tauriInvoke<ScrapeTask[]>('rs_get_scrape_tasks')
}

/** 鍒涘缓甯﹁繃婊ょ殑鍒墛浠诲姟锛堟帓闄ゅ凡鍒墛鐨勮棰戯級 */
export async function createFilteredScrapeTasks(path: string): Promise<number> {
    return tauriInvoke<number>('rs_create_filtered_scrape_tasks', { path })
}

/** 鍒犻櫎鍒墛浠诲姟 */
export async function deleteScrapeTask(taskId: string): Promise<void> {
    return tauriInvoke('rs_delete_scrape_task', { taskId })
}

/** 鍒犻櫎鎵€鏈夊凡瀹屾垚鐨勪换鍔?*/
export async function deleteCompletedScrapeTasks(): Promise<number> {
    return tauriInvoke<number>('rs_delete_completed_scrape_tasks')
}

/** 鍋滄鍒墛浠诲姟 */
export async function stopScrapeTask(taskId: string): Promise<void> {
    return tauriInvoke('rs_stop_scrape_task', { taskId })
}

/** 閲嶇疆鍒墛浠诲姟鐘舵€佷负绛夊緟涓?*/
export async function resetScrapeTask(taskId: string): Promise<void> {
    return tauriInvoke('rs_reset_scrape_task', { taskId })
}

/** 鍚姩浠诲姟闃熷垪 */
export async function startTaskQueue(): Promise<void> {
    return tauriInvoke('rs_start_task_queue')
}

/** 鍋滄浠诲姟闃熷垪 */
export async function stopTaskQueue(): Promise<void> {
    return tauriInvoke('rs_stop_task_queue')
}

/** 鎼滅储璧勬簮锛堟祦寮忥紝缁撴灉閫氳繃浜嬩欢鎺ㄩ€侊級 */
export async function searchResource(code: string): Promise<void> {
    return tauriInvoke('rs_search_resource', { code })
}

/** 鍒墛淇濆瓨锛氫粠鎼滅储缁撴灉淇濆瓨鍏冩暟鎹埌鏈湴 */
export async function scrapeSave(videoId: string, metadata: any): Promise<any> {
    return tauriInvoke('rs_scrape_save', { videoId, metadata })
}

/** 鑾峰彇璧勬簮缃戠珯鍒楄〃 */
export async function getResourceSites(): Promise<any[]> {
    return tauriInvoke('get_resource_sites')
}

/** 鍥剧墖浠ｇ悊锛氬悗绔笅杞藉浘鐗囧苟杩斿洖 base64 data URL */
export async function proxyImage(url: string): Promise<string> {
    return tauriInvoke<string>('rs_proxy_image', { url })
}

/** 鏌ユ壘瑙嗛涓嬭浇閾炬帴 - 鎵撳紑 WebView */
export interface VideoLink {
    url: string
    linkType: string
    isHls: boolean
    resolution: string | null
}

export interface VideoSite {
    id: string
    name: string
    urlTemplate: string
}

export async function findVideoLinks(code: string, siteId?: string): Promise<void> {
    return tauriInvoke('rs_find_video_links', { code, siteId })
}

/** 鍏抽棴瑙嗛鏌ユ壘 WebView */
export async function closeVideoFinder(): Promise<void> {
    return tauriInvoke('rs_close_video_finder')
}

/** 妫€鏌ユ寚瀹氱暘鍙疯棰戞槸鍚﹀凡瀛樺湪 */
export interface VideoExistCheckResult {
    exists: boolean
    video?: {
        id: string
        title: string
        videoPath: string
    }
}
export async function checkVideoExists(code: string): Promise<VideoExistCheckResult> {
    return tauriInvoke<VideoExistCheckResult>('rs_check_video_exists_by_code', { code })
}

/** 鑾峰彇鏀寔鐨勮棰戠綉绔欏垪琛?*/
export async function getVideoSites(): Promise<VideoSite[]> {
    return tauriInvoke<VideoSite[]>('rs_get_video_sites')
}

/** HLS 楠岃瘉缁撴灉 */
export interface HlsVerifyResult {
    isHls: boolean
    isVod: boolean
    resolution: string | null
}

/** 楠岃瘉閾炬帴鏄惁涓?HLS */
export async function verifyHls(url: string, referer?: string): Promise<HlsVerifyResult> {
    return tauriInvoke<HlsVerifyResult>('rs_verify_hls', { url, referer })
}

/** 浠庣綉绔欓厤缃腑鎻愬彇 Referer */
export function getSiteReferer(site?: VideoSite): string | undefined {
    if (!site?.urlTemplate) return undefined
    try {
        const u = new URL(site.urlTemplate.replace('{code}', 'test'))
        return `${u.protocol}//${u.host}/`
    } catch {
        return undefined
    }
}

// ============ 璁剧疆鐩稿叧 ============

/** 鑾峰彇搴旂敤璁剧疆 */
export async function getSettings(): Promise<AppSettings> {
    return tauriInvoke<AppSettings>('get_settings')
}

/** 淇濆瓨搴旂敤璁剧疆 */
export async function saveSettings(settings: AppSettings): Promise<void> {
    return tauriInvoke('save_settings', { settings })
}

export async function checkAppUpdate(): Promise<AppUpdateInfo> {
    return tauriInvoke<AppUpdateInfo>('check_app_update')
}

export async function installAppUpdate(): Promise<string> {
    return tauriInvoke<string>('install_app_update')
}

// ============ 缁熻鐩稿叧 ============

/** 鍒濆鍖栨湰鍦扮粺璁″苟鍦ㄦ鏃ラ鍚笂鎶ュ墠涓€澶?鏇存棭鏁版嵁 */
export async function analyticsInit(systemLanguage?: string): Promise<void> {
    return tauriInvoke('analytics_init', { systemLanguage: systemLanguage ?? null })
}

/** 绱姞鏈娲昏穬鏃堕暱锛堢锛?*/
export async function analyticsAddActiveSeconds(seconds: number): Promise<void> {
    return tauriInvoke('analytics_add_active_seconds', { seconds })
}

/** 立即同步待上报统计数据到 Supabase */
export async function analyticsSyncNow(): Promise<number> {
    return tauriInvoke<number>('analytics_sync_now')
}

export interface SupabaseConfigDebugInfo {
    found: boolean
    source: string
    urlPreview: string | null
    keyLength: number | null
    table: string | null
}

/** 调试: 查看后端是否能读取到 Supabase 配置 */
export async function analyticsDebugSupabaseConfig(): Promise<SupabaseConfigDebugInfo> {
    return tauriInvoke<SupabaseConfigDebugInfo>('analytics_debug_supabase_config')
}

export interface RuntimeSystemInfo {
    os: string
    cpuArch: string
}

export async function getRuntimeSystemInfo(): Promise<RuntimeSystemInfo> {
    return tauriInvoke<RuntimeSystemInfo>('get_runtime_system_info')
}

// ============ 鏂囦欢绯荤粺鐩稿叧 ============

/** 閫夋嫨鐩綍 */
export async function selectDirectory(): Promise<string | null> {
    if (!isTauriRuntime()) {
        throw new Error('Tauri runtime unavailable')
    }
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
        directory: true,
        multiple: false,
    })
    return selected
}



/** 鎵撳紑鏂囦欢鎵€鍦ㄧ洰褰?*/
export async function openInExplorer(path: string): Promise<void> {
    return tauriInvoke('open_in_explorer', { path })
}

/** 浣跨敤澶栭儴鎾斁鍣ㄦ墦寮€ */
export async function openWithPlayer(path: string): Promise<void> {
    return tauriInvoke('open_with_player', { path })
}

/** 鎵撳紑瑙嗛鎾斁鍣ㄧ獥鍙?*/
export async function openVideoPlayerWindow(videoUrl: string, title: string, isHls: boolean): Promise<void> {
    return tauriInvoke('open_video_player_window', { videoUrl, title, isHls })
}



