import { createHash } from 'node:crypto'
import fss from 'node:fs'

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

async function fetchEntryPageById(id) {
  const u = new URL('https://act-api-takumi-static.mihoyo.com/hoyowiki/genshin/wapi/entry_page')
  u.searchParams.set('app_sn', 'ys_obc')
  u.searchParams.set('entry_page_id', String(id))
  const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } })
  const j = await r.json()
  return j?.data?.page || null
}

export { selectorSignature, selectorSigMatches, hasUsableMeta, emitProgress, fetchEntryPageById }
