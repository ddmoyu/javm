import { ref, type Ref } from 'vue'
import type { VideoLink } from '@/lib/tauri'
import { pickRealLink } from '@/utils/pickRealLink'

export type SourceStatus = 'pending' | 'searching' | 'cf' | 'found' | 'failed' | 'notfound'

export interface SourceState {
  siteId: string
  status: SourceStatus
  links: VideoLink[]
  realLink: VideoLink | null
}

export interface AnalyzeResult {
  durationSecs?: number
  width?: number
  height?: number
  isMaster?: boolean
  isVod?: boolean
}

export interface SchedulerDeps {
  open: (code: string, site: string) => Promise<void>
  close: (site: string) => Promise<void>
  closeAll: () => Promise<void>
  analyze: (url: string) => Promise<AnalyzeResult>
  concurrency: number
  timeoutSecs: number
}

const DONE: SourceStatus[] = ['found', 'failed', 'notfound']

/** 纯调度器（副作用经 deps 注入），便于单测 */
export function createScheduler(deps: SchedulerDeps) {
  const sources = ref<SourceState[]>([]) as Ref<SourceState[]>
  const running = ref(false)
  let code = ''
  const queue: string[] = []
  const seen = new Map<string, Set<string>>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  function st(site: string) {
    return sources.value.find((s) => s.siteId === site)
  }

  function settle(site: string, status: SourceStatus) {
    const s = st(site)
    if (!s || DONE.includes(s.status)) return
    s.status = status
    const t = timers.get(site)
    if (t) {
      clearTimeout(t)
      timers.delete(site)
    }
    void deps.close(site)
    pump()
    if (
      running.value &&
      !sources.value.some(
        (x) => x.status === 'searching' || x.status === 'cf' || x.status === 'pending',
      )
    ) {
      running.value = false
    }
  }

  function launch(site: string) {
    const s = st(site)!
    s.status = 'searching'
    void deps.open(code, site)
    const t = setTimeout(() => settle(site, 'failed'), deps.timeoutSecs * 1000)
    timers.set(site, t)
  }

  function pump() {
    while (
      sources.value.filter((s) => s.status === 'searching' || s.status === 'cf').length <
        deps.concurrency &&
      queue.length
    ) {
      launch(queue.shift()!)
    }
  }

  function start(c: string, siteIds: string[]) {
    code = c.trim().toUpperCase()
    running.value = true
    sources.value = siteIds.map((siteId) => ({
      siteId,
      status: 'pending',
      links: [],
      realLink: null,
    }))
    seen.clear()
    queue.length = 0
    queue.push(...siteIds)
    pump()
  }

  function stop() {
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()
    void deps.closeAll()
    for (const s of sources.value) { if (!DONE.includes(s.status)) s.status = 'failed' }
    running.value = false
    queue.length = 0
  }

  async function onLink(e: { site: string; url: string }) {
    const s = st(e.site)
    console.info(`[finder-debug] onLink site=${e.site} status=${s?.status ?? 'NO-SOURCE'} url=${e.url}`)
    if (!s || DONE.includes(s.status)) return
    let set = seen.get(e.site)
    if (!set) {
      set = new Set()
      seen.set(e.site, set)
    }
    if (set.has(e.url)) return
    set.add(e.url)
    const lower = e.url.split('?')[0].toLowerCase()
    if (lower.endsWith('.mp4') || lower.endsWith('.ts')) {
      console.info(`[finder-debug] drop mp4/ts site=${e.site} url=${e.url}`)
      return
    }
    const isHls = lower.endsWith('.m3u8') || lower.endsWith('.txt')
    const link: VideoLink = {
      url: e.url,
      linkType: isHls ? 'm3u8' : 'auto',
      isHls,
      resolution: null,
    }
    s.links = [...s.links, link]
    if (isHls) {
      try {
        const info = await deps.analyze(e.url)
        console.info(`[finder-debug] analyze OK site=${e.site} dur=${info.durationSecs} master=${info.isMaster} h=${info.height} url=${e.url}`)
        s.links = s.links.map((l) => (l.url === e.url ? { ...l, ...info, analyzed: true } : l))
      } catch (err) {
        console.info(`[finder-debug] analyze FAIL site=${e.site} url=${e.url} err=${String(err)}`)
        /* 分析失败：保留链接 */
      }
    }
    const real = pickRealLink(s.links)
    console.info(`[finder-debug] pickReal site=${e.site} real=${real?.url ?? 'null'} durs=[${s.links.map((l) => l.durationSecs ?? '?').join(',')}]`)
    if (real) {
      s.realLink = real
      settle(e.site, 'found')
    }
  }

  function onPageState(e: { site: string; state: string }) {
    const s = st(e.site)
    console.info(`[finder-debug] pageState site=${e.site} state=${e.state} status=${s?.status ?? 'NO-SOURCE'}`)
    if (e.state === 'not-found' && s && !s.realLink) settle(e.site, 'notfound')
    // 窗口被用户关闭 / Rust 注入循环终止：立即结算该源，推进下一个（已 found 的由 DONE 去重忽略）
    if (e.state === 'closed' && s && !s.realLink) settle(e.site, 'failed')
  }

  function onCfState(e: { siteId?: string; status: string; active: boolean }) {
    const s = e.siteId ? st(e.siteId) : undefined
    if (!s || DONE.includes(s.status)) return
    if (e.active) {
      s.status = 'cf'
      const t = timers.get(e.siteId!); if (t) { clearTimeout(t); timers.delete(e.siteId!) }
    } else if (s.status === 'cf') {
      s.status = 'searching'
      const t = setTimeout(() => settle(e.siteId!, 'failed'), deps.timeoutSecs * 1000)
      timers.set(e.siteId!, t)
    }
  }

  return { sources, running, start, stop, onLink, onPageState, onCfState }
}
