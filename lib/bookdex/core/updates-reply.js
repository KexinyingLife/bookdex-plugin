import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  ensureDirs,
  slugify,
  booksRoot,
  storyRoot,
  storyIndexFile,
  relicRoot,
  relicIndexFile,
  weaponRoot,
  weaponIndexFile,
  voiceRoot,
  voiceIndexFile,
  plotRoot,
  plotIndexFile,
  mapRoot,
  mapIndexFile,
  anecdoteRoot,
  anecdoteIndexFile,
  cardRoot,
  cardIndexFile,
  backpackRoot,
  backpackIndexFile,
  loadIndex,
  saveIndex,
  loadStoryIndex,
  loadRelicIndex,
  loadWeaponIndex,
  loadVoiceIndex,
  loadPlotIndex,
  loadMapIndex,
  loadAnecdoteIndex,
  loadCardIndex,
  loadBackpackIndex
} from '../base.js'
import { BOOK_TEXT_SCHEMA_VERSION, PLOT_TEXT_SCHEMA_VERSION, MAP_TEXT_SCHEMA_VERSION, ROLE_STORY_SCHEMA_VERSION } from './constants.js'
import { selectorSignature, fetchEntryPageById } from './crypto-api.js'
import { normalizeRoleName, splitTextPages } from './text-volumes.js'
import { buildPlotFileName, buildMapFileName, buildAnecdoteFileName, buildCardFileName, buildBackpackFileName } from './paths.js'
import { parsePlotPage, parsePlotSearchText, parsePlotCategory, extractPlotSubtitle } from './parse-plot.js'
import { parseMapPage, parseAnecdotePage, parseCardPage, parseBackpackPage } from './parse-map-card.js'
import {
  extractRoleStory,
  parseRoleVoices,
  parseRelicPiece,
  parseWeaponStory
} from './parse-entities.js'
import { buildBookTextFromEntryPage } from './inbox-books.js'

function stableHash(value) {
  return createHash('sha1').update(JSON.stringify(value || null)).digest('hex')
}

function getSelectorItemName(item = {}) {
  return (item.title || item.name || '').trim()
}

async function listSelectorItems(channelId, maxPages = 50) {
  const items = []
  for (let page = 1; page <= maxPages; page++) {
    const u = new URL('https://act-api-takumi.mihoyo.com/common/blackboard/ys_obc/v1/content/selector')
    u.searchParams.set('app_sn', 'ys_obc')
    u.searchParams.set('channel_id', String(channelId))
    u.searchParams.set('page', String(page))
    u.searchParams.set('page_size', '100')
    const j = await (await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } })).json()
    const list = j?.data?.list || []
    if (!list.length) break
    items.push(...list)
  }
  return items
}

function pickSelectorItemByName(items = [], rawName = '') {
  const query = String(rawName || '').trim()
  const key = normalizeRoleName(query)
  if (!query || !items.length) return null

  const withName = items
    .map(item => ({ item, name: getSelectorItemName(item) }))
    .filter(x => x.name)

  const exact = withName.find(x => normalizeRoleName(x.name) === key || x.name === query)
  if (exact) return exact.item

  const partial = withName
    .filter(x => normalizeRoleName(x.name).includes(key))
    .sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name, 'zh-Hans-CN'))

  return partial[0]?.item || null
}

function upsertById(list = [], next = {}) {
  const id = String(next.id || '')
  const idx = list.findIndex(x => String(x.id || '') === id)
  if (idx >= 0) list[idx] = next
  else list.push(next)
}

async function updateOneBookByName(rawName = '') {
  await ensureDirs()
  const items = await listSelectorItems(68, 20)
  const picked = pickSelectorItemByName(items, rawName)
  if (!picked) return { ok: false, reason: 'not_found' }

  const name = getSelectorItemName(picked)
  const id = String(picked.id || '')
  const page = await fetchEntryPageById(id)
  if (!page) return { ok: false, reason: 'entry_missing', name, id }
  const text = await buildBookTextFromEntryPage(page)
  if (!text) return { ok: false, reason: 'empty', name, id }

  const out = `${slugify(name)}.txt`
  const filePath = path.join(booksRoot, out)
  await fs.writeFile(filePath, text, 'utf8')

  const index = await loadIndex()
  const books = index.books || []
  const sig = selectorSignature(picked)
  const next = {
    title: name,
    file: out,
    source: `wiki:${id}`,
    selectorSig: sig,
    bookSchemaVersion: BOOK_TEXT_SCHEMA_VERSION
  }
  const pos = books.findIndex(b => String(b.source || '') === `wiki:${id}`)
  if (pos >= 0) books[pos] = next
  else books.push(next)
  books.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
  await saveIndex({ books })
  return { ok: true, name, id }
}

async function updateOneRoleStoryByName(rawName = '') {
  await ensureDirs()
  const items = await listSelectorItems(25, 20)
  const picked = pickSelectorItemByName(items, rawName)
  if (!picked) return { ok: false, reason: 'not_found' }

  const name = getSelectorItemName(picked)
  const id = String(picked.id || '')
  const page = await fetchEntryPageById(id)
  if (!page) return { ok: false, reason: 'entry_missing', name, id }
  const ext = extractRoleStory(page)
  if (!ext.detail && !ext.stories?.length && !ext.others?.length) return { ok: false, reason: 'empty', name, id }

  const filePath = path.join(storyRoot, `${slugify(name)}.json`)
  const role = {
    id,
    name,
    alias: [normalizeRoleName(name)],
    detail: ext.detail || '',
    stories: ext.stories || [],
    others: ext.others || []
  }
  await fs.writeFile(filePath, JSON.stringify(role, null, 2), 'utf8')

  const idx = await loadStoryIndex()
  const roles = idx.roles || []
  upsertById(roles, {
    id,
    name,
    alias: role.alias,
    storyCount: role.stories.length,
    otherCount: role.others.length,
    selectorSig: selectorSignature(picked),
    schemaVersion: ROLE_STORY_SCHEMA_VERSION,
    contentHash: stableHash({ detail: role.detail || '', stories: role.stories || [], others: role.others || [] })
  })
  roles.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  await fs.writeFile(storyIndexFile, JSON.stringify({ roles, updatedAt: Date.now() }, null, 2), 'utf8')
  return { ok: true, name, id }
}

async function updateOneVoiceByName(rawName = '') {
  await ensureDirs()
  const items = await listSelectorItems(25, 20)
  const picked = pickSelectorItemByName(items, rawName)
  if (!picked) return { ok: false, reason: 'not_found' }

  const name = getSelectorItemName(picked)
  const id = String(picked.id || '')
  const page = await fetchEntryPageById(id)
  if (!page) return { ok: false, reason: 'entry_missing', name, id }
  const tabs = parseRoleVoices(page)
  if (!tabs.length) return { ok: false, reason: 'empty', name, id }

  const filePath = path.join(voiceRoot, `${slugify(name)}.json`)
  const voice = { id, name, alias: [normalizeRoleName(name)], tabs }
  await fs.writeFile(filePath, JSON.stringify(voice, null, 2), 'utf8')

  const idx = await loadVoiceIndex()
  const roles = idx.roles || []
  upsertById(roles, {
    id,
    name,
    alias: voice.alias,
    langCount: tabs.length,
    itemCount: tabs.reduce((sum, t) => sum + (t.items || []).length, 0),
    selectorSig: selectorSignature(picked),
    contentHash: stableHash(tabs)
  })
  roles.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  await fs.writeFile(voiceIndexFile, JSON.stringify({ roles, updatedAt: Date.now() }, null, 2), 'utf8')
  return { ok: true, name, id }
}

async function updateOnePlotByName(rawName = '') {
  await ensureDirs()
  const items = await listSelectorItems(43, 50)
  const picked = pickSelectorItemByName(items, rawName)
  if (!picked) return { ok: false, reason: 'not_found' }

  const name = getSelectorItemName(picked)
  const id = String(picked.id || '')
  const page = await fetchEntryPageById(id)
  if (!page) return { ok: false, reason: 'entry_missing', name, id }
  const sections = parsePlotPage(page)
  const searchText = parsePlotSearchText(page)
  if (!sections.length && !searchText) return { ok: false, reason: 'empty', name, id }

  const fileName = buildPlotFileName(name, id)
  const filePath = path.join(plotRoot, fileName)
  const category = parsePlotCategory(picked.ext)
  const subtitle = extractPlotSubtitle(page)
  const data = { id, name, file: fileName, alias: [normalizeRoleName(name)], category, subtitle, sections, searchText }
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')

  const idx = await loadPlotIndex()
  const arr = idx.items || []
  upsertById(arr, {
    id,
    name,
    file: fileName,
    alias: data.alias,
    category,
    subtitle,
    sectionCount: sections.length,
    selectorSig: selectorSignature(picked),
    plotSchemaVersion: PLOT_TEXT_SCHEMA_VERSION
  })
  arr.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || String(a.id).localeCompare(String(b.id)))
  await fs.writeFile(plotIndexFile, JSON.stringify({ items: arr, updatedAt: Date.now() }, null, 2), 'utf8')
  return { ok: true, name, id }
}

async function updateOneMapByName(rawName = '') {
  await ensureDirs()
  const items = await listSelectorItems(251, 50)
  const picked = pickSelectorItemByName(items, rawName)
  if (!picked) return { ok: false, reason: 'not_found' }

  const name = getSelectorItemName(picked)
  const id = String(picked.id || '')
  const page = await fetchEntryPageById(id)
  if (!page) return { ok: false, reason: 'entry_missing', name, id }
  const sections = parseMapPage(page)
  const searchText = sections.map(sec => `【${sec.title || '交互文本'}】\n${sec.text || ''}`).join('\n\n').trim()
  if (!sections.length && !searchText) return { ok: false, reason: 'empty', name, id }

  const fileName = buildMapFileName(name, id)
  const filePath = path.join(mapRoot, fileName)
  const data = { id, name, file: fileName, alias: [normalizeRoleName(name)], sections, searchText }
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')

  const idx = await loadMapIndex()
  const arr = idx.items || []
  upsertById(arr, {
    id,
    name,
    file: fileName,
    alias: data.alias,
    sectionCount: sections.length,
    selectorSig: selectorSignature(picked),
    mapSchemaVersion: MAP_TEXT_SCHEMA_VERSION
  })
  arr.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || String(a.id).localeCompare(String(b.id)))
  await fs.writeFile(mapIndexFile, JSON.stringify({ items: arr, updatedAt: Date.now() }, null, 2), 'utf8')
  return { ok: true, name, id }
}

async function updateOneAnecdoteByName(rawName = '') {
  await ensureDirs()
  const items = await listSelectorItems(261, 50)
  const picked = pickSelectorItemByName(items, rawName)
  if (!picked) return { ok: false, reason: 'not_found' }

  const name = getSelectorItemName(picked)
  const id = String(picked.id || '')
  const page = await fetchEntryPageById(id)
  if (!page) return { ok: false, reason: 'entry_missing', name, id }
  const sections = parseAnecdotePage(page)
  const searchText = sections.map(sec => `【${sec.title || '文本'}】\n${sec.text || ''}`).join('\n\n').trim()
  if (!sections.length && !searchText) return { ok: false, reason: 'empty', name, id }

  const fileName = buildAnecdoteFileName(name, id)
  const filePath = path.join(anecdoteRoot, fileName)
  const data = { id, name, file: fileName, alias: [normalizeRoleName(name)], sections, searchText }
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')

  const idx = await loadAnecdoteIndex()
  const arr = idx.items || []
  upsertById(arr, {
    id,
    name,
    file: fileName,
    alias: data.alias,
    sectionCount: sections.length,
    selectorSig: selectorSignature(picked)
  })
  arr.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || String(a.id).localeCompare(String(b.id)))
  await fs.writeFile(anecdoteIndexFile, JSON.stringify({ items: arr, updatedAt: Date.now() }, null, 2), 'utf8')
  return { ok: true, name, id }
}

async function updateOneCardByName(rawName = '') {
  await ensureDirs()
  const items = await listSelectorItems(249, 50)
  const picked = pickSelectorItemByName(items, rawName)
  if (!picked) return { ok: false, reason: 'not_found' }

  const name = getSelectorItemName(picked)
  const id = String(picked.id || '')
  const page = await fetchEntryPageById(id)
  if (!page) return { ok: false, reason: 'entry_missing', name, id }
  const sections = parseCardPage(page)
  const searchText = sections.map(sec => `【${sec.title || '文本'}】\n${sec.text || ''}`).join('\n\n').trim()
  if (!sections.length && !searchText) return { ok: false, reason: 'empty', name, id }

  const fileName = buildCardFileName(name, id)
  const filePath = path.join(cardRoot, fileName)
  const data = { id, name, file: fileName, alias: [normalizeRoleName(name)], sections, searchText }
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')

  const idx = await loadCardIndex()
  const arr = idx.items || []
  upsertById(arr, {
    id,
    name,
    file: fileName,
    alias: data.alias,
    sectionCount: sections.length,
    selectorSig: selectorSignature(picked)
  })
  arr.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || String(a.id).localeCompare(String(b.id)))
  await fs.writeFile(cardIndexFile, JSON.stringify({ items: arr, updatedAt: Date.now() }, null, 2), 'utf8')
  return { ok: true, name, id }
}

async function updateOneBackpackByName(rawName = '') {
  await ensureDirs()
  const items = await listSelectorItems(13, 50)
  const picked = pickSelectorItemByName(items, rawName)
  if (!picked) return { ok: false, reason: 'not_found' }

  const name = getSelectorItemName(picked)
  const id = String(picked.id || '')
  const page = await fetchEntryPageById(id)
  if (!page) return { ok: false, reason: 'entry_missing', name, id }
  const parsed = parseBackpackPage(page)
  const finalName = parsed.name || name
  const desc = parsed.desc || ''
  if (!finalName || !desc) return { ok: false, reason: 'empty', name, id }

  const fileName = buildBackpackFileName(finalName, id)
  const filePath = path.join(backpackRoot, fileName)
  const data = { id, name: finalName, file: fileName, alias: [normalizeRoleName(finalName)], desc, searchText: desc }
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')

  const idx = await loadBackpackIndex()
  const arr = idx.items || []
  upsertById(arr, {
    id,
    name: finalName,
    file: fileName,
    alias: data.alias,
    selectorSig: selectorSignature(picked)
  })
  arr.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || String(a.id).localeCompare(String(b.id)))
  await fs.writeFile(backpackIndexFile, JSON.stringify({ items: arr, updatedAt: Date.now() }, null, 2), 'utf8')
  return { ok: true, name: finalName, id }
}

async function updateOneRelicByName(rawName = '') {
  await ensureDirs()
  const items = await listSelectorItems(218, 20)
  const picked = pickSelectorItemByName(items, rawName)
  if (!picked) return { ok: false, reason: 'not_found' }

  const name = getSelectorItemName(picked)
  const id = String(picked.id || '')
  const page = await fetchEntryPageById(id)
  if (!page) return { ok: false, reason: 'entry_missing', name, id }
  const pieces = []
  for (const m of (page.modules || [])) {
    const p = parseRelicPiece(m)
    if (p && p.name) pieces.push(p)
  }
  if (!pieces.length) return { ok: false, reason: 'empty', name, id }

  const filePath = path.join(relicRoot, `${slugify(name)}.json`)
  const data = { id, name, alias: [normalizeRoleName(name)], pieces }
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')

  const idx = await loadRelicIndex()
  const sets = idx.sets || []
  upsertById(sets, {
    id,
    name,
    alias: data.alias,
    pieceCount: pieces.length,
    selectorSig: selectorSignature(picked)
  })
  sets.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  await fs.writeFile(relicIndexFile, JSON.stringify({ sets, updatedAt: Date.now() }, null, 2), 'utf8')
  return { ok: true, name, id }
}

async function updateOneWeaponByName(rawName = '') {
  await ensureDirs()
  const items = await listSelectorItems(5, 20)
  const picked = pickSelectorItemByName(items, rawName)
  if (!picked) return { ok: false, reason: 'not_found' }

  const name = getSelectorItemName(picked)
  const id = String(picked.id || '')
  const page = await fetchEntryPageById(id)
  if (!page) return { ok: false, reason: 'entry_missing', name, id }
  const story = parseWeaponStory(page)
  if (!story) return { ok: false, reason: 'empty', name, id }

  const filePath = path.join(weaponRoot, `${slugify(name)}.json`)
  const data = { id, name, alias: [normalizeRoleName(name)], story }
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')

  const idx = await loadWeaponIndex()
  const weapons = idx.weapons || []
  upsertById(weapons, {
    id,
    name,
    alias: data.alias,
    selectorSig: selectorSignature(picked)
  })
  weapons.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  await fs.writeFile(weaponIndexFile, JSON.stringify({ weapons, updatedAt: Date.now() }, null, 2), 'utf8')
  return { ok: true, name, id }
}

async function sendVoiceRecord(e, url) {
  if (!url) return e.reply('该条语音没有音频地址')
  await e.reply(segment.record(url))
  return true
}

async function replyLong(e, text) {
  const chunks = splitTextPages(text, 1600)
  if (chunks.length <= 1) return e.reply(text)
  return e.reply(await Bot.makeForwardArray(chunks))
}

export {
  updateOneBookByName,
  updateOneRoleStoryByName,
  updateOneVoiceByName,
  updateOnePlotByName,
  updateOneMapByName,
  updateOneAnecdoteByName,
  updateOneCardByName,
  updateOneBackpackByName,
  updateOneRelicByName,
  updateOneWeaponByName,
  sendVoiceRecord,
  replyLong
}
