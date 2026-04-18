import { cleanPlotText, htmlToText } from './text-volumes.js'
import { parseInteractiveDialogue } from './parse-interactive.js'
import { parseGenericPlotComponent } from './parse-plot.js'

function parseMapPage(page = {}) {
  const modules = page.modules || []
  const sections = []
  for (const module of modules) {
    const hasInteractive = (module.components || []).some(c => (c.component_id || '') === 'interactive_dialogue')
    if (!hasInteractive) continue
    for (const comp of (module.components || [])) {
      if ((comp.component_id || '') !== 'interactive_dialogue') continue
      const text = parseInteractiveDialogue(comp)
      if (!text) continue
      sections.push({
        title: (module.name || '').trim() || '交互文本',
        text
      })
    }
  }
  return sections
}

function renderMapText(item, mode = 'full') {
  const lines = []
  if (mode === 'detail') {
    lines.push(`🗺️ ${item.name}地图文本详情`)
    lines.push(`交互文本段数：${(item.sections || []).length}`)
    ;(item.sections || []).forEach((sec, i) => lines.push(`${i + 1}. ${sec.title || `交互文本 ${i + 1}`}`))
    return lines.join('\n')
  }

  lines.push(`🗺️ ${item.name}地图文本`)
  ;(item.sections || []).forEach((sec, i) => {
    lines.push(`\n【${sec.title || `交互文本 ${i + 1}`}】\n${sec.text || ''}`)
  })
  return lines.join('\n')
}

function parseModuleDialogueLike(module = {}) {
  const texts = []
  for (const comp of (module.components || [])) {
    const txt = parseGenericPlotComponent(comp)
    if (txt) texts.push(txt)
  }
  return cleanPlotText(texts.join('\n\n'))
}

function parseAnecdotePage(page = {}) {
  const modules = page.modules || []
  const sections = []
  for (const m of modules) {
    const name = String(m.name || '').trim() || '文本'
    const cids = (m.components || []).map(c => c.component_id || '')

    if (cids.includes('interactive_dialogue')) {
      for (const comp of (m.components || [])) {
        if ((comp.component_id || '') !== 'interactive_dialogue') continue
        const txt = parseInteractiveDialogue(comp)
        if (!txt) continue
        sections.push({ title: name, text: txt })
      }
      continue
    }

    if (cids.includes('rich_base_info')) {
      const txt = parseModuleDialogueLike(m)
      if (txt) sections.push({ title: name, text: txt })
    }
  }
  return sections
}

function renderAnecdoteText(item, mode = 'full') {
  const lines = []
  if (mode === 'detail') {
    lines.push(`📚 ${item.name}角色逸闻详情`)
    lines.push(`文本段数：${(item.sections || []).length}`)
    ;(item.sections || []).forEach((sec, i) => lines.push(`${i + 1}. ${sec.title || `文本 ${i + 1}`}`))
    return lines.join('\n')
  }

  lines.push(`📚 ${item.name}角色逸闻`)
  ;(item.sections || []).forEach((sec, i) => {
    lines.push(`\n【${sec.title || `文本 ${i + 1}`}】\n${sec.text || ''}`)
  })
  return lines.join('\n')
}

function parseCardPage(page = {}) {
  const modules = page.modules || []
  const sections = []
  for (const m of modules) {
    for (const comp of (m.components || [])) {
      if ((comp.component_id || '') !== 'multi_table') continue
      let data = {}
      try { data = JSON.parse(comp.data || '{}') } catch {}
      for (const table of (data.tables || [])) {
        const title = String(table.tab_name || '').trim() || '文本'
        const lines = []
        for (const row of (table.row || [])) {
          const cells = Array.isArray(row) ? row : [row]
          const txt = cells.map(cell => htmlToText(cell || '').trim()).filter(Boolean).join('\n')
          if (txt) lines.push(txt)
        }
        const text = cleanPlotText(lines.join('\n\n'))
        if (text) sections.push({ title, text })
      }
    }
  }
  return sections
}

function renderCardText(item, mode = 'full') {
  const lines = []
  if (mode === 'detail') {
    lines.push(`🃏 ${item.name}月谕圣牌详情`)
    lines.push(`文本段数：${(item.sections || []).length}`)
    ;(item.sections || []).forEach((sec, i) => lines.push(`${i + 1}. ${sec.title || `文本 ${i + 1}`}`))
    return lines.join('\n')
  }

  lines.push(`🃏 ${item.name}月谕圣牌`)
  ;(item.sections || []).forEach((sec, i) => {
    lines.push(`\n【${sec.title || `文本 ${i + 1}`}】\n${sec.text || ''}`)
  })
  return lines.join('\n')
}

function parseMaterialNameDesc(page = {}) {
  const modules = page.modules || []
  let name = ''
  let desc = ''
  for (const m of modules) {
    for (const comp of (m.components || [])) {
      if ((comp.component_id || '') !== 'material_base_info') continue
      let data = {}
      try { data = JSON.parse(comp.data || '{}') } catch {}
      if (!name) name = String(data.name || '').trim()
      const attrs = Array.isArray(data.attr) ? data.attr : []
      const lines = []
      for (const attr of attrs) {
        const vals = Array.isArray(attr?.value) ? attr.value : []
        const txt = cleanPlotText(vals.map(v => htmlToText(v)).filter(Boolean).join('\n'))
        if (!txt) continue
        lines.push(txt)
      }
      const merged = cleanPlotText(lines.join('\n'))
      if (merged) {
        desc = merged
        return { name, desc }
      }
    }
  }
  return { name, desc }
}

function extractHtmlImageUrls(html = '') {
  const urls = []
  const seen = new Set()
  const text = String(html || '')
  const re = /<img\b[^>]*?\bsrc=(["']?)([^"'\s>]+)\1/gi
  for (const match of text.matchAll(re)) {
    const url = String(match[2] || '').trim()
    if (!url || seen.has(url)) continue
    seen.add(url)
    urls.push(url)
  }
  return urls
}

function parseBackpackReadableSections(page = {}, desc = '') {
  const sections = []
  const seen = new Set()
  const add = (title, htmlOrText) => {
    const images = extractHtmlImageUrls(htmlOrText)
    const text = htmlToText(htmlOrText)
    const clean = cleanPlotText(text || '')
    if ((!clean || clean.length < 2) && !images.length) return
    if (desc && clean === desc) return
    const key = `${clean}\n${images.join('\n')}`
    if (seen.has(key)) return
    seen.add(key)
    sections.push({ title: title || `正文 ${sections.length + 1}`, text: clean, images })
  }

  for (const module of (page.modules || [])) {
    const moduleTitle = String(module.name || '').trim()
    for (const comp of (module.components || [])) {
      const cid = comp.component_id || ''
      if (cid === 'material_base_info') continue

      let data = {}
      try { data = JSON.parse(comp.data || '{}') } catch {}
      const title = String(data?.title || data?.name || moduleTitle || '').trim()

      if (data?.rich_text) {
        add(title || moduleTitle || '可阅读文本', data.rich_text)
        continue
      }

      if (Array.isArray(data?.list)) {
        for (const item of data.list) {
          const itemTitle = String(item?.title || item?.name || title || moduleTitle || '').trim()
          const text = item?.rich_text || item?.content || item?.desc || item?.text || ''
          if (text) add(itemTitle || '可阅读文本', text)
        }
      }
    }
  }

  return sections
}

function parseBackpackPage(page = {}) {
  const base = parseMaterialNameDesc(page)
  return {
    ...base,
    sections: parseBackpackReadableSections(page, base.desc)
  }
}

function renderBackpackText(item) {
  const lines = [`🎒 ${item.name}背包`]
  if (item.desc) lines.push(`\n【描述】\n${item.desc}`)
  for (const [i, sec] of (item.sections || []).entries()) {
    lines.push(`\n【${sec.title || `正文 ${i + 1}`}】\n${sec.text || ''}`)
    for (const url of (sec.images || [])) lines.push(`\n[图片] ${url}`)
  }
  return lines.join('\n').trim()
}

export {
  parseMapPage,
  renderMapText,
  parseAnecdotePage,
  renderAnecdoteText,
  parseCardPage,
  renderCardText,
  parseBackpackPage,
  renderBackpackText
}
