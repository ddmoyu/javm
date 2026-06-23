import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createScheduler } from '../useParallelFinder'

// 用假定时器：调度器内部 setTimeout(120s) 不真正挂起，避免测试结束后留真实定时器
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function deps(over: Partial<any> = {}) {
  return {
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    closeAll: vi.fn(async () => {}),
    analyze: vi.fn(async () => ({ durationSecs: 3600, height: 1080, isMaster: false, isVod: true, width: 1920 })),
    concurrency: 3,
    timeoutSecs: 120,
    ...over,
  }
}

describe('createScheduler', () => {
  it('start 时只并发开 concurrency 个源', async () => {
    const d = deps({ concurrency: 2 })
    const s = createScheduler(d)
    s.start('ABC-123', ['a', 'b', 'c', 'd'])
    expect(d.open).toHaveBeenCalledTimes(2)
    expect(s.sources.value.filter((x) => x.status === 'searching')).toHaveLength(2)
    expect(s.sources.value.filter((x) => x.status === 'pending')).toHaveLength(2)
  })

  it('某源出正片 → 该源 found、关窗、补开下一个', async () => {
    const d = deps({ concurrency: 1 })
    const s = createScheduler(d)
    s.start('ABC', ['a', 'b'])
    await s.onLink({ site: 'a', url: 'http://x/main.m3u8' })
    const a = s.sources.value.find((x) => x.siteId === 'a')!
    expect(a.status).toBe('found')
    expect(a.realLink?.url).toBe('http://x/main.m3u8')
    expect(d.close).toHaveBeenCalledWith('a')
    expect(d.open).toHaveBeenCalledWith('ABC', 'b')
  })

  it('404 且无正片 → notfound、让槽', async () => {
    const d = deps({ concurrency: 1 })
    const s = createScheduler(d)
    s.start('ABC', ['a', 'b'])
    s.onPageState({ site: 'a', state: 'not-found' })
    expect(s.sources.value.find((x) => x.siteId === 'a')!.status).toBe('notfound')
    expect(d.open).toHaveBeenCalledWith('ABC', 'b')
  })

  it('全部源结算后 running=false', async () => {
    const d = deps({ concurrency: 3 })
    const s = createScheduler(d)
    s.start('ABC', ['a'])
    s.onPageState({ site: 'a', state: 'not-found' })
    expect(s.running.value).toBe(false)
  })

  it('stop 关闭全部并清空', async () => {
    const d = deps()
    const s = createScheduler(d)
    s.start('ABC', ['a', 'b', 'c', 'd'])
    s.stop()
    expect(d.closeAll).toHaveBeenCalled()
    expect(s.running.value).toBe(false)
  })
})
