import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import mammoth from 'mammoth'
import puppeteer from 'puppeteer'
import { fileURLToPath } from 'node:url'

const pluginRoot = process.cwd()
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const pluginDir = path.resolve(__dirname, '..')
const pluginFolder = path.basename(pluginDir)

const dataRoot = path.join(pluginDir, 'data')
const booksRoot = path.join(dataRoot, 'books')
const inboxRoot = path.join(dataRoot, 'inbox')
const cacheRoot = path.join(dataRoot, 'cache')
const indexFile = path.join(cacheRoot, 'index.json')
const tmpRoot = path.join(pluginRoot, 'temp', pluginFolder)
const fontFile = path.join(pluginDir, 'resources', 'fonts', 'zh-cn.ttf')
const defaultBg = path.join(pluginDir, 'resources', 'help-bg.jpg')
const storyRoot = path.join(dataRoot, 'charstories')
const storyIndexFile = path.join(storyRoot, 'index.json')
const relicRoot = path.join(dataRoot, 'relics')
const relicIndexFile = path.join(relicRoot, 'index.json')
const weaponRoot = path.join(dataRoot, 'weapons')
const weaponIndexFile = path.join(weaponRoot, 'index.json')
const voiceRoot = path.join(dataRoot, 'voices')
const voiceIndexFile = path.join(voiceRoot, 'index.json')
const plotRoot = path.join(dataRoot, 'plots')
const plotIndexFile = path.join(plotRoot, 'index.json')

const helpSessionCache = new Map()

async function ensureDirs() {
  await fs.mkdir(booksRoot, { recursive: true })
  await fs.mkdir(inboxRoot, { recursive: true })
  await fs.mkdir(cacheRoot, { recursive: true })
  await fs.mkdir(tmpRoot, { recursive: true })
  await fs.mkdir(storyRoot, { recursive: true })
  await fs.mkdir(relicRoot, { recursive: true })
  await fs.mkdir(weaponRoot, { recursive: true })
  await fs.mkdir(voiceRoot, { recursive: true })
  await fs.mkdir(plotRoot, { recursive: true })
}

function slugify(name) {
  return name
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function loadIndex() {
  try {
    const raw = await fs.readFile(indexFile, 'utf8')
    return JSON.parse(raw)
  } catch {
    return { books: [] }
  }
}

async function saveIndex(index) {
  await fs.writeFile(indexFile, JSON.stringify(index, null, 2), 'utf8')
}

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

  // 方案1：按显式标题行拆分
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

  // 方案2：先识别“目录 + 页码”，再用目录标题在全文定位切分
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

    // 典型目录行：书名 + 空白 + 页码
    const m = t.match(/^(.+?)\s+\d+$/)
    if (!m) {
      // 目录结束条件：已收集到一定数量后遇到非目录行
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

async function rebuildBooksFromInbox() {
  await ensureDirs()
  const files = await fs.readdir(inboxRoot)
  const index = { books: [] }

  // 清空旧书库
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

  // 去重（按标题）
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

function buildHelpList(books) {
  const list = books.map((b, idx) => {
    const no = idx + 1
    return {
      icon: ((idx % 40) + 1),
      title: `${no}. ${b.title}`,
      desc: `发送 ${no}（引用本条）或 #${b.title}；加“文本”返回纯文本`
    }
  })

  return {
    groups: [{
      group: `📚 书籍图鉴（共 ${books.length} 本）`,
      list
    }]
  }
}

async function renderHelpImage(e, books) {
  // 固定输出单页长图（不分页）
  const bgData = await pickBgDataUri()
  const fontData = await pickFontDataUri()

  const cols = 4
  const rowCount = Math.ceil(books.length / cols)
  const ordered = []
  for (let r = 0; r < rowCount; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = c * rowCount + r
      if (idx < books.length) ordered.push({ ...books[idx], no: idx + 1 })
    }
  }

  const rows = ordered.map((b) => {
    return `<div class="row"><span class="no">${b.no}.</span><span class="name">${escapeHtml(b.title)}</span></div>`
  }).join('')

  const html = `<!doctype html><html><head><meta charset='utf-8'/><style>
    ${fontData ? `@font-face{font-family:"BookDexFont";src:url(${fontData}) format("truetype");font-display:block;}` : ''}
    *{box-sizing:border-box;font-family:${fontData ? '"BookDexFont",' : ''}sans-serif !important;}
    body{margin:0;width:1400px;background:${bgData ? `url('${bgData}') center/cover no-repeat` : '#0f172a'};color:#fff;}
    .mask{padding:28px;background:linear-gradient(180deg,rgba(15,23,42,.68),rgba(2,6,23,.82));}
    .card{border-radius:16px;border:1px solid rgba(148,163,184,.35);background:rgba(15,23,42,.45);padding:18px;}
    .title{font-size:42px;color:#fcd34d;font-weight:700}
    .sub{margin-top:4px;color:#cbd5e1;font-size:21px}
    .rows{margin-top:14px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px 10px}
    .row{display:flex;align-items:flex-start;padding:8px 10px;border-radius:8px;background:rgba(30,41,59,.42);min-height:60px}
    .no{min-width:44px;color:#fbbf24;font-size:22px;font-weight:700}
    .name{font-size:20px;line-height:1.28;color:#e2e8f0;word-break:break-all}
    .tip{margin-top:12px;font-size:18px;color:#cbd5e1}
  </style></head><body><div class='mask'><div class='card'>
  <div class='title'>书籍图鉴帮助</div>
  <div class='sub'>当前共 ${books.length} 本｜单页长图</div>
  <div class='rows'>${rows}</div>
  <div class='tip'>引用本图发“序号”读取；发“序号文本”/“#书名文本”输出纯文本</div>
  </div></div></body></html>`

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  try {
    const p = await browser.newPage()
    await p.setViewport({ width: 1400, height: 2200, deviceScaleFactor: 2 })
    await p.setContent(html, { waitUntil: 'domcontentloaded', timeout: 0 })
    const file = path.join(tmpRoot, `help-${Date.now()}.jpg`)
    await p.screenshot({ path: file, type: 'jpeg', quality: 88, fullPage: true })
    return file
  } finally {
    await browser.close()
  }
}

function escapeHtml(s = '') {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
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

async function pickBgDataUri() {
  const customBg = path.join(pluginDir, 'resources', 'help-bg.jpg')
  const bgPath = fss.existsSync(customBg) ? customBg : defaultBg
  try {
    const b64 = await fs.readFile(bgPath, 'base64')
    return `data:image/jpeg;base64,${b64}`
  } catch {
    return ''
  }
}

async function pickFontDataUri() {
  // 保留 data URI 兜底；主路径优先走 file:// 共享 lunaris 字体
  try {
    const b64 = await fs.readFile(fontFile, 'base64')
    return `data:font/ttf;base64,${b64}`
  } catch {
    return ''
  }
}

function textPageHtml({ title, body, fontData }) {
  return `<!doctype html><html><head><meta charset='utf-8'/>
<style>
  ${fontData ? `@font-face{font-family:"BookDexFont";src:url(${fontData}) format("truetype");font-display:block;}` : ''}
  *{box-sizing:border-box;font-family:${fontData ? '"BookDexFont",' : ''}sans-serif !important;}
  body{margin:0;width:1120px;background:#0b1020;color:#f8fafc;}
  .wrap{padding:24px;}
  .card{border:1px solid rgba(148,163,184,.30);border-radius:14px;padding:18px;background:#111827;}
  .title{font-size:34px;font-weight:700;color:#fcd34d;margin-bottom:10px;line-height:1.2;}
  .content{white-space:pre-wrap;font-size:24px;line-height:1.25;color:#e5e7eb;word-break:break-word;margin:0;}
</style></head>
<body><div class='wrap'><div class='card'>
  <div class='title'>${escapeHtml(title)}</div>
  <pre class='content'>${escapeHtml(body)}</pre>
</div></div></body></html>`
}

async function renderTextAsImages(title, text) {
  await ensureDirs()
  const fontData = await pickFontDataUri()
  const html = textPageHtml({ title, body: text, fontData })
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1120, height: 1600, deviceScaleFactor: 2 })
    await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 0 })
    const file = path.join(tmpRoot, `book-${Date.now()}.jpg`)
    await page.screenshot({ path: file, type: 'jpeg', quality: 88, fullPage: true })
    return [file]
  } finally {
    await browser.close()
  }
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

async function loadStoryIndex() {
  try {
    return JSON.parse(await fs.readFile(storyIndexFile, 'utf8'))
  } catch {
    return { roles: [] }
  }
}

async function loadRelicIndex() {
  try {
    return JSON.parse(await fs.readFile(relicIndexFile, 'utf8'))
  } catch {
    return { sets: [] }
  }
}

async function loadWeaponIndex() {
  try {
    return JSON.parse(await fs.readFile(weaponIndexFile, 'utf8'))
  } catch {
    return { weapons: [] }
  }
}

async function loadVoiceIndex() {
  try {
    return JSON.parse(await fs.readFile(voiceIndexFile, 'utf8'))
  } catch {
    return { roles: [] }
  }
}

async function loadPlotIndex() {
  try {
    return JSON.parse(await fs.readFile(plotIndexFile, 'utf8'))
  } catch {
    return { items: [] }
  }
}

function normalizeRoleName(name = '') {
  return name.replace(/\s+/g, '').replace(/[·・]/g, '·')
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
    const ignore = new Set(['角色详细', '更多描述', '基础信息', '角色CV', '角色关联语音', '配音展示', '关联词条', '生日邮件'])
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

async function fetchRoleStoryAll() {
  const roleMap = new Map()

  // 通过 selector 分页抓取全部角色（page 生效，page_num 无效）
  for (let page = 1; page <= 20; page++) {
    const u = new URL('https://act-api-takumi.mihoyo.com/common/blackboard/ys_obc/v1/content/selector')
    u.searchParams.set('app_sn', 'ys_obc')
    u.searchParams.set('channel_id', '25')
    u.searchParams.set('page', String(page))
    u.searchParams.set('page_size', '100')

    const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } })
    const j = await r.json()
    const list = j?.data?.list || []
    if (!list.length) break

    for (const it of list) {
      const name = (it.title || it.name || '').trim()
      if (!name) continue
      // 旅行者只保留一个条目
      if (name.includes('旅行者')) {
        if (!roleMap.has('旅行者')) roleMap.set('旅行者', it)
        continue
      }
      roleMap.set(name, it)
    }
  }

  const roles = []
  for (const it of roleMap.values()) {
    const roleName = (it.title || it.name || '').trim()
    const id = String(it.id)
    const u = new URL('https://act-api-takumi-static.mihoyo.com/hoyowiki/genshin/wapi/entry_page')
    u.searchParams.set('app_sn', 'ys_obc')
    u.searchParams.set('entry_page_id', id)
    const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } })
    const j = await r.json()
    const page = j?.data?.page
    if (!page) continue

    const ext = extractRoleStory(page)
    const detail = ext.detail || ''
    const stories = ext.stories || []
    const others = ext.others || []

    if (!detail && !stories.length && !others.length) continue

    const item = {
      id,
      name: roleName,
      alias: [normalizeRoleName(roleName)],
      detail,
      stories,
      others
    }
    await fs.writeFile(path.join(storyRoot, `${slugify(roleName)}.json`), JSON.stringify(item, null, 2), 'utf8')
    roles.push({ id, name: roleName, alias: item.alias, storyCount: stories.length, otherCount: others.length })
  }

  roles.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  await fs.writeFile(storyIndexFile, JSON.stringify({ roles, updatedAt: Date.now() }, null, 2), 'utf8')
  return { total: roles.length }
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



function cleanPlotText(text = '') {
  return String(text)
    .replace(/\r/g, '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

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

function parsePlotPage(page = {}) {
  const modules = page.modules || []
  const sections = []
  const add = (title, txt) => {
    const t = cleanPlotText(txt || '')
    if (!t || t.length < 10) return
    sections.push({ title, text: t })
  }

  for (const m of modules) {
    if ((m.name || '').trim() !== '剧情对话') continue
    add(m.name, pickSectionText(m) || '')
  }

  if (!sections.length) {
    for (const m of modules) {
      const name = (m.name || '').trim()
      if (!['任务过程', '任务概述'].includes(name)) continue
      add(name, pickSectionText(m) || '')
    }
  }

  const dedup = []
  const seen = new Set()
  for (const sec of sections) {
    const key = `${sec.title}@@${sec.text}`
    if (seen.has(key)) continue
    seen.add(key)
    dedup.push(sec)
  }
  return dedup
}

function parsePlotSearchText(page = {}) {
  const modules = page.modules || []
  const pieces = []
  for (const m of modules) {
    const name = (m.name || '').trim()
    if (!name) continue
    if (['任务奖励', '攻略方法'].includes(name)) continue
    const t = cleanPlotText(pickSectionText(m) || '')
    if (!t || t.length < 4) continue
    pieces.push(`【${name}】\n${t}`)
  }
  return pieces.join('\n\n').trim()
}

function renderPlotText(item, mode = 'full') {
  const lines = []
  if (mode === 'detail') {
    lines.push(`📜 ${item.name}剧情详情`)
    lines.push(`任务类型：${item.category || '其他任务'}`)
    lines.push(`剧情段数：${(item.sections || []).length}`)
    ;(item.sections || []).forEach((sec, i) => lines.push(`${i + 1}. ${sec.title || `剧情段落 ${i + 1}`}`))
    return lines.join('\n')
  }

  lines.push(`📜 ${item.name}剧情文本`)
  if (item.category) lines.push(`任务类型：${item.category}`)
  ;(item.sections || []).forEach((sec, i) => {
    lines.push(`\n【${sec.title || `剧情段落 ${i + 1}`}】\n${sec.text || ''}`)
  })
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
  const lines = [`🎙️ ${voice.name}语音列表（${tab.lang}）`, '发送序号查看图，发送“序号文本”查看文本，发送“序号语音”播放语音']
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

async function sendVoiceRecord(e, url) {
  if (!url) return e.reply('该条语音没有音频地址')
  await e.reply(segment.record(url))
  return true
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

async function fetchRelicAll() {
  const setMap = new Map()
  for (let page = 1; page <= 20; page++) {
    const u = new URL('https://act-api-takumi.mihoyo.com/common/blackboard/ys_obc/v1/content/selector')
    u.searchParams.set('app_sn', 'ys_obc')
    u.searchParams.set('channel_id', '218')
    u.searchParams.set('page', String(page))
    u.searchParams.set('page_size', '100')
    const j = await (await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } })).json()
    const list = j?.data?.list || []
    if (!list.length) break
    for (const it of list) {
      const name = (it.title || it.name || '').trim()
      if (!name) continue
      setMap.set(name, it)
    }
  }

  const sets = []
  for (const it of setMap.values()) {
    const setName = (it.title || it.name || '').trim()
    const id = String(it.id)
    const u = new URL('https://act-api-takumi-static.mihoyo.com/hoyowiki/genshin/wapi/entry_page')
    u.searchParams.set('app_sn', 'ys_obc')
    u.searchParams.set('entry_page_id', id)
    const j = await (await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } })).json()
    const page = j?.data?.page
    if (!page) continue

    const modules = page.modules || []
    const pieces = []
    for (const m of modules) {
      const p = parseRelicPiece(m)
      if (p && p.name) pieces.push(p)
    }

    if (!pieces.length) continue
    const item = { id, name: setName, alias: [normalizeRoleName(setName)], pieces }
    await fs.writeFile(path.join(relicRoot, `${slugify(setName)}.json`), JSON.stringify(item, null, 2), 'utf8')
    sets.push({ id, name: setName, alias: item.alias, pieceCount: pieces.length })
  }

  sets.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  await fs.writeFile(relicIndexFile, JSON.stringify({ sets, updatedAt: Date.now() }, null, 2), 'utf8')
  return { total: sets.length }
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

async function fetchWeaponAll() {
  const map = new Map()
  for (let page = 1; page <= 20; page++) {
    const u = new URL('https://act-api-takumi.mihoyo.com/common/blackboard/ys_obc/v1/content/selector')
    u.searchParams.set('app_sn', 'ys_obc')
    u.searchParams.set('channel_id', '5')
    u.searchParams.set('page', String(page))
    u.searchParams.set('page_size', '100')
    const j = await (await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } })).json()
    const list = j?.data?.list || []
    if (!list.length) break
    for (const it of list) {
      const name = (it.title || it.name || '').trim()
      if (name) map.set(name, it)
    }
  }

  const weapons = []
  for (const it of map.values()) {
    const name = (it.title || it.name || '').trim()
    const id = String(it.id)
    const u = new URL('https://act-api-takumi-static.mihoyo.com/hoyowiki/genshin/wapi/entry_page')
    u.searchParams.set('app_sn', 'ys_obc')
    u.searchParams.set('entry_page_id', id)
    const j = await (await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } })).json()
    const page = j?.data?.page
    if (!page) continue

    const story = parseWeaponStory(page)
    if (!story) continue

    const item = { id, name, alias: [normalizeRoleName(name)], story }
    await fs.writeFile(path.join(weaponRoot, `${slugify(name)}.json`), JSON.stringify(item, null, 2), 'utf8')
    weapons.push({ id, name, alias: item.alias })
  }

  weapons.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  await fs.writeFile(weaponIndexFile, JSON.stringify({ weapons, updatedAt: Date.now() }, null, 2), 'utf8')
  return { total: weapons.length }
}



async function fetchPlotAll() {
  const map = new Map()
  for (let page = 1; page <= 50; page++) {
    const u = new URL('https://act-api-takumi.mihoyo.com/common/blackboard/ys_obc/v1/content/selector')
    u.searchParams.set('app_sn', 'ys_obc')
    u.searchParams.set('channel_id', '43')
    u.searchParams.set('page', String(page))
    u.searchParams.set('page_size', '100')
    const j = await (await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } })).json()
    const list = j?.data?.list || []
    if (!list.length) break
    for (const it of list) {
      const name = (it.title || it.name || '').trim()
      if (name) map.set(name, it)
    }
  }

  const items = []
  for (const it of map.values()) {
    const name = (it.title || it.name || '').trim()
    const id = String(it.id)
    const u = new URL('https://act-api-takumi-static.mihoyo.com/hoyowiki/genshin/wapi/entry_page')
    u.searchParams.set('app_sn', 'ys_obc')
    u.searchParams.set('entry_page_id', id)
    const j = await (await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } })).json()
    const page = j?.data?.page
    if (!page) continue

    const sections = parsePlotPage(page)
    const searchText = parsePlotSearchText(page)
    if (!sections.length && !searchText) continue

    const category = parsePlotCategory(it.ext)
    const item = { id, name, alias: [normalizeRoleName(name)], category, sections, searchText }
    await fs.writeFile(path.join(plotRoot, `${slugify(name)}.json`), JSON.stringify(item, null, 2), 'utf8')
    items.push({ id, name, alias: item.alias, category, sectionCount: sections.length })
  }

  items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  await fs.writeFile(plotIndexFile, JSON.stringify({ items, updatedAt: Date.now() }, null, 2), 'utf8')
  return { total: items.length }
}

async function fetchVoiceAll() {
  const roleMap = new Map()
  for (let page = 1; page <= 20; page++) {
    const u = new URL('https://act-api-takumi.mihoyo.com/common/blackboard/ys_obc/v1/content/selector')
    u.searchParams.set('app_sn', 'ys_obc')
    u.searchParams.set('channel_id', '25')
    u.searchParams.set('page', String(page))
    u.searchParams.set('page_size', '100')
    const j = await (await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } })).json()
    const list = j?.data?.list || []
    if (!list.length) break
    for (const it of list) {
      const name = (it.title || it.name || '').trim()
      if (!name) continue
      if (name.includes('旅行者')) {
        if (!roleMap.has('旅行者')) roleMap.set('旅行者', it)
        continue
      }
      roleMap.set(name, it)
    }
  }

  const roles = []
  for (const it of roleMap.values()) {
    const roleName = (it.title || it.name || '').trim()
    const id = String(it.id)
    const u = new URL('https://act-api-takumi-static.mihoyo.com/hoyowiki/genshin/wapi/entry_page')
    u.searchParams.set('app_sn', 'ys_obc')
    u.searchParams.set('entry_page_id', id)
    const j = await (await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } })).json()
    const page = j?.data?.page
    if (!page) continue

    const tabs = parseRoleVoices(page)
    if (!tabs.length) continue

    const item = { id, name: roleName, alias: [normalizeRoleName(roleName)], tabs }
    await fs.writeFile(path.join(voiceRoot, `${slugify(roleName)}.json`), JSON.stringify(item, null, 2), 'utf8')
    roles.push({
      id,
      name: roleName,
      alias: item.alias,
      langCount: tabs.length,
      itemCount: tabs.reduce((sum, t) => sum + (t.items || []).length, 0)
    })
  }

  roles.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  await fs.writeFile(voiceIndexFile, JSON.stringify({ roles, updatedAt: Date.now() }, null, 2), 'utf8')
  return { total: roles.length }
}

function renderWeaponText(w) {
  return `📘 武器：${w.name}\n\n【武器故事】\n${w.story || '暂无'}`
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

async function buildBookTextFromEntryPage(page = {}) {
  const modules = page.modules || []
  const segs = []
  for (const m of modules) {
    const t = pickSectionText(m)
    if (!t) continue
    const n = (m.name || '').trim()
    if (n) segs.push(`【${n}】\n${t}`)
    else segs.push(t)
  }
  return segs.join('\n\n').trim()
}

async function fetchBooksFromWiki() {
  await ensureDirs()
  const map = new Map()
  for (let page = 1; page <= 20; page++) {
    const u = new URL('https://act-api-takumi.mihoyo.com/common/blackboard/ys_obc/v1/content/selector')
    u.searchParams.set('app_sn', 'ys_obc')
    u.searchParams.set('channel_id', '68')
    u.searchParams.set('page', String(page))
    u.searchParams.set('page_size', '100')
    const j = await (await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } })).json()
    const list = j?.data?.list || []
    if (!list.length) break
    for (const it of list) {
      const name = (it.title || it.name || '').trim()
      if (name) map.set(name, it)
    }
  }

  const index = { books: [] }
  for (const it of map.values()) {
    const name = (it.title || it.name || '').trim()
    const id = String(it.id)
    const u = new URL('https://act-api-takumi-static.mihoyo.com/hoyowiki/genshin/wapi/entry_page')
    u.searchParams.set('app_sn', 'ys_obc')
    u.searchParams.set('entry_page_id', id)
    const j = await (await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } })).json()
    const page = j?.data?.page
    if (!page) continue

    const text = await buildBookTextFromEntryPage(page)
    if (!text) continue

    const out = `${slugify(name)}.txt`
    await fs.writeFile(path.join(booksRoot, out), text, 'utf8')
    index.books.push({ title: name, file: out, source: `wiki:${id}` })
  }

  index.books.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
  await saveIndex(index)
  return { total: index.books.length }
}

async function replyLong(e, text) {
  const max = 1600
  if (text.length <= max) return e.reply(text)

  let start = 0
  while (start < text.length) {
    const chunk = text.slice(start, start + max)
    await e.reply(chunk)
    start += max
  }
  return true
}

export class BookDex extends plugin {
  constructor() {
    super({
      name: '书籍角色文本图鉴（bookdex-plugin）',
      dsc: '书籍、角色故事、圣遗物与武器文本检索',
      event: 'message',
      priority: 5000,
      rule: [
        {
          reg: '^#(书角图鉴帮助|书籍图鉴帮助|bookdex帮助)$',
          fnc: 'totalHelp'
        },
        {
          reg: '^#书籍帮助\\d*$',
          fnc: 'bookHelp'
        },
        {
          reg: '^#书籍导入$',
          fnc: 'importBooks',
          permission: 'master'
        },
        {
          reg: '^#书籍更新$',
          fnc: 'updateBooksFromWiki',
          permission: 'master'
        },
        {
          reg: '^#统一更新$',
          fnc: 'updateAllTextsCommand',
          permission: 'master'
        },
        {
          reg: '^#角色故事更新$',
          fnc: 'updateRoleStories',
          permission: 'master'
        },
        {
          reg: '^#语音更新$',
          fnc: 'updateVoices',
          permission: 'master'
        },
        {
          reg: '^#剧情更新$',
          fnc: 'updatePlots',
          permission: 'master'
        },
        {
          reg: '^#角色故事帮助$',
          fnc: 'roleStoryHelp'
        },
        {
          reg: '^#语音帮助$',
          fnc: 'voiceHelp'
        },
        {
          reg: '^#剧情帮助$',
          fnc: 'plotHelp'
        },
        {
          reg: '^#.+语音(文本)?$',
          fnc: 'voiceRead'
        },
        {
          reg: '^#.+剧情(文本)?$',
          fnc: 'plotRead'
        },
        {
          reg: '^#.+故事(详情)?(文本)?$',
          fnc: 'roleStoryRead'
        },
        {
          reg: '^#圣遗物更新$',
          fnc: 'updateRelics',
          permission: 'master'
        },
        {
          reg: '^#圣遗物帮助$',
          fnc: 'relicHelp'
        },
        {
          reg: '^#.+圣遗物(文本)?$',
          fnc: 'relicRead'
        },
        {
          reg: '^#武器更新$',
          fnc: 'updateWeapons',
          permission: 'master'
        },
        {
          reg: '^#武器帮助$',
          fnc: 'weaponHelp'
        },
        {
          reg: '^#.+武器故事(文本)?$',
          fnc: 'weaponRead'
        },
        {
          reg: '^#(书籍搜索|搜书).*$',
          fnc: 'searchBooks'
        },
        {
          reg: '^#角色故事搜索\s*.+$',
          fnc: 'searchRoleStories'
        },
        {
          reg: '^#圣遗物搜索\s*.+$',
          fnc: 'searchRelics'
        },
        {
          reg: '^#武器搜索\s*.+$',
          fnc: 'searchWeapons'
        },
        {
          reg: '^#语音搜索\s*.+$',
          fnc: 'searchVoices'
        },
        {
          reg: '^#剧情搜索\s*.+$',
          fnc: 'searchPlots'
        },
        {
          reg: '^#搜索\s*.+$',
          fnc: 'searchAll'
        },
        {
          reg: '^\\d{1,3}(文本|语音)?$',
          fnc: 'pickByIndex'
        },
        {
          reg: '^#([^\\s#].+)$',
          fnc: 'pickByTitle'
        }
      ]
    })
  }

  init() {
    this.task = [
      {
        name: '文本库自动更新窗口检查',
        cron: '0 0 0 * * ?',
        fnc: this.autoUpdateWindowTick.bind(this)
      }
    ]
  }

  getNowGmt8() {
    const now = Date.now()
    return new Date(now + 8 * 3600 * 1000)
  }

  shouldRunAutoUpdateWindow() {
    // 基准：2026-04-08 00:00 (GMT+8)
    // 用户要求：1-5天，不包含当天0点 => 只在 cycleDay 1..5 执行
    const baseUtc = Date.UTC(2026, 3, 7, 16, 0, 0)
    const now = Date.now()
    const days = Math.floor((now - baseUtc) / 86400000)
    const cycleDay = ((days % 42) + 42) % 42
    return cycleDay >= 1 && cycleDay <= 5
  }

  async updateAllTextsCommand() {
    return this.updateAllTexts(false)
  }

  async updateAllTexts(silent = false) {
    if (typeof silent !== 'boolean') silent = false

    if (!silent) await this.reply('开始统一更新（1/5）：准备任务')

    if (!silent) await this.reply('统一更新（2/5）：正在更新书籍数据…')
    const b = await fetchBooksFromWiki()

    if (!silent) await this.reply('统一更新（3/5）：正在更新角色故事数据…')
    const r = await fetchRoleStoryAll()

    if (!silent) await this.reply('统一更新（4/6）：正在更新圣遗物与武器数据…')
    const s = await fetchRelicAll()
    const w = await fetchWeaponAll()

    if (!silent) await this.reply('统一更新（5/7）：正在更新角色语音数据…')
    const v = await fetchVoiceAll()

    if (!silent) await this.reply('统一更新（6/7）：正在更新剧情文本数据…')
    const p = await fetchPlotAll()

    const msg = [
      '统一更新完成 ✅（7/7）',
      `书籍：${b.total} 本`,
      `角色故事：${r.total} 个`,
      `圣遗物：${s.total} 套`,
      `武器故事：${w.total} 把`,
      `角色语音：${v.total} 个角色`,
      `剧情文本：${p.total} 条`
    ].join('\n')

    if (!silent) return this.reply(msg)
    logger.mark('[bookdex.autoUpdate] ' + msg.replace(/\n/g, ' | '))
    return true
  }

  async autoUpdateWindowTick() {
    if (!this.shouldRunAutoUpdateWindow()) return false
    try {
      await this.updateAllTexts(true)
    } catch (err) {
      logger.error('[bookdex.autoUpdateWindowTick]', err)
    }
    return true
  }

  async totalHelp() {
    await ensureDirs()
    const helpImg = path.join(pluginDir, 'resources', 'help-main.jpg')
    if (fss.existsSync(helpImg)) {
      await this.reply(segment.image(`file://${helpImg}`))
      return true
    }
    return this.reply('总帮助图缺失，请先更新插件资源后重试。')
  }

  async bookHelp() {
    await ensureDirs()
    const index = await loadIndex()
    const books = index.books || []

    helpSessionCache.set(this.userKey(), {
      at: Date.now(),
      type: 'book',
      books
    })

    if (!books.length) {
      return this.reply(`暂无书籍。请先将 txt/docx 放入 plugins/${pluginFolder}/data/inbox 后，发送 #书籍导入`)
    }

    const rendered = await renderHelpImage(this.e, books)
    if (rendered) {
      if (typeof rendered === 'string') {
        await this.reply(segment.image(`file://${rendered}`))
        return true
      }
      return true
    }

    const lines = books.map((b, i) => `${i + 1}. ${b.title}`)
    lines.unshift(`📚 书籍图鉴（共 ${books.length} 本，单页）`, '发送：引用本条后输入序号，或 #书名；加“文本”返回纯文本')
    return this.reply(lines.join('\n'))
  }

  async importBooks() {
    const ret = await rebuildBooksFromInbox()
    return this.reply(`导入完成：新增/重建 ${ret.created} 本，当前书库 ${ret.total} 本。\n命令：#书籍帮助`)
  }

  async updateRoleStories() {
    await this.reply('开始抓取角色故事，请稍等（首次可能1-3分钟）')
    const ret = await fetchRoleStoryAll()
    return this.reply(`角色故事更新完成：共 ${ret.total} 个角色。\n命令：#角色故事帮助`)
  }

  async roleStoryHelp() {
    const idx = await loadStoryIndex()
    const roles = idx.roles || []
    if (!roles.length) {
      return this.reply('暂无角色故事数据，请先发送 #角色故事更新')
    }

    const lines = roles.map((r, i) => `${i + 1}. ${r.name}`)
    const head = [
      `📚 角色故事列表（共 ${roles.length}）`,
      '命令：#角色名故事 / #角色名故事详情 / 可加“文本”'
    ]
    return this.reply([...head, ...lines].join('\n'))
  }

  async roleStoryRead() {
    const msg = this.e.msg.trim()
    const m = msg.match(/^#(.+?)故事(详情)?(文本)?$/)
    if (!m) return false

    const roleNameRaw = (m[1] || '').trim()
    const wantDetail = Boolean(m[2])
    const forceText = Boolean(m[3])
    if (!roleNameRaw) return false

    const idx = await loadStoryIndex()
    const roles = idx.roles || []
    if (!roles.length) return this.reply('暂无角色故事数据，请先发送 #角色故事更新')

    const key = normalizeRoleName(roleNameRaw)
    const roleMeta = roles.find(r => normalizeRoleName(r.name) === key || (r.alias || []).includes(key))
      || roles.find(r => normalizeRoleName(r.name).includes(key) || key.includes(normalizeRoleName(r.name)))

    if (!roleMeta) return false

    const file = path.join(storyRoot, `${slugify(roleMeta.name)}.json`)
    if (!fss.existsSync(file)) return this.reply(`未找到角色故事：${roleMeta.name}`)
    const role = JSON.parse(await fs.readFile(file, 'utf8'))

    const text = renderRoleStoryText(role, wantDetail ? 'detail' : 'story')
    if (forceText) return replyLong(this.e, text)

    const imgs = await renderTextAsImages(wantDetail ? `${role.name}故事详情` : `${role.name}故事`, text)
    for (const img of imgs) {
      await this.reply(segment.image(`file://${img}`))
    }
    return true
  }


  async updateVoices() {
    await this.reply('开始抓取角色语音，请稍等（约1-3分钟）')
    const ret = await fetchVoiceAll()
    return this.reply(`角色语音更新完成：共 ${ret.total} 个角色。\n命令：#语音帮助`)
  }

  async voiceHelp() {
    const idx = await loadVoiceIndex()
    const roles = idx.roles || []
    if (!roles.length) return this.reply('暂无角色语音数据，请先发送 #语音更新')

    helpSessionCache.set(this.userKey(), {
      at: Date.now(),
      type: 'voice-role',
      roles
    })

    const lines = roles.map((r, i) => `${i + 1}. ${r.name}`)
    return this.reply([`🎙️ 角色语音列表（共 ${roles.length}）`, '命令：#角色名语音 / #角色名语音文本 / #语音搜索 关键词', ...lines].join('\n'))
  }

  async voiceRead() {
    const msg = this.e.msg.trim()
    const m = msg.match(/^#(.+?)语音(文本)?$/)
    if (!m) return false
    const raw = (m[1] || '').trim()
    const forceText = Boolean(m[2])
    if (!raw) return false

    const idx = await loadVoiceIndex()
    const roles = idx.roles || []
    if (!roles.length) return this.reply('暂无角色语音数据，请先发送 #语音更新')

    const key = normalizeRoleName(raw)
    const meta = roles.find(r => normalizeRoleName(r.name) === key || (r.alias || []).includes(key))
      || roles.find(r => normalizeRoleName(r.name).includes(key) || key.includes(normalizeRoleName(r.name)))
    if (!meta) return false

    const file = path.join(voiceRoot, `${slugify(meta.name)}.json`)
    if (!fss.existsSync(file)) return this.reply(`未找到角色语音：${meta.name}`)
    const voice = JSON.parse(await fs.readFile(file, 'utf8'))
    const tab = pickDefaultVoiceTab(voice)

    helpSessionCache.set(this.userKey(), {
      at: Date.now(),
      type: 'voice-entry',
      role: voice.name,
      lang: tab.lang,
      entries: (tab.items || []).map(item => ({ role: voice.name, lang: tab.lang, ...item }))
    })

    const text = renderVoiceListText(voice, forceText)
    if (forceText) return replyLong(this.e, text)

    const imgs = await renderTextAsImages(`${voice.name}语音列表`, text)
    for (const img of imgs) await this.reply(segment.image(`file://${img}`))
    return true
  }


  async updatePlots() {
    await this.reply('开始抓取剧情文本，请稍等（首次可能需要几分钟）')
    const ret = await fetchPlotAll()
    return this.reply(`剧情文本更新完成：共 ${ret.total} 条剧情。\n命令：#剧情帮助`)
  }

  async plotHelp() {
    const idx = await loadPlotIndex()
    const items = idx.items || []
    if (!items.length) return this.reply('暂无剧情文本数据，请先发送 #剧情更新')

    helpSessionCache.set(this.userKey(), {
      at: Date.now(),
      type: 'plot',
      plots: items
    })

    const order = ['魔神任务', '传说任务', '世界任务', '限时任务', '其他任务']
    const grouped = new Map(order.map(k => [k, []]))
    for (const item of items) {
      const key = order.includes(item.category) ? item.category : '其他任务'
      grouped.get(key).push(item)
    }

    await this.reply(`📜 剧情文本列表（共 ${items.length}）\n命令：#任务名剧情 / #任务名剧情文本 / #剧情搜索 关键词`)
    let no = 1
    for (const key of order) {
      const arr = grouped.get(key) || []
      if (!arr.length) continue
      const block = [`【${key}｜${arr.length}】`]
      for (const item of arr) {
        block.push(`${no}. ${item.name}`)
        no++
      }
      for (const part of chunkLines(block, 40)) {
        await this.reply(part.join('\n'))
      }
    }
    return true
  }

  async plotRead() {
    const msg = this.e.msg.trim()
    const m = msg.match(/^#(.+?)剧情(文本)?$/)
    if (!m) return false
    const raw = (m[1] || '').trim()
    const forceText = Boolean(m[2])
    if (!raw) return false

    const idx = await loadPlotIndex()
    const items = idx.items || []
    if (!items.length) return this.reply('暂无剧情文本数据，请先发送 #剧情更新')

    const key = normalizeRoleName(raw)
    const meta = items.find(r => normalizeRoleName(r.name) === key || (r.alias || []).includes(key))
      || items.find(r => normalizeRoleName(r.name).includes(key) || key.includes(normalizeRoleName(r.name)))
    if (!meta) return false

    const file = path.join(plotRoot, `${slugify(meta.name)}.json`)
    if (!fss.existsSync(file)) return this.reply(`未找到剧情文本：${meta.name}`)
    const item = JSON.parse(await fs.readFile(file, 'utf8'))
    const text = renderPlotText(item, 'full')
    if (forceText) return replyLong(this.e, text)

    const imgs = await renderTextAsImages(`${item.name}剧情`, text)
    for (const img of imgs) await this.reply(segment.image(`file://${img}`))
    return true
  }

  async updateRelics() {
    await this.reply('开始抓取圣遗物文本，请稍等（约1-2分钟）')
    const ret = await fetchRelicAll()
    return this.reply(`圣遗物更新完成：共 ${ret.total} 套。\n命令：#圣遗物帮助`)
  }

  async relicHelp() {
    const idx = await loadRelicIndex()
    const sets = idx.sets || []
    if (!sets.length) return this.reply('暂无圣遗物数据，请先发送 #圣遗物更新')
    helpSessionCache.set(this.userKey(), {
      at: Date.now(),
      type: 'relic',
      relics: sets
    })

    const lines = sets.map((s, i) => `${i + 1}. ${s.name}`)
    return this.reply([`📗 圣遗物列表（共 ${sets.length} 套）`, '命令：#套装名圣遗物 / #套装名圣遗物文本；也可引用本条发序号', ...lines].join('\n'))
  }

  async relicRead() {
    const msg = this.e.msg.trim()
    const m = msg.match(/^#(.+?)圣遗物(文本)?$/)
    if (!m) return false
    const raw = (m[1] || '').trim()
    const forceText = Boolean(m[2])
    if (!raw) return false

    const idx = await loadRelicIndex()
    const sets = idx.sets || []
    if (!sets.length) return this.reply('暂无圣遗物数据，请先发送 #圣遗物更新')

    const key = normalizeRoleName(raw)
    const meta = sets.find(s => normalizeRoleName(s.name) === key || (s.alias || []).includes(key))
      || sets.find(s => normalizeRoleName(s.name).includes(key) || key.includes(normalizeRoleName(s.name)))
    if (!meta) return false

    const file = path.join(relicRoot, `${slugify(meta.name)}.json`)
    if (!fss.existsSync(file)) return this.reply(`未找到圣遗物：${meta.name}`)
    const set = JSON.parse(await fs.readFile(file, 'utf8'))
    const text = renderRelicText(set)

    if (forceText) return replyLong(this.e, text)

    const imgs = await renderTextAsImages(`${set.name}圣遗物`, text)
    for (const img of imgs) await this.reply(segment.image(`file://${img}`))
    return true
  }

  async updateWeapons() {
    await this.reply('开始抓取武器故事，请稍等（约1-2分钟）')
    const ret = await fetchWeaponAll()
    return this.reply(`武器故事更新完成：共 ${ret.total} 把武器。\n命令：#武器帮助`)
  }

  async weaponHelp() {
    const idx = await loadWeaponIndex()
    const weapons = idx.weapons || []
    if (!weapons.length) return this.reply('暂无武器故事数据，请先发送 #武器更新')

    helpSessionCache.set(this.userKey(), {
      at: Date.now(),
      type: 'weapon',
      weapons
    })

    const lines = weapons.map((w, i) => `${i + 1}. ${w.name}`)
    return this.reply([`📘 武器列表（共 ${weapons.length}）`, '命令：#武器名武器故事 / #武器名武器故事文本', ...lines].join('\n'))
  }

  async weaponRead() {
    const msg = this.e.msg.trim()
    const m = msg.match(/^#(.+?)武器故事(文本)?$/)
    if (!m) return false
    const raw = (m[1] || '').trim()
    const forceText = Boolean(m[2])
    if (!raw) return false

    const idx = await loadWeaponIndex()
    const weapons = idx.weapons || []
    if (!weapons.length) return this.reply('暂无武器故事数据，请先发送 #武器更新')

    const key = normalizeRoleName(raw)
    const meta = weapons.find(w => normalizeRoleName(w.name) === key || (w.alias || []).includes(key))
      || weapons.find(w => normalizeRoleName(w.name).includes(key) || key.includes(normalizeRoleName(w.name)))
    if (!meta) return false

    const file = path.join(weaponRoot, `${slugify(meta.name)}.json`)
    if (!fss.existsSync(file)) return this.reply(`未找到武器：${meta.name}`)
    const weapon = JSON.parse(await fs.readFile(file, 'utf8'))
    const text = renderWeaponText(weapon)

    if (forceText) return replyLong(this.e, text)

    const imgs = await renderTextAsImages(`${weapon.name}武器故事`, text)
    for (const img of imgs) await this.reply(segment.image(`file://${img}`))
    return true
  }

  async updateBooksFromWiki() {
    await this.reply('开始从原神图鉴抓取书籍，请稍等（约1-3分钟）')
    const ret = await fetchBooksFromWiki()
    return this.reply(`书籍更新完成：共 ${ret.total} 本。\n命令：#书籍帮助`)
  }

  async runTextSearch(keyword, types = ['book']) {
    const rows = []

    if (types.includes('book')) {
      const bi = await loadIndex()
      for (const b of bi.books || []) {
        const full = path.join(booksRoot, b.file)
        if (!fss.existsSync(full)) continue
        const text = await fs.readFile(full, 'utf8')
        const titleHit = b.title.includes(keyword)
        const textHit = text.includes(keyword)
        if (titleHit || textHit) rows.push({ type: 'book', name: b.title, snippet: textHit ? makeSnippet(text, keyword) : '' })
      }
    }

    if (types.includes('role')) {
      const ri = await loadStoryIndex()
      for (const r of ri.roles || []) {
        const full = path.join(storyRoot, `${slugify(r.name)}.json`)
        if (!fss.existsSync(full)) continue
        const data = JSON.parse(await fs.readFile(full, 'utf8'))
        const merged = [data.detail || '', ...(data.stories || []).map(s => s.text || ''), ...(data.others || []).map(s => s.text || '')].join('\n')
        const titleHit = r.name.includes(keyword)
        const textHit = merged.includes(keyword)
        if (titleHit || textHit) rows.push({ type: 'role', name: r.name, snippet: textHit ? makeSnippet(merged, keyword) : '' })
      }
    }

    if (types.includes('relic')) {
      const ri = await loadRelicIndex()
      for (const s of ri.sets || []) {
        const full = path.join(relicRoot, `${slugify(s.name)}.json`)
        if (!fss.existsSync(full)) continue
        const data = JSON.parse(await fs.readFile(full, 'utf8'))
        const merged = (data.pieces || []).map(p => `${p.name}\n${p.desc}\n${p.story}`).join('\n')
        const titleHit = s.name.includes(keyword)
        const textHit = merged.includes(keyword)
        if (titleHit || textHit) rows.push({ type: 'relic', name: s.name, snippet: textHit ? makeSnippet(merged, keyword) : '' })
      }
    }

    if (types.includes('weapon')) {
      const wi = await loadWeaponIndex()
      for (const w of wi.weapons || []) {
        const full = path.join(weaponRoot, `${slugify(w.name)}.json`)
        if (!fss.existsSync(full)) continue
        const data = JSON.parse(await fs.readFile(full, 'utf8'))
        const merged = data.story || ''
        const titleHit = w.name.includes(keyword)
        const textHit = merged.includes(keyword)
        if (titleHit || textHit) rows.push({ type: 'weapon', name: w.name, snippet: textHit ? makeSnippet(merged, keyword) : '' })
      }
    }

    if (types.includes('voice')) {
      const vi = await loadVoiceIndex()

      for (const r of vi.roles || []) {
        const full = path.join(voiceRoot, `${slugify(r.name)}.json`)
        if (!fss.existsSync(full)) continue
        const data = JSON.parse(await fs.readFile(full, 'utf8'))
        for (const tab of data.tabs || []) {
          if (!['汉语', '中文'].includes(tab.lang)) continue
          for (const item of tab.items || []) {
            const merged = `${item.name || ''}
${item.text || ''}`
            const titleHit = r.name.includes(keyword) || (item.name || '').includes(keyword)
            const textHit = merged.includes(keyword)
            if (titleHit || textHit) {
              rows.push({ type: 'voice', name: `${r.name}｜${item.name}`, role: r.name, lang: tab.lang, voiceName: item.name, text: item.text || '', audioUrl: item.audioUrl || '', snippet: textHit ? makeSnippet(merged, keyword) : '' })
            }
          }
        }
      }
    }

    if (types.includes('plot')) {
      const pi = await loadPlotIndex()
      for (const it of pi.items || []) {
        const full = path.join(plotRoot, `${slugify(it.name)}.json`)
        if (!fss.existsSync(full)) continue
        const data = JSON.parse(await fs.readFile(full, 'utf8'))
        const merged = [
          (data.sections || []).map(s => `${s.title || ''}\n${s.text || ''}`).join('\n'),
          data.searchText || ''
        ].join('\n')
        const titleHit = it.name.includes(keyword) || (data.category || '').includes(keyword)
        const textHit = merged.includes(keyword)
        if (titleHit || textHit) rows.push({ type: 'plot', name: it.name, snippet: textHit ? makeSnippet(merged, keyword) : '' })
      }
    }

    return rows
  }

  async replySearch(keyword, types) {
    await this.reply(`🔎 正在搜索：${keyword}`)
    const rows = await this.runTextSearch(keyword, types)
    if (!rows.length) return this.reply(`未找到关键词“${keyword}”`)

    helpSessionCache.set(this.userKey(), {
      at: Date.now(),
      type: 'search',
      results: rows
    })

    const mapLabel = { book: '书籍', role: '角色', relic: '圣遗物', weapon: '武器', voice: '语音', plot: '剧情' }
    const lines = rows.map((r, i) => `${i + 1}. [${mapLabel[r.type]}] ${r.name}${r.snippet ? `\n  ↳ ${r.snippet}` : ''}`)

    await this.reply(`🔎 关键词：${keyword}\n共找到 ${rows.length} 条\n可引用本搜索结果发序号查看详情（可加“文本”或“语音”）`)
    for (const part of chunkLines(lines, 20)) {
      await this.reply(part.join('\n'))
    }
    return true
  }

  async searchRoleStories() {
    const keyword = this.e.msg.replace(/^#角色故事搜索\s*/, '').trim()
    if (!keyword) return this.reply('请输入关键词')
    return this.replySearch(keyword, ['role'])
  }

  async searchRelics() {
    const keyword = this.e.msg.replace(/^#圣遗物搜索\s*/, '').trim()
    if (!keyword) return this.reply('请输入关键词')
    return this.replySearch(keyword, ['relic'])
  }

  async searchWeapons() {
    const keyword = this.e.msg.replace(/^#武器搜索\s*/, '').trim()
    if (!keyword) return this.reply('请输入关键词')
    return this.replySearch(keyword, ['weapon'])
  }


  async searchVoices() {
    const keyword = this.e.msg.replace(/^#语音搜索\s*/, '').trim()
    if (!keyword) return this.reply('请输入关键词')
    return this.replySearch(keyword, ['voice'])
  }

  async searchPlots() {
    const keyword = this.e.msg.replace(/^#剧情搜索\s*/, '').trim()
    if (!keyword) return this.reply('请输入关键词')
    return this.replySearch(keyword, ['plot'])
  }

  async searchAll() {
    const keyword = this.e.msg.replace(/^#搜索\s*/, '').trim()
    if (!keyword) return this.reply('请输入关键词')
    return this.replySearch(keyword, ['book', 'role', 'relic', 'weapon', 'voice', 'plot'])
  }

  async searchBooks() {
    try {
      const keyword = this.e.msg.replace(/^#(书籍搜索|搜书)\s*/, '').trim()
      if (!keyword) return this.reply('请输入关键词，例如：#书籍搜索 稻妻')

      await this.reply(`🔎 正在搜索：${keyword}`)

      const index = await loadIndex()
      const books = index.books || []

      // 让“引用搜索结果后发序号”也能直接读书
      helpSessionCache.set(this.userKey(), {
        at: Date.now(),
        type: 'book',
        books
      })

      const hit = []
      for (let i = 0; i < books.length; i++) {
        const b = books[i]
        const no = i + 1
        const titleHit = b.title.includes(keyword)

        let contentHit = false
        let snippet = ''
        const full = path.join(booksRoot, b.file)
        if (fss.existsSync(full)) {
          try {
            const content = await fs.readFile(full, 'utf8')
            const idx = content.indexOf(keyword)
            if (idx >= 0) {
              contentHit = true
              const start = Math.max(0, idx - 36)
              const end = Math.min(content.length, idx + keyword.length + 48)
              snippet = content.slice(start, end).replace(/\s+/g, ' ').trim()
            }
          } catch {
            contentHit = false
          }
        }

        if (titleHit || contentHit) {
          hit.push({ ...b, no, titleHit, contentHit, snippet })
        }
      }

      if (!hit.length) return this.reply(`未找到关键词“${keyword}”相关书籍（已检索书名+正文）`)

      const lines = hit.map(b => {
        const flag = b.titleHit && b.contentHit
          ? '【书名+正文】'
          : b.titleHit
            ? '【书名】'
            : '【正文】'
        if (b.contentHit && b.snippet) {
          return `${b.no}. ${b.title} ${flag}\n  ↳ ${b.snippet}`
        }
        return `${b.no}. ${b.title} ${flag}`
      })

      const header = [
        `🔎 关键词：${keyword}`,
        `共找到 ${hit.length} 本`,
        '可直接发送 #书名 阅读；也可引用本搜索结果发送序号（可加“文本”）'
      ]

      // QQ 单条过长可能不下发，按块发送
      const chunkSize = 30
      await this.reply(header.join('\n'))
      for (let i = 0; i < lines.length; i += chunkSize) {
        const part = lines.slice(i, i + chunkSize)
        await this.reply(part.join('\n'))
      }
      return true
    } catch (err) {
      logger.error('[bookdex.searchBooks] ', err)
      return this.reply(`搜索失败：${err?.message || err}`)
    }
  }

  userKey() {
    return `${this.e.self_id || 'bot'}:${this.e.group_id || this.e.user_id || 'u'}`
  }

  async pickByIndex() {
    const raw = this.e.msg.trim()
    const idx = Number(raw.replace(/(文本|语音)$/, ''))
    if (!idx || idx < 1) return false

    const forceText = /文本$/.test(raw)
    const wantVoice = /语音$/.test(raw)
    let session = helpSessionCache.get(this.userKey())

    // 1) 优先按最近帮助类型分发
    if (session?.type === 'relic' && Array.isArray(session.relics)) {
      const meta = session.relics[idx - 1]
      if (!meta) return this.reply('序号超出范围，请先发送 #圣遗物帮助')
      const file = path.join(relicRoot, `${slugify(meta.name)}.json`)
      if (!fss.existsSync(file)) return this.reply(`未找到圣遗物：${meta.name}`)
      const set = JSON.parse(await fs.readFile(file, 'utf8'))
      const text = renderRelicText(set)
      if (forceText) return replyLong(this.e, text)
      const imgs = await renderTextAsImages(`${set.name}圣遗物`, text)
      for (const img of imgs) await this.reply(segment.image(`file://${img}`))
      return true
    }

    if (session?.type === 'voice-role' && Array.isArray(session.roles)) {
      const meta = session.roles[idx - 1]
      if (!meta) return this.reply('序号超出范围，请先发送 #语音帮助')
      const file = path.join(voiceRoot, `${slugify(meta.name)}.json`)
      if (!fss.existsSync(file)) return this.reply(`未找到角色语音：${meta.name}`)
      const voice = JSON.parse(await fs.readFile(file, 'utf8'))
      const tab = pickDefaultVoiceTab(voice)
      const entries = (tab.items || []).map(item => ({ role: voice.name, lang: tab.lang, ...item }))
      helpSessionCache.set(this.userKey(), { at: Date.now(), type: 'voice-entry', role: voice.name, lang: tab.lang, entries })
      const text = renderVoiceListText(voice, forceText)
      if (forceText) return replyLong(this.e, text)
      const imgs = await renderTextAsImages(`${voice.name}语音列表`, text)
      for (const img of imgs) await this.reply(segment.image(`file://${img}`))
      return true
    }

    if (session?.type === 'voice-entry' && Array.isArray(session.entries)) {
      const entry = session.entries[idx - 1]
      if (!entry) return this.reply('序号超出范围，请先重新打开语音列表')
      if (wantVoice) return sendVoiceRecord(this.e, entry.audioUrl)
      const text = renderVoiceEntryText(entry)
      if (forceText) return replyLong(this.e, text)
      const imgs = await renderTextAsImages(`${entry.role}语音`, text)
      for (const img of imgs) await this.reply(segment.image(`file://${img}`))
      return true
    }

    if (session?.type === 'weapon' && Array.isArray(session.weapons)) {
      const meta = session.weapons[idx - 1]
      if (!meta) return this.reply('序号超出范围，请先发送 #武器帮助')
      const file = path.join(weaponRoot, `${slugify(meta.name)}.json`)
      if (!fss.existsSync(file)) return this.reply(`未找到武器：${meta.name}`)
      const weapon = JSON.parse(await fs.readFile(file, 'utf8'))
      const text = renderWeaponText(weapon)
      if (forceText) return replyLong(this.e, text)
      const imgs = await renderTextAsImages(`${weapon.name}武器故事`, text)
      for (const img of imgs) await this.reply(segment.image(`file://${img}`))
      return true
    }

    if (session?.type === 'search' && Array.isArray(session.results)) {
      const row = session.results[idx - 1]
      if (!row) return this.reply('序号超出范围，请重新搜索')
      if (row.type === 'book') {
        const bi = await loadIndex()
        const b = (bi.books || []).find(x => x.title === row.name)
        if (!b) return this.reply(`未找到书籍：${row.name}`)
        const full = path.join(booksRoot, b.file)
        const content = await fs.readFile(full, 'utf8')
        if (forceText) return replyLong(this.e, content)
        const imgs = await renderTextAsImages(b.title, content)
        for (const img of imgs) await this.reply(segment.image(`file://${img}`))
        return true
      }
      if (row.type === 'role') {
        const f = path.join(storyRoot, `${slugify(row.name)}.json`)
        if (!fss.existsSync(f)) return this.reply(`未找到角色故事：${row.name}`)
        const role = JSON.parse(await fs.readFile(f, 'utf8'))
        const text = renderRoleStoryText(role, 'story')
        if (forceText) return replyLong(this.e, text)
        const imgs = await renderTextAsImages(`${role.name}故事`, text)
        for (const img of imgs) await this.reply(segment.image(`file://${img}`))
        return true
      }
      if (row.type === 'relic') {
        const f = path.join(relicRoot, `${slugify(row.name)}.json`)
        if (!fss.existsSync(f)) return this.reply(`未找到圣遗物：${row.name}`)
        const set = JSON.parse(await fs.readFile(f, 'utf8'))
        const text = renderRelicText(set)
        if (forceText) return replyLong(this.e, text)
        const imgs = await renderTextAsImages(`${set.name}圣遗物`, text)
        for (const img of imgs) await this.reply(segment.image(`file://${img}`))
        return true
      }
      if (row.type === 'weapon') {
        const f = path.join(weaponRoot, `${slugify(row.name)}.json`)
        if (!fss.existsSync(f)) return this.reply(`未找到武器：${row.name}`)
        const w = JSON.parse(await fs.readFile(f, 'utf8'))
        const text = renderWeaponText(w)
        if (forceText) return replyLong(this.e, text)
        const imgs = await renderTextAsImages(`${w.name}武器故事`, text)
        for (const img of imgs) await this.reply(segment.image(`file://${img}`))
        return true
      }
      if (row.type === 'voice') {
        const entry = { role: row.role, lang: row.lang, name: row.voiceName, text: row.text, audioUrl: row.audioUrl }
        if (wantVoice) return sendVoiceRecord(this.e, entry.audioUrl)
        const text = renderVoiceEntryText(entry)
        if (forceText) return replyLong(this.e, text)
        const imgs = await renderTextAsImages(`${entry.role}语音`, text)
        for (const img of imgs) await this.reply(segment.image(`file://${img}`))
        return true
      }
      if (row.type === 'plot') {
        const f = path.join(plotRoot, `${slugify(row.name)}.json`)
        if (!fss.existsSync(f)) return this.reply(`未找到剧情文本：${row.name}`)
        const item = JSON.parse(await fs.readFile(f, 'utf8'))
        const text = renderPlotText(item, 'full')
        if (forceText) return replyLong(this.e, text)
        const imgs = await renderTextAsImages(`${item.name}剧情`, text)
        for (const img of imgs) await this.reply(segment.image(`file://${img}`))
        return true
      }
    }

    // 2) 默认按书籍序号
    if (!session || !session.books?.length) {
      const index = await loadIndex()
      session = { type: 'book', books: index.books || [] }
    }

    const book = session.books[idx - 1]
    if (!book) return this.reply('序号超出范围，请先发送 #书籍帮助')

    const full = path.join(booksRoot, book.file)
    if (!fss.existsSync(full)) return this.reply(`书籍文件不存在：${book.title}`)
    const content = await fs.readFile(full, 'utf8')
    await this.reply(`📖 ${book.title}`)

    if (forceText) return replyLong(this.e, content)

    const imgs = await renderTextAsImages(book.title, content)
    for (const img of imgs) {
      await this.reply(segment.image(`file://${img}`))
    }
    return true
  }

  async pickByTitle() {
    const raw = this.e.msg.replace(/^#/, '').trim()
    if (!raw || raw.length < 2) return false
    if (/^书籍(帮助\d*|导入)$/.test(raw)) return false

    const forceText = /文本$/.test(raw)
    const title = raw.replace(/文本$/, '').trim()

    const index = await loadIndex()
    const books = index.books || []
    const exact = books.find(b => b.title === title)
    const fuzzy = exact || books.find(b => b.title.includes(title) || title.includes(b.title))

    if (!fuzzy) return false

    const full = path.join(booksRoot, fuzzy.file)
    if (!fss.existsSync(full)) return this.reply(`书籍文件不存在：${fuzzy.title}`)
    const content = await fs.readFile(full, 'utf8')
    await this.reply(`📖 ${fuzzy.title}`)

    if (forceText) return replyLong(this.e, content)

    const imgs = await renderTextAsImages(fuzzy.title, content)
    for (const img of imgs) {
      await this.reply(segment.image(`file://${img}`))
    }
    return true
  }
}

export default BookDex
