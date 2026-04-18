import fs from 'node:fs/promises'
import path from 'node:path'
import mammoth from 'mammoth'
import { ensureDirs, saveIndex, slugify, booksRoot, inboxRoot } from '../base.js'
import {
  inferTitleFromTxt,
  splitDocxBooks,
  pickSectionText,
  parseBookDescriptionFromMaterial,
  getBookModuleOrder,
  normalizeBookVolumeToken
} from './text-volumes.js'

async function rebuildBooksFromInbox() {
  await ensureDirs()
  const files = await fs.readdir(inboxRoot)
  const index = { books: [] }

  const oldBooks = await fs.readdir(booksRoot).catch(() => [])
  for (const file of oldBooks) {
    await fs.rm(path.join(booksRoot, file), { force: true, recursive: true })
  }

  let created = 0

  for (const file of files) {
    const full = path.join(inboxRoot, file)
    const stat = await fs.stat(full)
    if (!stat.isFile()) continue

    const ext = path.extname(file).toLowerCase()

    if (ext === '.txt') {
      const content = await fs.readFile(full, 'utf8')
      const fallback = path.basename(file, ext)
      const title = inferTitleFromTxt(content, fallback)
      const out = `${slugify(title)}.txt`
      await fs.writeFile(path.join(booksRoot, out), content, 'utf8')
      index.books.push({ title, file: out, source: file })
      created++
      continue
    }

    if (ext === '.docx') {
      const raw = await mammoth.extractRawText({ path: full })
      const text = raw.value || ''
      const books = splitDocxBooks(text)
      if (books.length === 0) {
        const title = path.basename(file, ext)
        const out = `${slugify(title)}.txt`
        await fs.writeFile(path.join(booksRoot, out), text, 'utf8')
        index.books.push({ title, file: out, source: file })
        created++
      } else {
        for (const b of books) {
          const out = `${slugify(b.title)}.txt`
          await fs.writeFile(path.join(booksRoot, out), b.text, 'utf8')
          index.books.push({ title: b.title, file: out, source: file })
          created++
        }
      }
    }
  }

  const seen = new Set()
  index.books = index.books.filter(b => {
    const k = b.title.trim()
    if (!k || seen.has(k)) return false
    seen.add(k)
    return true
  })

  index.books.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
  await saveIndex(index)

  return { created, total: index.books.length }
}

function buildBookSectionsFromEntryPage(page = {}) {
  const modules = [...(page.modules || [])]
  const volumeDescMap = new Map()
  const exactNameDescMap = new Map()
  const volumeDescQueue = []
  for (const m of modules) {
    const item = parseBookDescriptionFromMaterial(m)
    if (!item?.desc) continue
    const key = normalizeBookVolumeToken(item.label)
    if (key && !volumeDescMap.has(key)) volumeDescMap.set(key, item.desc)
    if (item.rawName && !exactNameDescMap.has(item.rawName)) exactNameDescMap.set(item.rawName, item.desc)
    volumeDescQueue.push({ key: key || '', desc: item.desc })
  }
  const usedDescKeys = new Set()
  const usedExactNames = new Set()
  const usedQueueIndexes = new Set()

  let currentHintOrder = null
  const moduleOrderHints = modules.map((m) => {
    let hintOrder = null
    const meta = parseBookDescriptionFromMaterial(m)
    const metaOrder = meta?.label ? getBookModuleOrder(meta.label) : null
    if (metaOrder != null) currentHintOrder = metaOrder
    const ownOrder = getBookModuleOrder(m?.name)
    const hasCollapse = (m?.components || []).some(c => (c.component_id || '') === 'collapse_panel')
    if (ownOrder == null && hasCollapse && currentHintOrder != null) hintOrder = currentHintOrder
    return hintOrder
  })

  const orderedModules = modules
    .map((m, idx) => {
      const ownOrder = getBookModuleOrder(m?.name)
      const hintOrder = moduleOrderHints[idx]
      return { idx, order: ownOrder != null ? ownOrder : hintOrder, module: m }
    })
    .sort((a, b) => {
      const av = a.order
      const bv = b.order
      if (av != null && bv != null) return av - bv || a.idx - b.idx
      if (av != null) return -1
      if (bv != null) return 1
      return a.idx - b.idx
    })
    .map(item => item.module)
  const sections = []
  for (const m of orderedModules) {
    const t = pickSectionText(m)
    if (!t) continue
    const n = (m.name || '').trim()
    const labelKey = normalizeBookVolumeToken(n)

    let matchedKey = labelKey || ''
    let desc = ''
    if (n && exactNameDescMap.has(n) && !usedExactNames.has(n)) {
      desc = exactNameDescMap.get(n) || ''
      usedExactNames.add(n)
    } else if (matchedKey) {
      desc = volumeDescMap.get(matchedKey) || ''
    }

    if (!desc && !labelKey) {
      const nextIdx = volumeDescQueue.findIndex((x, idx) => !usedQueueIndexes.has(idx))
      if (nextIdx >= 0) {
        const next = volumeDescQueue[nextIdx]
        matchedKey = next.key || matchedKey
        desc = next.desc
        usedQueueIndexes.add(nextIdx)
      }
    }
    if (desc && matchedKey) usedDescKeys.add(matchedKey)

    let displayTitle = n
    if ((!displayTitle || /^书籍内容$/.test(displayTitle)) && matchedKey) displayTitle = matchedKey
    else if (displayTitle && matchedKey && !labelKey) displayTitle = `${matchedKey}｜${displayTitle}`

    sections.push({
      text: t,
      desc,
      displayTitle: displayTitle || '',
      labelKey: labelKey || '',
      matchedKey: matchedKey || ''
    })
  }

  const finalLabels = [...new Set(volumeDescQueue
    .map(x => String(x?.key || '').trim())
    .filter(x => /^最终卷(?:（[^）]+）)?$/.test(x)))]
  const hasFinalHeading = sections.some(s => /^最终卷(?:（[^）]+）)?$/.test(s.displayTitle || s.matchedKey || ''))
  if (finalLabels.length && !hasFinalHeading) {
    const numericIndexes = []
    for (let i = 0; i < sections.length; i++) {
      const k = sections[i].labelKey || sections[i].matchedKey || ''
      if (/^第[一二三四五六七八九十百千两零\d]+卷(?:（[^）]+）)?$/.test(k)) numericIndexes.push(i)
    }
    if (numericIndexes.length >= finalLabels.length) {
      const targets = numericIndexes.slice(-finalLabels.length)
      for (let i = 0; i < targets.length; i++) {
        const idx = targets[i]
        const finalLabel = finalLabels[i]
        sections[idx].displayTitle = finalLabel
        const finalDesc = volumeDescMap.get(finalLabel)
        if (finalDesc) sections[idx].desc = finalDesc
      }
    }
  }

  return sections
}

async function buildBookTextFromEntryPage(page = {}) {
  const sections = buildBookSectionsFromEntryPage(page)
  const segs = []
  for (const s of sections) {
    if (s.displayTitle) {
      if (s.desc) segs.push(`【${s.displayTitle}】\n【描述】\n${s.desc}\n\n${s.text}`)
      else segs.push(`【${s.displayTitle}】\n${s.text}`)
    } else segs.push(s.text)
  }
  return segs.join('\n\n').trim()
}

export { rebuildBooksFromInbox, buildBookSectionsFromEntryPage, buildBookTextFromEntryPage }
