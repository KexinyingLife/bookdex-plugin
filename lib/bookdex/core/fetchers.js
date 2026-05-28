import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  ensureDirs,
  slugify,
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
  booksRoot,
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
  loadBackpackIndex,
  loadPipelineState,
  savePipelineModuleVersion
} from '../base.js'
import {
  ROLE_STORY_SCHEMA_VERSION,
  BOOK_TEXT_SCHEMA_VERSION,
  PLOT_TEXT_SCHEMA_VERSION,
  MAP_TEXT_SCHEMA_VERSION,
  ANECDOTE_TEXT_SCHEMA_VERSION,
  CARD_TEXT_SCHEMA_VERSION,
  RELIC_TEXT_SCHEMA_VERSION,
  WEAPON_TEXT_SCHEMA_VERSION,
  BACKPACK_TEXT_SCHEMA_VERSION,
  INTERACTIVE_DIALOGUE_PIPELINE_VERSION,
  INTERACTIVE_PARSE_PIPELINE_KEYS
} from './constants.js'
import { selectorSignature, selectorSigMatches, hasUsableMeta, emitProgress, fetchEntryPageById, fetchSelectorPage } from './crypto-api.js'
import { interactiveDialoguePipelineVersion, interactiveDialogueParseOk } from './pipeline.js'
import { normalizeRoleName } from './text-volumes.js'
import { buildPlotFileName, buildMapFileName, buildAnecdoteFileName, buildCardFileName, buildBackpackFileName } from './paths.js'
import {
  parsePlotPage,
  parsePlotPageRich,
  parsePlotSearchText,
  parsePlotCategory,
  extractPlotSubtitle
} from './parse-plot.js'
import { parseMapPage, parseAnecdotePage, parseCardPage, parseBackpackPage } from './parse-map-card.js'
import {
  extractRoleStory,
  parseRoleVoices,
  parseRelicPiece,
  parseWeaponStory
} from './parse-entities.js'
import { buildBookTextFromEntryPage, extractBookDescriptionFromEntryPage } from './inbox-books.js'

function stableHash(value) {
  return createHash('sha1').update(JSON.stringify(value || null)).digest('hex')
}

const CARD_EXCLUDE_NAMES = new Set(['本期规则', '演出奖励'])
const CARD_NUMERAL_VALUES = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
  十一: 11,
  十二: 12,
  十三: 13,
  十四: 14,
  十五: 15,
  十六: 16,
  十七: 17,
  十八: 18,
  十九: 19,
  二十: 20,
  二十一: 21,
  二十二: 22
}

function getCardOrder(name = '') {
  const match = String(name || '').match(/月谕圣牌[·・](.+?)[·・]/)
  return CARD_NUMERAL_VALUES[match?.[1]] || 999
}

function sortCardItems(items = []) {
  items.sort((a, b) => getCardOrder(a.name) - getCardOrder(b.name) || String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN') || String(a.id).localeCompare(String(b.id)))
}

function pickTravelerStable(map, item) {
  const cur = map.get('旅行者')
  if (!cur) return map.set('旅行者', item)
  const a = Number(cur.id || 0)
  const b = Number(item.id || 0)
  if (!a || (b && b < a)) map.set('旅行者', item)
}

async function fetchRoleStoryAll({ onProgress, onError, dryRun = false, deepCompare = false } = {}) {
  await ensureDirs()
  const roleMap = new Map()
  let travelerItem = null
  const oldIndex = await loadStoryIndex()
  const oldMetaMap = new Map((oldIndex.roles || []).map(item => [String(item.id || ''), item]))

  for (let page = 1; page <= 20; page++) {
    const j = await fetchSelectorPage({ channelId: 25, page, label: `角色故事列表第 ${page} 页` })
    const list = j?.data?.list || []
    if (!list.length) break

    for (const it of list) {
      const name = (it.title || it.name || '').trim()
      if (!name) continue
      if (name.includes('旅行者')) {
        if (!travelerItem) travelerItem = it
        else {
          const a = Number(travelerItem.id || 0)
          const b = Number(it.id || 0)
          if (!a || (b && b < a)) travelerItem = it
        }
        continue
      }
      const id = String(it.id || '').trim()
      if (id) roleMap.set(id, it)
    }
  }
  if (travelerItem) roleMap.set(String(travelerItem.id || 'traveler'), travelerItem)

  const currentIds = new Set([...roleMap.values()].map(it => String(it.id || '')))
  const removed = (oldIndex.roles || []).filter(item => !currentIds.has(String(item.id || '')))
  if (!deepCompare) {
    const changedItems = []
    const roles = []
    for (const it of roleMap.values()) {
      const roleName = (it.title || it.name || '').trim()
      const id = String(it.id)
      const sig = selectorSignature(it)
      const prev = oldMetaMap.get(id)
      const filePath = path.join(storyRoot, `${slugify(roleName)}.json`)
      const schemaMismatch = hasUsableMeta(prev, filePath) && prev.schemaVersion !== ROLE_STORY_SCHEMA_VERSION
      const canReuse = hasUsableMeta(prev, filePath) &&
        prev.schemaVersion === ROLE_STORY_SCHEMA_VERSION
      if (canReuse) roles.push({ ...prev, name: roleName, alias: [normalizeRoleName(roleName)], selectorSig: sig, schemaVersion: ROLE_STORY_SCHEMA_VERSION })
      else changedItems.push({ roleName, id, sig, filePath, schemaMismatch })
    }
    if (dryRun) {
      if (changedItems.some(item => item.schemaMismatch)) return { total: roleMap.size, updated: changedItems.length }
      const effectiveChanged = []
      for (const itemInfo of changedItems) {
        try {
          const page = await fetchEntryPageById(itemInfo.id)
          const ext = extractRoleStory(page || {})
          if (ext.detail || ext.stories?.length || ext.others?.length) effectiveChanged.push(itemInfo)
        } catch (error) {
          await emitProgress(onError, { type: 'role', done: effectiveChanged.length + 1, total: changedItems.length, name: itemInfo.roleName, error })
        }
      }
      return { total: roleMap.size, updated: effectiveChanged.length }
    }

    const total = changedItems.length
    let done = 0
    let saved = 0
    for (const itemInfo of changedItems) {
      const { roleName, id, sig, filePath } = itemInfo
      try {
        const page = await fetchEntryPageById(id)
        if (page) {
          const ext = extractRoleStory(page)
          const detail = ext.detail || ''
          const detailHtml = ext.detailHtml || ''
          const stories = ext.stories || []
          const others = ext.others || []
          if (detail || stories.length || others.length) {
            const item = { id, name: roleName, alias: [normalizeRoleName(roleName)], detail, detailHtml, stories, others }
            await fs.writeFile(filePath, JSON.stringify(item, null, 2), 'utf8')
            roles.push({
              id,
              name: roleName,
              alias: item.alias,
              storyCount: stories.length,
              otherCount: others.length,
              selectorSig: sig,
              schemaVersion: ROLE_STORY_SCHEMA_VERSION,
              contentHash: stableHash({ detail, detailHtml, stories, others })
            })
            saved += 1
          }
        }
      } catch (error) {
        await emitProgress(onError, { type: 'role', done: done + 1, total, name: roleName, error })
      }
      done += 1
      if (total && (done % 100 === 0 || done === total)) await emitProgress(onProgress, { type: 'role', done, total })
    }

    roles.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    const roleIds = new Set(roles.map(x => String(x.id || '')))
    for (const old of (oldIndex.roles || [])) {
      const id = String(old.id || '')
      if (!id || roleIds.has(id)) continue
      const fp = path.join(storyRoot, `${slugify(old.name || '')}.json`)
      if (fss.existsSync(fp)) roles.push(old)
    }
    roles.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    await fs.writeFile(storyIndexFile, JSON.stringify({ roles, updatedAt: Date.now() }, null, 2), 'utf8')
    return { total: roles.length, updated: saved }
  }

  const roles = []
  const allItems = [...roleMap.values()]
  const total = allItems.length
  let done = 0
  let updated = 0
  for (const it of allItems) {
    const roleName = (it.title || it.name || '').trim()
    const id = String(it.id)
    const sig = selectorSignature(it)
    const prev = oldMetaMap.get(id)
    const filePath = path.join(storyRoot, `${slugify(roleName)}.json`)
    try {
      const page = await fetchEntryPageById(id)
      if (page) {
        const ext = extractRoleStory(page)
        const detail = ext.detail || ''
        const detailHtml = ext.detailHtml || ''
        const stories = ext.stories || []
        const others = ext.others || []
        const contentHash = stableHash({ detail, detailHtml, stories, others })

        if (detail || stories.length || others.length) {
          const changed = !prev || prev.contentHash !== contentHash || !hasUsableMeta(prev, filePath) || prev.schemaVersion !== ROLE_STORY_SCHEMA_VERSION
          if (changed) updated += 1
          const item = {
            id,
            name: roleName,
            alias: [normalizeRoleName(roleName)],
            detail,
            detailHtml,
            stories,
            others
          }
          if (!dryRun) await fs.writeFile(filePath, JSON.stringify(item, null, 2), 'utf8')
          roles.push({
            id,
            name: roleName,
            alias: item.alias,
            storyCount: stories.length,
            otherCount: others.length,
            selectorSig: sig,
            schemaVersion: ROLE_STORY_SCHEMA_VERSION,
            contentHash
          })
        }
      }
    } catch (error) {
      await emitProgress(onError, { type: 'role', done: done + 1, total, name: (it.title || it.name || '').trim(), error })
    }
    done += 1
    if (total && (done % 100 === 0 || done === total)) await emitProgress(onProgress, { type: 'role', done, total })
  }
  if (dryRun) return { total: roleMap.size, updated: updated }

  roles.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  const roleIds = new Set(roles.map(x => String(x.id || '')))
  for (const old of (oldIndex.roles || [])) {
    const id = String(old.id || '')
    if (!id || roleIds.has(id)) continue
    const fp = path.join(storyRoot, `${slugify(old.name || '')}.json`)
    if (fss.existsSync(fp)) roles.push(old)
  }
  roles.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  await fs.writeFile(storyIndexFile, JSON.stringify({ roles, updatedAt: Date.now() }, null, 2), 'utf8')
  return { total: roles.length, updated: updated }
}

async function fetchRelicAll({ onProgress, onError, dryRun = false } = {}) {
  await ensureDirs()
  const setMap = new Map()
  const oldIndex = await loadRelicIndex()
  const oldMetaMap = new Map((oldIndex.sets || []).map(item => [String(item.id || ''), item]))
  for (let page = 1; page <= 20; page++) {
    const j = await fetchSelectorPage({ channelId: 218, page, label: `圣遗物列表第 ${page} 页` })
    const list = j?.data?.list || []
    if (!list.length) break
    for (const it of list) {
      const name = (it.title || it.name || '').trim()
      if (!name) continue
      setMap.set(name, it)
    }
  }

  const removed = (oldIndex.sets || []).filter(item => !setMap.has(item.name))
  const changedItems = []
  const sets = []
  for (const it of setMap.values()) {
    const setName = (it.title || it.name || '').trim()
    const id = String(it.id)
    const sig = selectorSignature(it)
    const prev = oldMetaMap.get(id)
    const filePath = path.join(relicRoot, `${slugify(setName)}.json`)
    const canReuse = hasUsableMeta(prev, filePath) &&
      Number(prev.relicSchemaVersion || 0) === RELIC_TEXT_SCHEMA_VERSION
    if (canReuse) sets.push({ ...prev, name: setName, alias: [normalizeRoleName(setName)], selectorSig: sig, relicSchemaVersion: RELIC_TEXT_SCHEMA_VERSION })
    else changedItems.push({ setName, id, sig, filePath })
  }
  if (dryRun) return { total: setMap.size, updated: changedItems.length }

  const total = changedItems.length
  let done = 0
  let saved = 0
  for (const itemInfo of changedItems) {
    const { setName, id, sig, filePath } = itemInfo
    try {
      const page = await fetchEntryPageById(id)
      if (page) {
        const modules = page.modules || []
        const pieces = []
        for (const m of modules) {
          const p = parseRelicPiece(m)
          if (p && p.name) pieces.push(p)
        }

        if (pieces.length) {
          const item = { id, name: setName, alias: [normalizeRoleName(setName)], pieces }
          await fs.writeFile(filePath, JSON.stringify(item, null, 2), 'utf8')
          sets.push({ id, name: setName, alias: item.alias, pieceCount: pieces.length, selectorSig: sig, relicSchemaVersion: RELIC_TEXT_SCHEMA_VERSION })
          saved += 1
        }
      }
    } catch (error) {
      await emitProgress(onError, { type: 'relic', done: done + 1, total, name: setName, error })
    }
    done += 1
    if (total && (done % 100 === 0 || done === total)) await emitProgress(onProgress, { type: 'relic', done, total })
  }

  sets.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  await fs.writeFile(relicIndexFile, JSON.stringify({ sets, updatedAt: Date.now() }, null, 2), 'utf8')
  return { total: sets.length, updated: saved }
}

async function fetchWeaponAll({ onProgress, onError, dryRun = false } = {}) {
  await ensureDirs()
  const map = new Map()
  const oldIndex = await loadWeaponIndex()
  const oldMetaMap = new Map((oldIndex.weapons || []).map(item => [String(item.id || ''), item]))
  for (let page = 1; page <= 20; page++) {
    const j = await fetchSelectorPage({ channelId: 5, page, label: `武器故事列表第 ${page} 页` })
    const list = j?.data?.list || []
    if (!list.length) break
    for (const it of list) {
      const name = (it.title || it.name || '').trim()
      if (name) map.set(name, it)
    }
  }

  const removed = (oldIndex.weapons || []).filter(item => !map.has(item.name))
  const changedItems = []
  const weapons = []
  for (const it of map.values()) {
    const name = (it.title || it.name || '').trim()
    const id = String(it.id)
    const sig = selectorSignature(it)
    const prev = oldMetaMap.get(id)
    const filePath = path.join(weaponRoot, `${slugify(name)}.json`)
    const schemaMismatch = hasUsableMeta(prev, filePath) && Number(prev.weaponSchemaVersion || 0) !== WEAPON_TEXT_SCHEMA_VERSION
    const canReuse = hasUsableMeta(prev, filePath) &&
      Number(prev.weaponSchemaVersion || 0) === WEAPON_TEXT_SCHEMA_VERSION
    if (canReuse) weapons.push({ ...prev, name, alias: [normalizeRoleName(name)], selectorSig: sig, weaponSchemaVersion: WEAPON_TEXT_SCHEMA_VERSION })
    else changedItems.push({ name, id, sig, filePath, schemaMismatch })
  }
  if (dryRun) {
    if (changedItems.some(item => item.schemaMismatch)) return { total: map.size, updated: changedItems.length }
    const effectiveChanged = []
    for (const itemInfo of changedItems) {
      try {
        const page = await fetchEntryPageById(itemInfo.id)
        const weaponStory = parseWeaponStory(page || {})
        if (weaponStory.story) effectiveChanged.push(itemInfo)
      } catch (error) {
        await emitProgress(onError, { type: 'weapon', done: effectiveChanged.length + 1, total: changedItems.length, name: itemInfo.name, error })
      }
    }
    return { total: map.size, updated: effectiveChanged.length }
  }

  const total = changedItems.length
  let done = 0
  let saved = 0
  for (const itemInfo of changedItems) {
    const { name, id, sig, filePath } = itemInfo
    try {
      const page = await fetchEntryPageById(id)
      if (page) {
        const weaponStory = parseWeaponStory(page)
        if (weaponStory.story) {
          const item = { id, name, alias: [normalizeRoleName(name)], story: weaponStory.story, storyHtml: weaponStory.storyHtml || '' }
          await fs.writeFile(filePath, JSON.stringify(item, null, 2), 'utf8')
          weapons.push({ id, name, alias: item.alias, selectorSig: sig, weaponSchemaVersion: WEAPON_TEXT_SCHEMA_VERSION })
          saved += 1
        }
      }
    } catch (error) {
      await emitProgress(onError, { type: 'weapon', done: done + 1, total, name, error })
    }
    done += 1
    if (total && (done % 100 === 0 || done === total)) await emitProgress(onProgress, { type: 'weapon', done, total })
  }

  weapons.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  await fs.writeFile(weaponIndexFile, JSON.stringify({ weapons, updatedAt: Date.now() }, null, 2), 'utf8')
  return { total: weapons.length, updated: saved }
}

async function fetchPlotAll({ onProgress, onError, dryRun = false } = {}) {
  await ensureDirs()
  const pipelineState = await loadPipelineState()
  const map = new Map()
  const oldIndex = await loadPlotIndex()
  const oldMetaMap = new Map((oldIndex.items || []).map(item => [String(item.id || ''), item]))
  for (let page = 1; page <= 50; page++) {
    const j = await fetchSelectorPage({ channelId: 43, page, label: `剧情文本列表第 ${page} 页` })
    const list = j?.data?.list || []
    if (!list.length) break
    for (const it of list) {
      const id = String(it.id || '').trim()
      if (id) map.set(id, it)
    }
  }

  const removed = (oldIndex.items || []).filter(item => !map.has(String(item.id || '')))
  const changedItems = []
  const items = []
  const misses = []
  for (const it of map.values()) {
    const name = (it.title || it.name || '').trim() || `未命名任务-${it.id}`
    const id = String(it.id)
    const fileName = buildPlotFileName(name, id)
    const file = path.join(plotRoot, fileName)
    const sig = selectorSignature(it)
    const prev = oldMetaMap.get(id)
    const prevFile = prev?.file ? path.join(plotRoot, prev.file) : ''
    const schemaMismatch = hasUsableMeta(prev, prevFile) && Number(prev.plotSchemaVersion || 0) !== PLOT_TEXT_SCHEMA_VERSION
    const canReuse = hasUsableMeta(prev, prevFile) &&
      Number(prev.plotSchemaVersion || 0) === PLOT_TEXT_SCHEMA_VERSION &&
      selectorSigMatches(prev.selectorSig, it) &&
      interactiveDialogueParseOk(pipelineState, 'plot')
    if (canReuse) {
      if (prev.file && prev.file !== fileName && prevFile && fss.existsSync(prevFile)) {
        await fs.rename(prevFile, file)
      }
      items.push({ ...prev, name, file: fileName, alias: [normalizeRoleName(name)], selectorSig: sig, plotSchemaVersion: PLOT_TEXT_SCHEMA_VERSION })
    } else {
      changedItems.push({ it, name, id, fileName, file, sig, schemaMismatch })
    }
  }
  if (dryRun) {
    if (changedItems.some(item => item.schemaMismatch)) return { total: map.size, updated: changedItems.length }
    const effectiveChanged = []
    for (const itemInfo of changedItems) {
      try {
        const page = await fetchEntryPageById(itemInfo.id)
        if (page) effectiveChanged.push(itemInfo)
      } catch (error) {
        await emitProgress(onError, { type: 'plot', done: effectiveChanged.length + 1, total: changedItems.length, name: itemInfo.name, error })
      }
    }
    return { total: map.size, updated: effectiveChanged.length }
  }

  const total = changedItems.length
  let done = 0
  let saved = 0
  for (const itemInfo of changedItems) {
    const { it, name, id, fileName, file, sig } = itemInfo
    try {
      const page = await fetchEntryPageById(id)
      if (page) {
        const sections = parsePlotPage(page)
        const richSections = parsePlotPageRich(page)
        const searchText = parsePlotSearchText(page)
        const category = parsePlotCategory(it.ext)
        const subtitle = extractPlotSubtitle(page)
        const item = { id, name, file: fileName, alias: [normalizeRoleName(name)], category, subtitle, sections, richSections, searchText }

        if (!sections.length && !searchText) {
          const modules = page.modules || []
          const plotModules = modules
            .map((m, idx) => ({
              idx,
              name: (m.name || '').trim(),
              cids: (m.components || []).map(c => c.component_id || '')
            }))
            .filter(x => x.name === '剧情对话' || x.cids.includes('interactive_dialogue'))

          misses.push({ id, name, category, plotModules })
        }

        await fs.writeFile(file, JSON.stringify(item, null, 2), 'utf8')
        items.push({ id, name, file: fileName, alias: item.alias, category, subtitle, sectionCount: (item.sections || []).length, selectorSig: sig, plotSchemaVersion: PLOT_TEXT_SCHEMA_VERSION })
        saved += 1
      }
    } catch (error) {
      await emitProgress(onError, { type: 'plot', done: done + 1, total, name, error })
    }
    done += 1
    if (total && (done % 100 === 0 || done === total)) await emitProgress(onProgress, { type: 'plot', done, total })
  }

  items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || String(a.id).localeCompare(String(b.id)))
  const itemIds = new Set(items.map(x => String(x.id || '')))
  for (const old of (oldIndex.items || [])) {
    const id = String(old.id || '')
    if (!id || itemIds.has(id)) continue
    const fp = old.file ? path.join(plotRoot, old.file) : ''
    if (fp && fss.existsSync(fp)) items.push(old)
  }
  items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || String(a.id).localeCompare(String(b.id)))
  await fs.writeFile(plotIndexFile, JSON.stringify({ items, updatedAt: Date.now() }, null, 2), 'utf8')
  await fs.writeFile(path.join(plotRoot, '_misses.json'), JSON.stringify({ total: misses.length, misses, updatedAt: Date.now() }, null, 2), 'utf8')
  if (!dryRun) {
    await savePipelineModuleVersion(
      INTERACTIVE_PARSE_PIPELINE_KEYS.plot,
      interactiveDialoguePipelineVersion('plot')
    )
  }
  return { total: items.length, misses: misses.length, updated: saved }
}

async function fetchMapAll({ onProgress, onError, dryRun = false } = {}) {
  await ensureDirs()
  const pipelineState = await loadPipelineState()
  const map = new Map()
  const oldIndex = await loadMapIndex()
  const oldMetaMap = new Map((oldIndex.items || []).map(item => [String(item.id || ''), item]))

  for (let page = 1; page <= 50; page++) {
    const j = await fetchSelectorPage({ channelId: 251, page, label: `地图文本列表第 ${page} 页` })
    const list = j?.data?.list || []
    if (!list.length) break
    for (const it of list) {
      const id = String(it.id || '').trim()
      if (id) map.set(id, it)
    }
  }

  const removed = (oldIndex.items || []).filter(item => !map.has(String(item.id || '')))
  const changedItems = []
  const items = []

  for (const it of map.values()) {
    const name = (it.title || it.name || '').trim() || `未命名地图文本-${it.id}`
    const id = String(it.id)
    const fileName = buildMapFileName(name, id)
    const file = path.join(mapRoot, fileName)
    const sig = selectorSignature(it)
    const prev = oldMetaMap.get(id)
    const prevFile = prev?.file ? path.join(mapRoot, prev.file) : ''
    const schemaMismatch = hasUsableMeta(prev, prevFile) && Number(prev.mapSchemaVersion || 0) !== MAP_TEXT_SCHEMA_VERSION
    const canReuse = hasUsableMeta(prev, prevFile) &&
      Number(prev.mapSchemaVersion || 0) === MAP_TEXT_SCHEMA_VERSION &&
      selectorSigMatches(prev.selectorSig, it) &&
      interactiveDialogueParseOk(pipelineState, 'map')
    if (canReuse) {
      if (prev.file && prev.file !== fileName && prevFile && fss.existsSync(prevFile)) {
        await fs.rename(prevFile, file)
      }
      items.push({ ...prev, name, file: fileName, alias: [normalizeRoleName(name)], selectorSig: sig, mapSchemaVersion: MAP_TEXT_SCHEMA_VERSION })
    } else {
      changedItems.push({ name, id, fileName, file, sig, schemaMismatch })
    }
  }

  if (dryRun) {
    if (changedItems.some(item => item.schemaMismatch)) return { total: map.size, updated: changedItems.length }
    const effectiveChanged = []
    for (const itemInfo of changedItems) {
      try {
        const page = await fetchEntryPageById(itemInfo.id)
        const sections = parseMapPage(page || {})
        const searchText = sections.map(sec => `【${sec.title || '交互文本'}】\n${sec.text || ''}`).join('\n\n').trim()
        if (sections.length || searchText) effectiveChanged.push(itemInfo)
      } catch (error) {
        await emitProgress(onError, { type: 'map', done: effectiveChanged.length + 1, total: changedItems.length, name: itemInfo.name, error })
      }
    }
    return { total: map.size, updated: effectiveChanged.length }
  }

  const total = changedItems.length
  let done = 0
  let saved = 0
  for (const itemInfo of changedItems) {
    const { name, id, fileName, file, sig } = itemInfo
    try {
      const page = await fetchEntryPageById(id)
      if (page) {
        const sections = parseMapPage(page)
        const searchText = sections.map(sec => `【${sec.title || '交互文本'}】\n${sec.text || ''}`).join('\n\n').trim()
        if (sections.length || searchText) {
          const item = { id, name, file: fileName, alias: [normalizeRoleName(name)], sections, searchText }
          await fs.writeFile(file, JSON.stringify(item, null, 2), 'utf8')
          items.push({
            id,
            name,
            file: fileName,
            alias: item.alias,
            sectionCount: sections.length,
            selectorSig: sig,
            mapSchemaVersion: MAP_TEXT_SCHEMA_VERSION
          })
          saved += 1
        }
      }
    } catch (error) {
      await emitProgress(onError, { type: 'map', done: done + 1, total, name, error })
    }
    done += 1
    if (total && (done % 100 === 0 || done === total)) await emitProgress(onProgress, { type: 'map', done, total })
  }

  items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || String(a.id).localeCompare(String(b.id)))
  await fs.writeFile(mapIndexFile, JSON.stringify({ items, updatedAt: Date.now() }, null, 2), 'utf8')
  if (!dryRun) {
    await savePipelineModuleVersion(
      INTERACTIVE_PARSE_PIPELINE_KEYS.map,
      interactiveDialoguePipelineVersion('map')
    )
  }
  return { total: items.length, updated: saved }
}

async function fetchAnecdoteAll({ onProgress, onError, dryRun = false } = {}) {
  await ensureDirs()
  const pipelineState = await loadPipelineState()
  const map = new Map()
  const oldIndex = await loadAnecdoteIndex()
  const oldMetaMap = new Map((oldIndex.items || []).map(item => [String(item.id || ''), item]))
  for (let page = 1; page <= 50; page++) {
    const j = await fetchSelectorPage({ channelId: 261, page, label: `角色逸闻列表第 ${page} 页` })
    const list = j?.data?.list || []
    if (!list.length) break
    for (const it of list) {
      const id = String(it.id || '').trim()
      if (id) map.set(id, it)
    }
  }

  const removed = (oldIndex.items || []).filter(item => !map.has(String(item.id || '')))
  const changedItems = []
  const items = []

  for (const it of map.values()) {
    const name = (it.title || it.name || '').trim() || `未命名逸闻-${it.id}`
    const id = String(it.id)
    const fileName = buildAnecdoteFileName(name, id)
    const file = path.join(anecdoteRoot, fileName)
    const sig = selectorSignature(it)
    const prev = oldMetaMap.get(id)
    const prevFile = prev?.file ? path.join(anecdoteRoot, prev.file) : ''
    const schemaMismatch = hasUsableMeta(prev, prevFile) && Number(prev.anecdoteSchemaVersion || 0) !== ANECDOTE_TEXT_SCHEMA_VERSION
    const canReuse = hasUsableMeta(prev, prevFile) &&
      Number(prev.anecdoteSchemaVersion || 0) === ANECDOTE_TEXT_SCHEMA_VERSION &&
      selectorSigMatches(prev.selectorSig, it) &&
      interactiveDialogueParseOk(pipelineState, 'anecdote')
    if (canReuse) {
      if (prev.file && prev.file !== fileName && prevFile && fss.existsSync(prevFile)) await fs.rename(prevFile, file)
      items.push({ ...prev, name, file: fileName, alias: [normalizeRoleName(name)], selectorSig: sig, anecdoteSchemaVersion: ANECDOTE_TEXT_SCHEMA_VERSION })
    } else {
      changedItems.push({ name, id, fileName, file, sig, schemaMismatch })
    }
  }

  if (dryRun) {
    if (changedItems.some(item => item.schemaMismatch)) return { total: map.size, updated: changedItems.length }
    const effectiveChanged = []
    for (const itemInfo of changedItems) {
      try {
        const page = await fetchEntryPageById(itemInfo.id)
        const sections = parseAnecdotePage(page || {})
        const searchText = sections.map(sec => `【${sec.title || '文本'}】\n${sec.text || ''}`).join('\n\n').trim()
        if (sections.length || searchText) effectiveChanged.push(itemInfo)
      } catch (error) {
        await emitProgress(onError, { type: 'anecdote', done: effectiveChanged.length + 1, total: changedItems.length, name: itemInfo.name, error })
      }
    }
    return { total: map.size, updated: effectiveChanged.length }
  }

  const total = changedItems.length
  let done = 0
  let saved = 0
  for (const itemInfo of changedItems) {
    const { name, id, fileName, file, sig } = itemInfo
    try {
      const page = await fetchEntryPageById(id)
      if (page) {
        const sections = parseAnecdotePage(page)
        const searchText = sections.map(sec => `【${sec.title || '文本'}】\n${sec.text || ''}`).join('\n\n').trim()
        if (sections.length || searchText) {
          const data = { id, name, file: fileName, alias: [normalizeRoleName(name)], sections, searchText }
          await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8')
          items.push({ id, name, file: fileName, alias: data.alias, sectionCount: sections.length, selectorSig: sig, anecdoteSchemaVersion: ANECDOTE_TEXT_SCHEMA_VERSION })
          saved += 1
        }
      }
    } catch (error) {
      await emitProgress(onError, { type: 'anecdote', done: done + 1, total, name, error })
    }
    done += 1
    if (total && (done % 100 === 0 || done === total)) await emitProgress(onProgress, { type: 'anecdote', done, total })
  }

  items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || String(a.id).localeCompare(String(b.id)))
  await fs.writeFile(anecdoteIndexFile, JSON.stringify({ items, updatedAt: Date.now() }, null, 2), 'utf8')
  if (!dryRun) {
    await savePipelineModuleVersion(
      INTERACTIVE_PARSE_PIPELINE_KEYS.anecdote,
      interactiveDialoguePipelineVersion('anecdote')
    )
  }
  return { total: items.length, updated: saved }
}

async function fetchCardAll({ onProgress, onError, dryRun = false } = {}) {
  await ensureDirs()
  const map = new Map()
  const oldIndex = await loadCardIndex()
  const oldMetaMap = new Map((oldIndex.items || []).map(item => [String(item.id || ''), item]))
  for (let page = 1; page <= 50; page++) {
    const j = await fetchSelectorPage({ channelId: 249, page, label: `月谕圣牌列表第 ${page} 页` })
    const list = j?.data?.list || []
    if (!list.length) break
    for (const it of list) {
      const id = String(it.id || '').trim()
      if (id) map.set(id, it)
    }
  }

  const removed = (oldIndex.items || []).filter(item => !map.has(String(item.id || '')))
  const changedItems = []
  const items = []

  for (const it of map.values()) {
    const name = (it.title || it.name || '').trim() || `未命名圣牌-${it.id}`
    if (CARD_EXCLUDE_NAMES.has(name)) continue
    const id = String(it.id)
    const fileName = buildCardFileName(name, id)
    const file = path.join(cardRoot, fileName)
    const sig = selectorSignature(it)
    const prev = oldMetaMap.get(id)
    const prevFile = prev?.file ? path.join(cardRoot, prev.file) : ''
    const schemaMismatch = hasUsableMeta(prev, prevFile) && Number(prev.cardSchemaVersion || 0) !== CARD_TEXT_SCHEMA_VERSION
    const canReuse = hasUsableMeta(prev, prevFile) &&
      Number(prev.cardSchemaVersion || 0) === CARD_TEXT_SCHEMA_VERSION
    if (canReuse) {
      if (prev.file && prev.file !== fileName && prevFile && fss.existsSync(prevFile)) await fs.rename(prevFile, file)
      items.push({ ...prev, name, file: fileName, alias: [normalizeRoleName(name)], selectorSig: sig, cardSchemaVersion: CARD_TEXT_SCHEMA_VERSION })
    } else {
      changedItems.push({ name, id, fileName, file, sig, schemaMismatch })
    }
  }

  if (dryRun) {
    if (changedItems.some(item => item.schemaMismatch)) return { total: map.size - CARD_EXCLUDE_NAMES.size, updated: changedItems.length }
    const effectiveChanged = []
    for (const itemInfo of changedItems) {
      try {
        const page = await fetchEntryPageById(itemInfo.id)
        const sections = parseCardPage(page || {})
        if (sections.length) effectiveChanged.push(itemInfo)
      } catch (error) {
        await emitProgress(onError, { type: 'card', done: effectiveChanged.length + 1, total: changedItems.length, name: itemInfo.name, error })
      }
    }
    return { total: map.size - CARD_EXCLUDE_NAMES.size, updated: effectiveChanged.length }
  }

  const total = changedItems.length
  let done = 0
  let saved = 0
  for (const itemInfo of changedItems) {
    const { name, id, fileName, file, sig } = itemInfo
    try {
      const page = await fetchEntryPageById(id)
      if (page) {
        const sections = parseCardPage(page)
        const searchText = sections.map(sec => `【${sec.title || '文本'}】\n${sec.text || ''}`).join('\n\n').trim()
        if (sections.length || searchText) {
          const data = { id, name, file: fileName, alias: [normalizeRoleName(name)], sections, searchText }
          await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8')
          items.push({ id, name, file: fileName, alias: data.alias, sectionCount: sections.length, selectorSig: sig, cardSchemaVersion: CARD_TEXT_SCHEMA_VERSION })
          saved += 1
        }
      }
    } catch (error) {
      await emitProgress(onError, { type: 'card', done: done + 1, total, name, error })
    }
    done += 1
    if (total && (done % 100 === 0 || done === total)) await emitProgress(onProgress, { type: 'card', done, total })
  }

  sortCardItems(items)
  await fs.writeFile(cardIndexFile, JSON.stringify({ items, updatedAt: Date.now() }, null, 2), 'utf8')
  return { total: items.length, updated: saved }
}

async function fetchBackpackAll({ onProgress, onError, dryRun = false } = {}) {
  await ensureDirs()
  const map = new Map()
  const oldIndex = await loadBackpackIndex()
  const oldMetaMap = new Map((oldIndex.items || []).map(item => [String(item.id || ''), item]))
  for (let page = 1; page <= 50; page++) {
    const j = await fetchSelectorPage({ channelId: 13, page, label: `背包列表第 ${page} 页` })
    const list = j?.data?.list || []
    if (!list.length) break
    for (const it of list) {
      const id = String(it.id || '').trim()
      if (id) map.set(id, it)
    }
  }

  const removed = (oldIndex.items || []).filter(item => !map.has(String(item.id || '')))
  const changedItems = []
  const items = []
  for (const it of map.values()) {
    const name = (it.title || it.name || '').trim() || `未命名背包-${it.id}`
    const id = String(it.id)
    const fileName = buildBackpackFileName(name, id)
    const file = path.join(backpackRoot, fileName)
    const sig = selectorSignature(it)
    const prev = oldMetaMap.get(id)
    const prevFile = prev?.file ? path.join(backpackRoot, prev.file) : ''
    const schemaMismatch = hasUsableMeta(prev, prevFile) && Number(prev.backpackSchemaVersion || 0) !== BACKPACK_TEXT_SCHEMA_VERSION
    const canReuse = hasUsableMeta(prev, prevFile) &&
      Number(prev.backpackSchemaVersion || 0) === BACKPACK_TEXT_SCHEMA_VERSION &&
      selectorSigMatches(prev.selectorSig, it)
    if (canReuse) {
      if (prev.file && prev.file !== fileName && prevFile && fss.existsSync(prevFile)) await fs.rename(prevFile, file)
      items.push({ ...prev, name, file: fileName, alias: [normalizeRoleName(name)], selectorSig: sig, backpackSchemaVersion: BACKPACK_TEXT_SCHEMA_VERSION })
    } else {
      changedItems.push({ name, id, fileName, file, sig, schemaMismatch })
    }
  }

  if (dryRun) {
    if (changedItems.some(item => item.schemaMismatch)) return { total: map.size, updated: changedItems.length }
    const effectiveChanged = []
    for (const itemInfo of changedItems) {
      try {
        const page = await fetchEntryPageById(itemInfo.id)
        const parsed = parseBackpackPage(page || {})
        const desc = parsed.desc || ''
        const descHtml = parsed.descHtml || ''
        const sections = parsed.sections || []
        const imageUrls = [...new Set(sections.flatMap(sec => sec.images || []))]
        const searchText = [
          desc,
          sections.map(sec => `【${sec.title || '正文'}】\n${sec.text || ''}`).join('\n\n')
        ].filter(Boolean).join('\n\n').trim()
        if ((parsed.name || itemInfo.name) && (searchText || imageUrls.length)) effectiveChanged.push(itemInfo)
      } catch (error) {
        await emitProgress(onError, { type: 'backpack', done: effectiveChanged.length + 1, total: changedItems.length, name: itemInfo.name, error })
      }
    }
    return { total: map.size, updated: effectiveChanged.length }
  }

  const total = changedItems.length
  let done = 0
  let saved = 0
  for (const itemInfo of changedItems) {
    const { name, id, fileName, file, sig } = itemInfo
    try {
      const page = await fetchEntryPageById(id)
      if (page) {
        const parsed = parseBackpackPage(page)
        const finalName = parsed.name || name
        const desc = parsed.desc || ''
        const descHtml = parsed.descHtml || ''
        const sections = parsed.sections || []
        const imageUrls = [...new Set(sections.flatMap(sec => sec.images || []))]
        const searchText = [
          desc,
          sections.map(sec => `【${sec.title || '正文'}】\n${sec.text || ''}`).join('\n\n')
        ].filter(Boolean).join('\n\n').trim()
        if (finalName && (searchText || imageUrls.length)) {
          const contentHash = stableHash({ desc, descHtml, sections })
          const data = { id, name: finalName, file: fileName, alias: [normalizeRoleName(finalName)], desc, descHtml, sections, imageUrls, searchText }
          await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf8')
          items.push({
            id,
            name: finalName,
            file: fileName,
            alias: data.alias,
            sectionCount: sections.length,
            imageCount: imageUrls.length,
            selectorSig: sig,
            backpackSchemaVersion: BACKPACK_TEXT_SCHEMA_VERSION,
            contentHash
          })
          saved += 1
        }
      }
    } catch (error) {
      await emitProgress(onError, { type: 'backpack', done: done + 1, total, name, error })
    }
    done += 1
    if (total && (done % 100 === 0 || done === total)) await emitProgress(onProgress, { type: 'backpack', done, total })
  }

  items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || String(a.id).localeCompare(String(b.id)))
  const itemIds = new Set(items.map(x => String(x.id || '')))
  for (const old of (oldIndex.items || [])) {
    const id = String(old.id || '')
    if (!id || itemIds.has(id)) continue
    const fp = old.file ? path.join(backpackRoot, old.file) : ''
    if (fp && fss.existsSync(fp)) items.push(old)
  }
  items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || String(a.id).localeCompare(String(b.id)))
  await fs.writeFile(backpackIndexFile, JSON.stringify({ items, updatedAt: Date.now() }, null, 2), 'utf8')
  return { total: items.length, updated: saved }
}

async function fetchVoiceAll({ onProgress, onError, dryRun = false, deepCompare = false } = {}) {
  await ensureDirs()
  const roleMap = new Map()
  let travelerItem = null
  const oldIndex = await loadVoiceIndex()
  const oldMetaMap = new Map((oldIndex.roles || []).map(item => [String(item.id || ''), item]))
  for (let page = 1; page <= 20; page++) {
    const j = await fetchSelectorPage({ channelId: 25, page, label: `角色语音列表第 ${page} 页` })
    const list = j?.data?.list || []
    if (!list.length) break
    for (const it of list) {
      const name = (it.title || it.name || '').trim()
      if (!name) continue
      if (name.includes('旅行者')) {
        if (!travelerItem) travelerItem = it
        else {
          const a = Number(travelerItem.id || 0)
          const b = Number(it.id || 0)
          if (!a || (b && b < a)) travelerItem = it
        }
        continue
      }
      const id = String(it.id || '').trim()
      if (id) roleMap.set(id, it)
    }
  }
  if (travelerItem) roleMap.set(String(travelerItem.id || 'traveler'), travelerItem)

  const currentIds = new Set([...roleMap.values()].map(it => String(it.id || '')))
  const removed = (oldIndex.roles || []).filter(item => !currentIds.has(String(item.id || '')))
  if (!deepCompare) {
    const changedItems = []
    const roles = []
    for (const it of roleMap.values()) {
      const roleName = (it.title || it.name || '').trim()
      const id = String(it.id)
      const sig = selectorSignature(it)
      const prev = oldMetaMap.get(id)
      const filePath = path.join(voiceRoot, `${slugify(roleName)}.json`)
      const canReuse = hasUsableMeta(prev, filePath) && selectorSigMatches(prev.selectorSig, it)
      if (canReuse) roles.push({ ...prev, name: roleName, alias: [normalizeRoleName(roleName)], selectorSig: sig })
      else changedItems.push({ roleName, id, sig, filePath })
    }
    if (dryRun) {
      const effectiveChanged = []
      for (const itemInfo of changedItems) {
        try {
          const page = await fetchEntryPageById(itemInfo.id)
          const tabs = parseRoleVoices(page || {})
          if (tabs.length) effectiveChanged.push(itemInfo)
        } catch (error) {
          await emitProgress(onError, { type: 'voice', done: effectiveChanged.length + 1, total: changedItems.length, name: itemInfo.roleName, error })
        }
      }
      return { total: roleMap.size, updated: effectiveChanged.length }
    }

    const total = changedItems.length
    let done = 0
    let saved = 0
    for (const itemInfo of changedItems) {
      const { roleName, id, sig, filePath } = itemInfo
      try {
        const page = await fetchEntryPageById(id)
        if (page) {
          const tabs = parseRoleVoices(page)
          if (tabs.length) {
            const item = { id, name: roleName, alias: [normalizeRoleName(roleName)], tabs }
            await fs.writeFile(filePath, JSON.stringify(item, null, 2), 'utf8')
            roles.push({
              id,
              name: roleName,
              alias: item.alias,
              langCount: tabs.length,
              itemCount: tabs.reduce((sum, t) => sum + (t.items || []).length, 0),
              selectorSig: sig,
              contentHash: stableHash(tabs)
            })
            saved += 1
          }
        }
      } catch (error) {
        await emitProgress(onError, { type: 'voice', done: done + 1, total, name: roleName, error })
      }
      done += 1
      if (total && (done % 100 === 0 || done === total)) await emitProgress(onProgress, { type: 'voice', done, total })
    }

    roles.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    const voiceRoleIds = new Set(roles.map(x => String(x.id || '')))
    for (const old of (oldIndex.roles || [])) {
      const id = String(old.id || '')
      if (!id || voiceRoleIds.has(id)) continue
      const fp = path.join(voiceRoot, `${slugify(old.name || '')}.json`)
      if (fss.existsSync(fp)) roles.push(old)
    }
    roles.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    await fs.writeFile(voiceIndexFile, JSON.stringify({ roles, updatedAt: Date.now() }, null, 2), 'utf8')
    return { total: roles.length, updated: saved }
  }

  const roles = []
  const allItems = [...roleMap.values()]
  const total = allItems.length
  let done = 0
  let updated = 0
  for (const it of allItems) {
    const roleName = (it.title || it.name || '').trim()
    const id = String(it.id)
    const sig = selectorSignature(it)
    const prev = oldMetaMap.get(id)
    const filePath = path.join(voiceRoot, `${slugify(roleName)}.json`)
    try {
      const page = await fetchEntryPageById(id)
      if (page) {
        const tabs = parseRoleVoices(page)
        if (tabs.length) {
          const contentHash = stableHash(tabs)
          const changed = !prev || prev.contentHash !== contentHash || !hasUsableMeta(prev, filePath)
          if (changed) updated += 1
          const item = { id, name: roleName, alias: [normalizeRoleName(roleName)], tabs }
          if (!dryRun) await fs.writeFile(filePath, JSON.stringify(item, null, 2), 'utf8')
          roles.push({
            id,
            name: roleName,
            alias: item.alias,
            langCount: tabs.length,
            itemCount: tabs.reduce((sum, t) => sum + (t.items || []).length, 0),
            selectorSig: sig,
            contentHash
          })
        }
      }
    } catch (error) {
      await emitProgress(onError, { type: 'voice', done: done + 1, total, name: roleName, error })
    }
    done += 1
    if (total && (done % 100 === 0 || done === total)) await emitProgress(onProgress, { type: 'voice', done, total })
  }
  if (dryRun) return { total: roles.length, updated: updated }

  roles.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  const voiceRoleIds = new Set(roles.map(x => String(x.id || '')))
  for (const old of (oldIndex.roles || [])) {
    const id = String(old.id || '')
    if (!id || voiceRoleIds.has(id)) continue
    const fp = path.join(voiceRoot, `${slugify(old.name || '')}.json`)
    if (fss.existsSync(fp)) roles.push(old)
  }
  roles.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  await fs.writeFile(voiceIndexFile, JSON.stringify({ roles, updatedAt: Date.now() }, null, 2), 'utf8')
  return { total: roles.length, updated: updated }
}

async function fetchBooksFromWiki({ onProgress, onError, dryRun = false } = {}) {
  await ensureDirs()
  const map = new Map()
  const oldIndex = await loadIndex()
  const oldMetaMap = new Map((oldIndex.books || []).map(item => [String(item.source || '').replace(/^wiki:/, ''), item]))
  for (let page = 1; page <= 20; page++) {
    const j = await fetchSelectorPage({ channelId: 68, page, label: `书籍列表第 ${page} 页` })
    const list = j?.data?.list || []
    if (!list.length) break
    for (const it of list) {
      const name = (it.title || it.name || '').trim()
      if (name) map.set(name, it)
    }
  }

  const removed = (oldIndex.books || []).filter(item => {
    const id = String(item.source || '').replace(/^wiki:/, '')
    return ![...map.values()].some(it => String(it.id) === id)
  })
  const changedItems = []
  const index = { books: [] }
  for (const it of map.values()) {
    const name = (it.title || it.name || '').trim()
    const id = String(it.id)
    const sig = selectorSignature(it)
    const prev = oldMetaMap.get(id)
    const out = `${slugify(name)}.txt`
    const filePath = path.join(booksRoot, out)
    const prevFile = prev?.file ? path.join(booksRoot, prev.file) : ''
    const canReuse = prev &&
      prevFile &&
      fss.existsSync(prevFile) &&
      selectorSigMatches(prev.selectorSig, it) &&
      Number(prev.bookSchemaVersion || 0) === BOOK_TEXT_SCHEMA_VERSION
    if (canReuse) {
      if (prev.file && prev.file !== out && prevFile && fss.existsSync(prevFile)) {
        await fs.rename(prevFile, filePath)
      }
      index.books.push({
        ...prev,
        title: name,
        file: out,
        source: `wiki:${id}`,
        selectorSig: sig,
        desc: prev.desc || '',
        bookSchemaVersion: BOOK_TEXT_SCHEMA_VERSION
      })
    } else {
      changedItems.push({ name, id, filePath, out, sig })
    }
  }
  if (dryRun) return { total: map.size, updated: changedItems.length }

  const total = changedItems.length
  let done = 0
  let saved = 0
  for (const itemInfo of changedItems) {
    const { name, id, filePath, out, sig } = itemInfo
    try {
      const page = await fetchEntryPageById(id)
      if (page) {
        const desc = extractBookDescriptionFromEntryPage(page)
        const text = await buildBookTextFromEntryPage(page)
        if (text) {
          await fs.writeFile(filePath, text, 'utf8')
          index.books.push({
            title: name,
            file: out,
            source: `wiki:${id}`,
            selectorSig: sig,
            desc,
            bookSchemaVersion: BOOK_TEXT_SCHEMA_VERSION
          })
          saved += 1
        }
      }
    } catch (error) {
      await emitProgress(onError, { type: 'book', done: done + 1, total, name, error })
    }
    done += 1
    if (total && (done % 100 === 0 || done === total)) await emitProgress(onProgress, { type: 'book', done, total })
  }

  index.books.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
  await saveIndex(index)
  return { total: index.books.length, updated: saved }
}

export {
  fetchRoleStoryAll,
  fetchRelicAll,
  fetchWeaponAll,
  fetchPlotAll,
  fetchMapAll,
  fetchAnecdoteAll,
  fetchCardAll,
  fetchBackpackAll,
  fetchVoiceAll,
  fetchBooksFromWiki
}
