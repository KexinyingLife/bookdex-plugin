import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { cacheRoot } from './base.js'

const webConfigFile = path.join(cacheRoot, 'webui.json')
const DEFAULT_PORT = 14522
const DEFAULT_HOST = '0.0.0.0'

function defaultConfig() {
  return {
    webui: {
      enabled: true,
      host: DEFAULT_HOST,
      publicHost: '',
      port: DEFAULT_PORT,
      token: randomBytes(18).toString('base64url')
    },
    autoUpdate: {
      enabled: true,
      nextRunAt: ''
    }
  }
}

function mergeConfig(raw = {}) {
  const def = defaultConfig()
  return {
    webui: {
      ...def.webui,
      ...(raw.webui || {}),
      token: raw?.webui?.token || def.webui.token
    },
    autoUpdate: {
      ...def.autoUpdate,
      ...(raw.autoUpdate || {})
    }
  }
}

async function loadBookDexWebConfig() {
  try {
    const parsed = JSON.parse(await fs.readFile(webConfigFile, 'utf8'))
    return mergeConfig(parsed)
  } catch {
    const cfg = defaultConfig()
    await saveBookDexWebConfig(cfg)
    return cfg
  }
}

function loadBookDexWebConfigSync() {
  try {
    const parsed = JSON.parse(fss.readFileSync(webConfigFile, 'utf8'))
    return mergeConfig(parsed)
  } catch {
    const cfg = defaultConfig()
    try {
      fss.mkdirSync(cacheRoot, { recursive: true })
      fss.writeFileSync(webConfigFile, JSON.stringify(cfg, null, 2), 'utf8')
    } catch {}
    return cfg
  }
}

async function saveBookDexWebConfig(config = {}) {
  const cfg = mergeConfig(config)
  await fs.mkdir(cacheRoot, { recursive: true })
  await fs.writeFile(webConfigFile, JSON.stringify(cfg, null, 2), 'utf8')
  return cfg
}

function getDefaultAutoCycleInfo(now = Date.now()) {
  // 基准：2026-04-08 00:00 (GMT+8)，沿用原来的 42 天周期。
  const baseUtc = Date.UTC(2026, 3, 7, 16, 0, 0)
  const dayMs = 86400000
  const days = Math.floor((now - baseUtc) / dayMs)
  const cycleDay = ((days % 42) + 42) % 42
  const todayMidnight = baseUtc + days * dayMs
  const todayCheckAt = todayMidnight > now ? todayMidnight : todayMidnight + dayMs

  for (let offset = 0; offset <= 42; offset++) {
    const checkAt = todayCheckAt + offset * dayMs
    const checkDays = Math.floor((checkAt - baseUtc) / dayMs)
    const checkCycleDay = ((checkDays % 42) + 42) % 42
    if (checkCycleDay >= 1 && checkCycleDay <= 5) {
      return {
        cycleDay,
        nextRunAt: checkAt,
        nextRunAtText: formatGmt8(checkAt)
      }
    }
  }

  return { cycleDay, nextRunAt: 0, nextRunAtText: '未知' }
}

function formatGmt8(ms) {
  if (!ms) return ''
  const d = new Date(Number(ms) + 8 * 3600 * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

function parseDateTimeToMs(value) {
  const text = String(value || '').trim()
  if (!text) return 0
  const normalized = text.includes('T') ? text : text.replace(' ', 'T')
  const ms = Date.parse(`${normalized}${/[zZ]|[+-]\d\d:?\d\d$/.test(normalized) ? '' : '+08:00'}`)
  return Number.isFinite(ms) ? ms : 0
}

function getConfiguredNextAutoRun(config = loadBookDexWebConfigSync(), now = Date.now()) {
  if (!config.autoUpdate?.enabled) return { enabled: false, nextRunAt: 0, nextRunAtText: '已关闭', custom: false }
  const customMs = parseDateTimeToMs(config.autoUpdate?.nextRunAt)
  if (customMs) return { enabled: true, nextRunAt: customMs, nextRunAtText: formatGmt8(customMs), custom: true }
  return { enabled: true, ...getDefaultAutoCycleInfo(now), custom: false }
}

function shouldRunBookDexAutoUpdate(now = Date.now()) {
  const cfg = loadBookDexWebConfigSync()
  if (!cfg.autoUpdate?.enabled) return false
  const customMs = parseDateTimeToMs(cfg.autoUpdate?.nextRunAt)
  if (customMs) return now >= customMs
  return true
}

async function consumeCustomAutoRun() {
  const cfg = await loadBookDexWebConfig()
  if (!cfg.autoUpdate?.nextRunAt) return cfg
  cfg.autoUpdate.nextRunAt = ''
  return saveBookDexWebConfig(cfg)
}

export {
  webConfigFile,
  loadBookDexWebConfig,
  loadBookDexWebConfigSync,
  saveBookDexWebConfig,
  getDefaultAutoCycleInfo,
  getConfiguredNextAutoRun,
  shouldRunBookDexAutoUpdate,
  consumeCustomAutoRun,
  formatGmt8,
  parseDateTimeToMs
}
