export interface AppUpdateInfo {
  configured: boolean
  available: boolean
  currentVersion: string
  version: string | null
  body: string | null
  date: string | null
  target: string | null
}