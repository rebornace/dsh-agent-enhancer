import { afterEach, describe, expect, it } from 'vitest'
import {
  DESKTOP_WINDOWS_APP_USER_MODEL_ID,
  resolveWindowsAppId,
  showOsNotificationNow,
} from '../src/host/run-alerts/notify.ts'

describe('resolveWindowsAppId', () => {
  const previous = process.env.DSH_TOAST_APP_ID

  afterEach(() => {
    if (previous === undefined) delete process.env.DSH_TOAST_APP_ID
    else process.env.DSH_TOAST_APP_ID = previous
  })

  it('uses DSH_TOAST_APP_ID when set', () => {
    process.env.DSH_TOAST_APP_ID = 'com.example.Custom'
    expect(resolveWindowsAppId(undefined)).toBe('com.example.Custom')
  })

  it('uses Electron getAppUserModelId when available', () => {
    delete process.env.DSH_TOAST_APP_ID
    expect(resolveWindowsAppId({
      app: { getAppUserModelId: () => 'electron.app.FromApi' },
    })).toBe('electron.app.FromApi')
  })

  it('derives electron.app.<name> from app.getName', () => {
    delete process.env.DSH_TOAST_APP_ID
    expect(resolveWindowsAppId({
      app: { getName: () => 'DeepSeek Harness' },
    })).toBe('electron.app.DeepSeek Harness')
  })

  it('falls back to Desktop AUMID — never PowerShell', () => {
    delete process.env.DSH_TOAST_APP_ID
    const id = resolveWindowsAppId(undefined)
    expect(id).toBe(DESKTOP_WINDOWS_APP_USER_MODEL_ID)
    expect(id.toLowerCase()).not.toContain('powershell')
  })
})

describe('showOsNotificationNow', () => {
  it('returns none for blank title or body', async () => {
    expect(await showOsNotificationNow({ title: ' ', body: 'x' })).toEqual({
      shown: false,
      channel: 'none',
    })
    expect(await showOsNotificationNow({ title: 'x', body: '  ' })).toEqual({
      shown: false,
      channel: 'none',
    })
  })

  it('does not post a real OS toast from the test process', async () => {
    const result = await showOsNotificationNow({
      title: '运行提醒',
      body: '测试通知（单元测试）',
    })
    expect(result).toEqual({ shown: false, channel: 'none' })
  })
})
