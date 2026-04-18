function inferTitleFromTxt(content, fallback) {
  const lines = content.split(/\r?\n/).map(i => i.trim()).filter(Boolean)
  if (lines.length > 0 && /^《[^》]{1,80}》$/.test(lines[0])) {
    return lines[0].replace(/^《|》$/g, '')
  }
  if (lines.length > 0 && /^书名[:：]/.test(lines[0])) {
    return lines[0].replace(/^书名[:：]\s*/, '').trim() || fallback
  }
  return fallback
}

function splitDocxBooks(text) {
  const normalized = text.replace(/\r/g, '')
  const lines = normalized.split('\n')

  const titleIdx = []
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t) continue
    if (/^《[^》]{1,80}》$/.test(t)) titleIdx.push(i)
    else if (/^书名[:：]\s*.+$/.test(t)) titleIdx.push(i)
    else if (/^第[一二三四五六七八九十百千0-9]+卷\s*[^\s]{0,40}$/.test(t)) titleIdx.push(i)
  }

  if (titleIdx.length >= 2) {
    const books = []
    for (let i = 0; i < titleIdx.length; i++) {
      const start = titleIdx[i]
      const end = i + 1 < titleIdx.length ? titleIdx[i + 1] : lines.length
      const chunk = lines.slice(start, end).join('\n').trim()
      if (!chunk || chunk.length < 80) continue
      let title = lines[start].trim()
      title = title.replace(/^《|》$/g, '').replace(/^书名[:：]\s*/, '').trim()
      if (!title) title = `未命名书籍-${i + 1}`
      books.push({ title, text: chunk })
    }
    if (books.length >= 2) return books
  }

  const tocTitles = []
  let tocOn = false
  for (const raw of lines) {
    const t = raw.trim()
    if (!t) continue
    if (t === '目录') {
      tocOn = true
      continue
    }
    if (!tocOn) continue

    const m = t.match(/^(.+?)\s+\d+$/)
    if (!m) {
      if (tocTitles.length > 20) break
      continue
    }

    const title = m[1].trim().replace(/^[《【]|[》】]$/g, '')
    if (title.length >= 2 && title.length <= 80) tocTitles.push(title)
  }

  const uniqTitles = [...new Set(tocTitles)]
  if (uniqTitles.length < 2) return []

  const content = `\n${normalized}\n`
  const points = []
  let cursor = 0
  for (const title of uniqTitles) {
    const patterns = [
      `\n${title}\n`,
      `\n《${title}》\n`,
      `\n【${title}】\n`
    ]
    let pos = -1
    for (const p of patterns) {
      pos = content.indexOf(p, cursor)
      if (pos >= 0) break
    }
    if (pos >= 0) {
      points.push({ title, pos })
      cursor = pos + title.length
    }
  }

  if (points.length < 2) return []

  const books = []
  for (let i = 0; i < points.length; i++) {
    const start = points[i].pos
    const end = i + 1 < points.length ? points[i + 1].pos : content.length
    const chunk = content.slice(start, end).trim()
    if (!chunk || chunk.length < 120) continue
    books.push({ title: points[i].title, text: chunk })
  }

  return books
}

function parseChineseNumber(raw = '') {
  const text = String(raw).trim()
  if (!text) return NaN
  if (/^\d+$/.test(text)) return Number(text)

  const map = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  let total = 0
  let section = 0
  let current = 0

  for (const ch of text) {
    if (ch in map) {
      current = map[ch]
      continue
    }

    if (ch === '十') {
      section += (current || 1) * 10
      current = 0
      continue
    }

    if (ch === '百') {
      section += (current || 1) * 100
      current = 0
      continue
    }

    if (ch === '千') {
      section += (current || 1) * 1000
      current = 0
      continue
    }

    return NaN
  }

  total += section + current
  return Number.isFinite(total) ? total : NaN
}

function parseBookVolumeLabel(raw = '') {
  const text = String(raw || '').trim()
  if (!text) return ''
  if (/^第[一二三四五六七八九十百千两零\d]+卷(?:（[^）]+）)?$/.test(text)) return text
  if (/^最终卷(?:（[^）]+）)?$/.test(text)) return text
  const tail = text.split('·').pop()?.trim() || ''
  if (/^第[一二三四五六七八九十百千两零\d]+卷(?:（[^）]+）)?$/.test(tail)) return tail
  if (/^最终卷(?:（[^）]+）)?$/.test(tail)) return tail
  return ''
}

function normalizeBookVolumeToken(raw = '') {
  return parseBookVolumeLabel(raw)
}

function getBookModuleOrder(name = '') {
  const normalized = parseBookVolumeLabel(name)
  if (!normalized) return null

  if (/^最终卷/.test(normalized)) {
    const vm = normalized.match(/^最终卷(?:（版本([一二三四五六七八九十百千两零\d]+)）)?$/)
    if (!vm) return 9999
    if (!vm[1]) return 9999
    const v = parseChineseNumber(vm[1])
    return Number.isFinite(v) ? 9999 + v : 9999
  }

  const match = normalized.match(/^第([一二三四五六七八九十百千两零\d]+)卷/)
  if (!match) return null
  const order = parseChineseNumber(match[1])
  return Number.isFinite(order) ? order : null
}

function htmlToText(html = '') {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function escapeHtml(s = '') {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function cleanPlotText(text = '') {
  return String(text)
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizeRoleName(name = '') {
  return name.replace(/\s+/g, '').replace(/[·・]/g, '·')
}

function makeSnippet(text = '', keyword = '') {
  const i = text.indexOf(keyword)
  if (i < 0) return ''
  const s = Math.max(0, i - 32)
  const e = Math.min(text.length, i + keyword.length + 48)
  return text.slice(s, e).replace(/\s+/g, ' ').trim()
}

function chunkLines(lines = [], size = 30) {
  const out = []
  for (let i = 0; i < lines.length; i += size) out.push(lines.slice(i, i + size))
  return out
}

function splitTextPages(text = '', maxChars = 1600) {
  const pages = []
  let rest = text.trim()
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n', maxChars)
    if (cut < maxChars * 0.5) cut = maxChars
    pages.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut).trim()
  }
  if (rest) pages.push(rest)
  return pages.length ? pages : ['']
}

function splitLeadingTitle(text = '', fallbackTitle = '') {
  const normalized = String(text || '').replace(/\r/g, '').trim()
  if (!normalized) return { title: fallbackTitle || '', body: '' }

  const lines = normalized.split('\n')
  const first = (lines[0] || '').trim()
  const rest = lines.slice(1).join('\n').trim()
  const plain = s => String(s || '').replace(/[【】《》〈〉「」『』]/g, '').trim()
  const fallbackPlain = plain(fallbackTitle)
  const firstPlain = plain(first)

  if (fallbackTitle) {
    return {
      title: fallbackTitle,
      body: fallbackPlain && fallbackPlain === firstPlain ? rest : normalized
    }
  }

  if (first && first.length <= 80 && /[^\d\s.,:;_\-]/.test(first)) {
    return {
      title: first,
      body: rest
    }
  }

  return {
    title: fallbackTitle || first || '',
    body: normalized
  }
}

function pickSectionText(module = {}) {
  const comps = module.components || []
  for (const c of comps) {
    try {
      const d = JSON.parse(c.data || '{}')
      if (d.rich_text) return htmlToText(d.rich_text)
    } catch {}
  }
  return ''
}

function parseBookDescriptionFromMaterial(module = {}) {
  const comps = module.components || []
  for (const c of comps) {
    if ((c.component_id || '') !== 'material_base_info') continue
    try {
      const d = JSON.parse(c.data || '{}')
      const rawName = String(d?.name || module?.name || '').trim()
      const label = parseBookVolumeLabel(rawName)
      const attrs = Array.isArray(d?.attr) ? d.attr : []
      const descAttr = attrs.find(x => String(x?.key || '').trim() === '描述')
      const list = Array.isArray(descAttr?.value) ? descAttr.value : []
      const desc = cleanPlotText(list.map(x => htmlToText(x)).filter(Boolean).join('\n'))
      if (!desc) return null
      return { label, rawName, desc }
    } catch {}
  }
  return null
}

export {
  inferTitleFromTxt,
  splitDocxBooks,
  parseChineseNumber,
  parseBookVolumeLabel,
  normalizeBookVolumeToken,
  getBookModuleOrder,
  htmlToText,
  escapeHtml,
  cleanPlotText,
  normalizeRoleName,
  makeSnippet,
  chunkLines,
  splitTextPages,
  splitLeadingTitle,
  pickSectionText,
  parseBookDescriptionFromMaterial
}
