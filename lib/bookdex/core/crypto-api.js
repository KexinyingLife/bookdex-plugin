import { createHash } from 'node:crypto'
import fss from 'node:fs'

const WIKI_FETCH_TIMEOUT_MS = 15000
const WIKI_FETCH_RETRIES = 2
const WIKI_HEADERS = { 'user-agent': 'Mozilla/5.0' }

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]))
  }
  return value
}

function selectorSignature(item = {}) {
  const normalized = stableValue({
    id: String(item.id || ''),
    jump_type: item.jump_type || '',
    content_id: item.content_id || '',
    content_type: item.content_type || ''
  })
  return createHash('sha1').update(JSON.stringify(normalized)).digest('hex')
}

function transitionalSelectorSignature(item = {}) {
  const normalized = stableValue({
    id: String(item.id || ''),
    title: item.title || '',
    name: item.name || '',
    jump_type: item.jump_type || '',
    content_id: item.content_id || '',
    content_type: item.content_type || ''
  })
  return createHash('sha1').update(JSON.stringify(normalized)).digest('hex')
}

function legacySelectorSignature(item = {}) {
  const normalized = stableValue({
    id: String(item.id || ''),
    title: item.title || '',
    name: item.name || '',
    ext: item.ext || '',
    icon: item.icon || '',
    cover: item.cover || '',
    jump_type: item.jump_type || '',
    content_id: item.content_id || '',
    content_type: item.content_type || '',
    area_id: item.area_id || '',
    cate_id: item.cate_id || '',
    tag_id: item.tag_id || ''
  })
  return createHash('sha1').update(JSON.stringify(normalized)).digest('hex')
}

function selectorSigMatches(savedSig, item = {}) {
  if (!savedSig) return true
  const sig = String(savedSig)
  return sig === selectorSignature(item) || sig === transitionalSelectorSignature(item) || sig === legacySelectorSignature(item)
}

function hasUsableMeta(meta = {}, filePath = '') {
  return Boolean(meta && meta.id && filePath && fss.existsSync(filePath))
}

async function emitProgress(fn, payload) {
  if (typeof fn === 'function') await fn(payload)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getFetchErrorCode(error) {
  if (error?.cause?.code) return error.cause.code
  if (error?.code) return error.code
  return ['AbortError', 'TimeoutError'].includes(error?.name) ? error.name : ''
}

function isRetryableFetchError(error) {
  const code = getFetchErrorCode(error)
  if (['AbortError', 'TimeoutError'].includes(code)) return true
  if (String(code).startsWith('UND_ERR_')) return true
  if (error?.name === 'TypeError' && /fetch failed/i.test(error?.message || '')) return true
  const status = Number(error?.status || 0)
  return status === 429 || status >= 500
}

function makeWikiFetchError(message, { url, label, status, cause } = {}) {
  const code = getFetchErrorCode(cause)
  const suffix = code ? `（${code}）` : ''
  const error = new Error(`${message}${suffix}`)
  error.name = 'WikiFetchError'
  error.url = url ? String(url) : ''
  error.label = label || ''
  error.status = status
  error.cause = cause
  error.userMessage = `${label || '米游社/HoYoWiki 数据'}下载失败：${message}${suffix}。这通常是服务器到米游社接口的网络波动，不是图鉴数据损坏；请稍后重试。`
  return error
}

function formatFetchError(error) {
  if (error?.userMessage) return error.userMessage
  const code = getFetchErrorCode(error)
  const suffix = code ? `（${code}）` : ''
  if (error?.name === 'TypeError' && /fetch failed/i.test(error?.message || '')) {
    return `米游社/HoYoWiki 数据下载失败${suffix}。这通常是服务器网络到米游社接口超时或被重置，请稍后重试。`
  }
  return error?.message || String(error)
}

async function fetchJson(url, { label = '', retries = WIKI_FETCH_RETRIES, timeoutMs = WIKI_FETCH_TIMEOUT_MS } = {}) {
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, {
        headers: WIKI_HEADERS,
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!r.ok) {
        const error = makeWikiFetchError(`HTTP ${r.status}`, { url, label, status: r.status })
        if (attempt < retries && isRetryableFetchError(error)) {
          lastError = error
          await sleep(600 * (attempt + 1))
          continue
        }
        throw error
      }
      try {
        return await r.json()
      } catch (error) {
        throw makeWikiFetchError('接口返回内容不是有效 JSON', { url, label, cause: error })
      }
    } catch (error) {
      const wrapped = error?.name === 'WikiFetchError'
        ? error
        : makeWikiFetchError(error?.name === 'TimeoutError' ? '请求超时' : (error?.message || '请求失败'), { url, label, cause: error })
      if (attempt < retries && isRetryableFetchError(error)) {
        lastError = wrapped
        await sleep(600 * (attempt + 1))
        continue
      }
      throw wrapped
    }
  }
  throw lastError || makeWikiFetchError('请求失败', { url, label })
}

async function fetchSelectorPage({ channelId, page, pageSize = 100, label = '' }) {
  const u = new URL('https://act-api-takumi.mihoyo.com/common/blackboard/ys_obc/v1/content/selector')
  u.searchParams.set('app_sn', 'ys_obc')
  u.searchParams.set('channel_id', String(channelId))
  u.searchParams.set('page', String(page))
  u.searchParams.set('page_size', String(pageSize))
  return fetchJson(u, { label: label || `频道 ${channelId} 第 ${page} 页` })
}

async function fetchEntryPageById(id) {
  const u = new URL('https://act-api-takumi-static.mihoyo.com/hoyowiki/genshin/wapi/entry_page')
  u.searchParams.set('app_sn', 'ys_obc')
  u.searchParams.set('entry_page_id', String(id))
  const j = await fetchJson(u, { label: `条目 ${id}` })
  return j?.data?.page || null
}

export { selectorSignature, selectorSigMatches, hasUsableMeta, emitProgress, fetchEntryPageById, fetchSelectorPage, fetchJson, formatFetchError }
