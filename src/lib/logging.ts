import type { App } from 'vue'
import { isTauriRuntime } from '@/lib/tauri'

type ConsoleMethod = 'log' | 'debug' | 'info' | 'warn' | 'error'
type PluginLogger = (message: string) => Promise<void>

const INSTALL_FLAG = '__JAVM_LOGGING_INSTALLED__'

function stringifyLogValue(value: unknown): string {
    if (value instanceof Error) {
        return [value.name, value.message, value.stack].filter(Boolean).join(': ')
    }

    if (typeof value === 'string') {
        return value
    }

    if (typeof value === 'undefined') {
        return 'undefined'
    }

    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

function forwardConsole(method: ConsoleMethod, logger: PluginLogger) {
    const original = console[method].bind(console)

    console[method] = (...args: unknown[]) => {
        original(...args)

        const message = args.map(stringifyLogValue).join(' ')
        void logger(`[frontend:${method}] ${message}`)
    }
}

export async function installAppLogging(app: App<Element>) {
    if (!isTauriRuntime() || (window as any)[INSTALL_FLAG]) {
        return
    }

    try {
        const plugin = await import('@tauri-apps/plugin-log')

        forwardConsole('log', plugin.trace)
        forwardConsole('debug', plugin.debug)
        forwardConsole('info', plugin.info)
        forwardConsole('warn', plugin.warn)
        forwardConsole('error', plugin.error)

        app.config.errorHandler = (error, _instance, info) => {
            console.error('[vue-error]', info, error)
        }

        window.addEventListener('error', (event) => {
            const errorStack = event.error instanceof Error ? `\n${event.error.stack ?? ''}` : ''
            void plugin.error(
                `[window-error] ${event.message} @ ${event.filename}:${event.lineno}:${event.colno}${errorStack}`,
            )
        })

        window.addEventListener('unhandledrejection', (event) => {
            void plugin.error(`[unhandledrejection] ${stringifyLogValue(event.reason)}`)
        })

        ;(window as any)[INSTALL_FLAG] = true
        console.info('[logging] 前端日志已接入')
    } catch (error) {
        console.error('[logging] 前端日志初始化失败', error)
    }
}