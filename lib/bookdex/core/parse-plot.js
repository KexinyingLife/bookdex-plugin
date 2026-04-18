import { cleanPlotText, htmlToText } from './text-volumes.js'
import { parseInteractiveDialogue } from './parse-interactive.js'

function parsePlotCategory(extRaw = '') {
  try {
    const ext = typeof extRaw === 'string' ? JSON.parse(extRaw || '{}') : (extRaw || {})
    const text = ext?.c_43?.filter?.text || ''
    const arr = typeof text === 'string' ? JSON.parse(text) : []
    const hit = arr.find(x => String(x).startsWith('任务类型/'))
    return hit ? String(hit).replace(/^任务类型\//, '').trim() : '其他任务'
  } catch {
    return '其他任务'
  }
}

function extractPlotSubtitle(page = {}) {
  const modules = page.modules || []
  const titles = []
  for (const m of modules) {
    const hasBase = (m.components || []).some(c => (c.component_id || '') === 'base_info')
    if (!hasBase) continue
    const name = String(m.name || '').trim()
    if (!name) continue
    titles.push(name)
  }
  const uniq = [...new Set(titles)]
  return uniq.join(' / ')
}

function collectPlotStrings(value, out = []) {
  if (value == null) return out
  if (Array.isArray(value)) {
    for (const v of value) collectPlotStrings(v, out)
    return out
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value)) collectPlotStrings(v, out)
    return out
  }
  if (typeof value !== 'string') return out

  const raw = value.trim()
  if (!raw || /^https?:\/\//i.test(raw)) return out

  const txt = cleanPlotText(htmlToText(raw))
  if (!txt || txt.length < 2) return out
  if (/^[\d\s.,:;_\-\/]+$/.test(txt)) return out

  out.push(txt)
  return out
}

function parseGenericPlotComponent(comp = {}) {
  let data = {}
  try { data = JSON.parse(comp.data || '{}') } catch { return '' }
  const lines = collectPlotStrings(data, [])
  return cleanPlotText(lines.join('\n'))
}

function parsePlotPage(page = {}) {
  const modules = page.modules || []
  const sections = []
  const add = (title, txt) => {
    const t = cleanPlotText(txt || '')
    if (!t || t.length < 2) return
    sections.push({ title, text: t })
  }

  const parseModuleDialogue = (m = {}) => {
    const comps = m.components || []
    const collected = []
    for (const comp of comps) {
      const cid = comp.component_id || ''
      if (cid === 'interactive_dialogue') {
        const txt = parseInteractiveDialogue(comp)
        if (txt) collected.push(txt)
        continue
      }
      const txt = parseGenericPlotComponent(comp)
      if (txt) collected.push(txt)
    }
    return cleanPlotText(collected.filter(Boolean).join('\n\n'))
  }

  let dialogueIndex = 0
  for (const m of modules) {
    const name = (m.name || '').trim()
    const cids = (m.components || []).map(c => c.component_id || '')
    const hasInteractive = cids.includes('interactive_dialogue')
    const isPlotNamed = name === '剧情对话' || /^剧情对话/.test(name)

    if (!isPlotNamed && !hasInteractive) continue

    const merged = parseModuleDialogue(m)
    if (!merged) continue

    dialogueIndex += 1
    const title = name && name !== '剧情对话' && !/^剧情对话\s*\d+$/.test(name)
      ? `剧情对话 ${dialogueIndex}（${name}）`
      : `剧情对话 ${dialogueIndex}`
    add(title, merged)
  }

  if (!sections.length) {
    let processIndex = 0
    for (const m of modules) {
      const name = (m.name || '').trim()
      if (!['任务过程', '任务概述'].includes(name)) continue
      const txt = parseModuleDialogue(m)
      if (!txt || txt.length < 6) continue
      processIndex += 1
      const title = name === '任务过程' ? `任务过程 ${processIndex}` : name
      add(title, txt)
    }
  }

  const dedup = []
  const seen = new Set()
  for (const sec of sections) {
    const key = sec.text
    if (!key || seen.has(key)) continue
    seen.add(key)
    dedup.push(sec)
  }
  return dedup
}

function parsePlotSearchText(page = {}) {
  const sections = parsePlotPage(page)
  return sections.map(sec => `【${sec.title}】\n${sec.text}`).join('\n\n').trim()
}

function renderPlotText(item, mode = 'full') {
  const lines = []
  if (mode === 'detail') {
    lines.push(`📜 ${item.name}剧情详情`)
    if (item.subtitle) lines.push(`副标题：${item.subtitle}`)
    lines.push(`任务类型：${item.category || '其他任务'}`)
    lines.push(`剧情段数：${(item.sections || []).length}`)
    ;(item.sections || []).forEach((sec, i) => lines.push(`${i + 1}. ${sec.title || `剧情段落 ${i + 1}`}`))
    return lines.join('\n')
  }

  lines.push(`📜 ${item.name}剧情文本`)
  if (item.subtitle) lines.push(`副标题：${item.subtitle}`)
  if (item.category) lines.push(`任务类型：${item.category}`)
  ;(item.sections || []).forEach((sec, i) => {
    lines.push(`\n【${sec.title || `剧情段落 ${i + 1}`}】\n${sec.text || ''}`)
  })
  return lines.join('\n')
}

export {
  parsePlotCategory,
  extractPlotSubtitle,
  collectPlotStrings,
  parseGenericPlotComponent,
  parsePlotPage,
  parsePlotSearchText,
  renderPlotText
}
