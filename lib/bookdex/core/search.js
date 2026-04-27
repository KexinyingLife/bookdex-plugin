import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import {
  booksRoot,
  storyRoot,
  relicRoot,
  weaponRoot,
  voiceRoot,
  loadIndex,
  loadStoryIndex,
  loadRelicIndex,
  loadWeaponIndex,
  loadVoiceIndex,
  loadPlotIndex,
  loadMapIndex,
  loadAnecdoteIndex,
  loadCardIndex,
  loadBackpackIndex,
  slugify
} from '../base.js'
import { makeSnippet } from './text-volumes.js'
import { resolvePlotFile, resolveMapFile, resolveAnecdoteFile, resolveCardFile, resolveBackpackFile } from './paths.js'

const SEARCH_TYPES = ['book', 'role', 'relic', 'weapon', 'voice', 'plot', 'map', 'anecdote', 'card', 'backpack']

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

function hitRow(rows, row, keyword, text = '', titleHit = false) {
  const textHit = text.includes(keyword)
  if (titleHit || textHit) rows.push({ ...row, snippet: textHit ? makeSnippet(text, keyword) : '' })
}

async function runBookDexTextSearch(keyword, types = SEARCH_TYPES) {
  const key = String(keyword || '').trim()
  if (!key) return []
  const selected = (types?.length ? types : SEARCH_TYPES).filter(type => SEARCH_TYPES.includes(type))
  const rows = []

  if (selected.includes('book')) {
    const bi = await loadIndex()
    for (const b of bi.books || []) {
      const full = path.join(booksRoot, b.file)
      if (!fss.existsSync(full)) continue
      const text = await fs.readFile(full, 'utf8')
      hitRow(rows, { type: 'book', id: String(b.source || '').replace(/^wiki:/, ''), name: b.title, file: b.file }, key, text, b.title.includes(key))
    }
  }

  if (selected.includes('role')) {
    const ri = await loadStoryIndex()
    for (const r of ri.roles || []) {
      const full = path.join(storyRoot, `${slugify(r.name)}.json`)
      if (!fss.existsSync(full)) continue
      const data = await readJson(full)
      const merged = [data.detail || '', ...(data.stories || []).map(s => s.text || ''), ...(data.others || []).map(s => s.text || '')].join('\n')
      hitRow(rows, { type: 'role', id: String(r.id || r.name), name: r.name }, key, merged, r.name.includes(key))
    }
  }

  if (selected.includes('relic')) {
    const ri = await loadRelicIndex()
    for (const s of ri.sets || []) {
      const full = path.join(relicRoot, `${slugify(s.name)}.json`)
      if (!fss.existsSync(full)) continue
      const data = await readJson(full)
      const merged = (data.pieces || []).map(p => `${p.name}\n${p.desc}\n${p.story}`).join('\n')
      hitRow(rows, { type: 'relic', id: String(s.id || s.name), name: s.name }, key, merged, s.name.includes(key))
    }
  }

  if (selected.includes('weapon')) {
    const wi = await loadWeaponIndex()
    for (const w of wi.weapons || []) {
      const full = path.join(weaponRoot, `${slugify(w.name)}.json`)
      if (!fss.existsSync(full)) continue
      const data = await readJson(full)
      hitRow(rows, { type: 'weapon', id: String(w.id || w.name), name: w.name }, key, data.story || '', w.name.includes(key))
    }
  }

  if (selected.includes('voice')) {
    const vi = await loadVoiceIndex()
    for (const r of vi.roles || []) {
      const full = path.join(voiceRoot, `${slugify(r.name)}.json`)
      if (!fss.existsSync(full)) continue
      const data = await readJson(full)
      for (const tab of data.tabs || []) {
        if (!['汉语', '中文'].includes(tab.lang)) continue
        for (const item of tab.items || []) {
          const merged = `${item.name || ''}\n${item.text || ''}`
          hitRow(rows, {
            type: 'voice',
            id: String(r.id || r.name),
            name: `${r.name}｜${item.name}`,
            role: r.name,
            lang: tab.lang,
            voiceName: item.name,
            text: item.text || '',
            audioUrl: item.audioUrl || ''
          }, key, merged, r.name.includes(key) || (item.name || '').includes(key))
        }
      }
    }
  }

  const indexSearchers = [
    ['plot', loadPlotIndex, resolvePlotFile, it => [it.name, it.category, it.subtitle].filter(Boolean).some(x => String(x).includes(key)), data => [data.subtitle || '', (data.sections || []).map(s => `${s.title || ''}\n${s.text || ''}`).join('\n'), data.searchText || ''].join('\n')],
    ['map', loadMapIndex, resolveMapFile, it => String(it.name || '').includes(key), data => [(data.sections || []).map(s => `${s.title || ''}\n${s.text || ''}`).join('\n'), data.searchText || ''].join('\n')],
    ['anecdote', loadAnecdoteIndex, resolveAnecdoteFile, it => String(it.name || '').includes(key), data => [(data.sections || []).map(s => `${s.title || ''}\n${s.text || ''}`).join('\n'), data.searchText || ''].join('\n')],
    ['card', loadCardIndex, resolveCardFile, it => String(it.name || '').includes(key), data => [(data.sections || []).map(s => `${s.title || ''}\n${s.text || ''}`).join('\n'), data.searchText || ''].join('\n')],
    ['backpack', loadBackpackIndex, resolveBackpackFile, it => String(it.name || '').includes(key), data => data.searchText || data.desc || '']
  ]

  for (const [type, load, resolve, titleHitFn, textFn] of indexSearchers) {
    if (!selected.includes(type)) continue
    const index = await load()
    for (const it of index.items || []) {
      const full = resolve(it)
      if (!full || !fss.existsSync(full)) continue
      const data = await readJson(full)
      const showName = type === 'plot' && data.subtitle ? `${it.name}｜${data.subtitle}` : it.name
      hitRow(rows, { type, id: String(it.id || it.name), file: it.file || '', name: showName }, key, textFn(data), titleHitFn({ ...it, subtitle: data.subtitle, category: data.category }))
    }
  }

  return rows
}

export { SEARCH_TYPES, runBookDexTextSearch }
