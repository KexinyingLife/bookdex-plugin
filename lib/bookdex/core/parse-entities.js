import { pickSectionText, htmlToText } from './text-volumes.js'

function extractRoleStory(page = {}) {
  const modules = page.modules || []

  let detailText = ''
  const detailCandidates = ['角色详细', '更多描述', '基础信息']
  for (const n of detailCandidates) {
    const m = modules.find(x => x.name === n)
    const t = pickSectionText(m)
    if (t) {
      detailText = t
      break
    }
  }

  const stories = []
  for (const m of modules) {
    if (/^角色故事\d+$/.test(m.name || '')) {
      const t = pickSectionText(m)
      if (t) stories.push({ name: m.name, text: t })
    }
  }
  stories.sort((a, b) => Number(a.name.replace(/\D/g, '')) - Number(b.name.replace(/\D/g, '')))

  const other = []
  const pickNames = ['神之眼']
  for (const n of pickNames) {
    const m = modules.find(x => x.name === n)
    const t = pickSectionText(m)
    if (t) other.push({ name: n, text: t })
  }

  if (other.length < 2) {
    const ignore = new Set(['角色详细', '更多描述', '基础信息', '角色CV', '角色关联语音', '配音展示', '关联词条', '生日邮件', '特殊料理', '特色料理'])
    for (const m of modules) {
      const name = m.name || ''
      if (!name || /^角色故事\d+$/.test(name) || ignore.has(name) || other.find(o => o.name === name)) continue
      const t = pickSectionText(m)
      if (!t || t.length < 20) continue
      other.push({ name, text: t })
      if (other.length >= 2) break
    }
  }

  return {
    detail: detailText,
    stories,
    others: other
  }
}

function renderRoleStoryText(role, mode = 'story') {
  const lines = []
  if (mode === 'detail') {
    lines.push(`📘 ${role.name}故事详情`)
    lines.push(`角色详情：${role.detail ? '有' : '无'}`)
    role.stories.forEach((s, i) => lines.push(`${i + 1}. ${s.name}`))
    role.others.forEach((s, i) => lines.push(`其他${i + 1}. ${s.name}`))
    return lines.join('\n')
  }

  lines.push(`📖 ${role.name}故事`)
  if (role.detail) lines.push(`\n【角色详情】\n${role.detail}`)
  role.stories.forEach(s => lines.push(`\n【${s.name}】\n${s.text}`))
  role.others.forEach(s => lines.push(`\n【${s.name}】\n${s.text}`))
  return lines.join('\n')
}

function parseRoleVoices(page = {}) {
  const modules = page.modules || []
  const mod = modules.find(m => m.name === '配音展示')
  const comp = mod?.components?.find(x => x.component_id === 'role_voice')
  if (!comp?.data) return []

  let data = {}
  try { data = JSON.parse(comp.data || '{}') } catch { return [] }

  const tabs = []
  for (const tab of data.list || []) {
    const lang = (tab.tab_name || '').trim() || '未知'
    const items = []
    for (const row of tab.table || []) {
      const name = htmlToText(row.name || '').trim()
      const text = htmlToText(row.content || '').trim()
      const audioUrl = String(row.audio_url || '').trim()
      if (!name || (!text && !audioUrl)) continue
      items.push({ name, text, audioUrl, audioName: row.audio_name || '' })
    }
    if (items.length) tabs.push({ lang, items })
  }
  return tabs
}

function pickDefaultVoiceTab(voice = {}) {
  const tabs = voice.tabs || []
  return tabs.find(t => t.lang === '汉语') || tabs[0] || { lang: '汉语', items: [] }
}

function renderVoiceListText(voice, detail = false) {
  const tab = pickDefaultVoiceTab(voice)
  const lines = [`🎙️ ${voice.name}语音列表（${tab.lang}）`, '发送序号查看文本，发送“序号图片”查看图片，发送“序号语音”播放语音']
  for (const [i, item] of (tab.items || []).entries()) {
    if (detail) {
      lines.push(`\n${i + 1}. ${item.name}`)
      lines.push(item.text || '暂无文本')
    } else {
      const preview = (item.text || '暂无文本').replace(/\s+/g, ' ').slice(0, 36)
      lines.push(`${i + 1}. ${item.name}${preview ? `\n  ↳ ${preview}${(item.text || '').length > 36 ? '…' : ''}` : ''}`)
    }
  }
  return lines.join('\n')
}

function renderVoiceEntryText(entry) {
  return [
    `🎧 ${entry.role}｜${entry.lang}`,
    `【标题】${entry.name}`,
    `【文本】\n${entry.text || '暂无文本'}`,
    `【语音】${entry.audioUrl ? '可播放' : '缺失'}`
  ].join('\n')
}

function parseRelicPiece(module = {}) {
  const c = (module.components || []).find(x => x.component_id === 'artifact_list_v2')
  if (!c) return null
  let d = {}
  try { d = JSON.parse(c.data || '{}') } catch {}

  const pieceName = d?.name?.value?.[0] || ''
  const descHtml = d?.desc?.value?.[0] || ''
  const storyHtml = d?.story?.value?.[0] || ''

  return {
    slot: (d?.title || '').replace(/：$/, ''),
    name: htmlToText(pieceName),
    desc: htmlToText(descHtml),
    story: htmlToText(storyHtml)
  }
}

function renderRelicText(set) {
  const lines = [`📗 圣遗物：${set.name}`]
  for (const p of set.pieces || []) {
    lines.push(`\n【${p.slot || '部位'}】${p.name}`)
    if (p.desc) lines.push(`描述：${p.desc}`)
    if (p.story) lines.push(`故事：${p.story}`)
  }
  return lines.join('\n')
}

function parseWeaponStory(page = {}) {
  const modules = page.modules || []
  let story = ''

  for (const m of modules) {
    const name = m.name || ''
    const t = pickSectionText(m)
    if (!t) continue
    if (name.includes('故事')) {
      story = t
      break
    }
  }

  if (!story) {
    for (const m of modules) {
      const t = pickSectionText(m)
      if (t && t.length > 80) {
        story = t
        break
      }
    }
  }

  return story
}

function renderWeaponText(w) {
  return `📘 武器：${w.name}\n\n【武器故事】\n${w.story || '暂无'}`
}

export {
  extractRoleStory,
  renderRoleStoryText,
  parseRoleVoices,
  pickDefaultVoiceTab,
  renderVoiceListText,
  renderVoiceEntryText,
  parseRelicPiece,
  renderRelicText,
  parseWeaponStory,
  renderWeaponText
}
