import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import mammoth from 'mammoth'
import puppeteer from 'puppeteer'
import {
  pluginDir,
  pluginFolder,
  booksRoot,
  inboxRoot,
  cacheRoot,
  tmpRoot,
  fontFile,
  defaultBg,
  storyRoot,
  relicRoot,
  weaponRoot,
  voiceRoot,
  plotRoot,
  slugify,
  ensureDirs,
  loadIndex,
  saveIndex,
  loadStoryIndex,
  loadRelicIndex,
  loadWeaponIndex,
  loadVoiceIndex,
  loadPlotIndex
} from './base.js'

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
  return total || NaN
}

function getBookModuleOrder(name = '') {
  const match = String(name).trim().match(/^第([一二三四五六七八九十百千两零\d]+)卷$/)
  if (!match) return null
  const order = parseChineseNumber(match[1])
  return Number.isFinite(order) ? order : null
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
      desc: `发送 ${no}（引用本条）或 #${b.title}；加“图片”返回图片`
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
  <div class='tip'>引用本图发“序号”读取文本；发“序号图片”/“#书名图片”输出图片</div>
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

async function renderMainHelpImage() {
  const bgData = await pickBgDataUri()
  const fontData = await pickFontDataUri()
  const sections = [
    {
      title: '帮助与查看',
      lines: [
        '#书角图鉴帮助 / #书籍图鉴帮助 / #bookdex帮助',
        '#书籍帮助 / #角色故事帮助 / #语音帮助 / #剧情帮助',
        '#圣遗物帮助 / #武器帮助'
      ]
    },
    {
      title: '直接读取',
      lines: [
        '#书名',
        '#角色名故事 / #角色名故事详情',
        '#角色名语音 / #任务名剧情 / #套装名圣遗物 / #武器名武器故事'
      ]
    },
    {
      title: '后缀命令',
      lines: [
        '默认返回文本',
        '加“图片”返回图片：#书名图片 / #任务名剧情图片',
        '语音列表中发“序号语音”播放语音'
      ]
    },
    {
      title: '搜索与序号',
      lines: [
        '#搜索 关键词',
        '#书籍搜索 / #角色故事搜索 / #语音搜索 / #剧情搜索',
        '#圣遗物搜索 / #武器搜索 关键词',
        '引用帮助或搜索结果发：序号 / 序号图片 / 序号语音'
      ]
    },
    {
      title: '更新命令',
      lines: [
        '#统一更新 / #重置更新',
        '#书籍更新 / #角色故事更新 / #语音更新 / #剧情更新',
        '#圣遗物更新 / #武器更新 / #书籍导入'
      ]
    }
  ]

  const cards = sections.map(sec => {
    const lines = sec.lines.map(line => `<div class="line">${escapeHtml(line)}</div>`).join('')
    return `<section class="card"><div class="sec-title">${escapeHtml(sec.title)}</div>${lines}</section>`
  }).join('')

  const html = `<!doctype html><html><head><meta charset='utf-8'/><style>
    ${fontData ? `@font-face{font-family:"BookDexFont";src:url(${fontData}) format("truetype");font-display:block;}` : ''}
    *{box-sizing:border-box;font-family:${fontData ? '"BookDexFont",' : ''}sans-serif !important;}
    body{margin:0;width:1440px;background:${bgData ? `url('${bgData}') center/cover no-repeat` : 'linear-gradient(135deg,#102033,#0b1220)'};color:#fff;}
    .mask{padding:34px;background:linear-gradient(180deg,rgba(15,23,42,.68),rgba(2,6,23,.84));}
    .hero{padding:24px 28px;border-radius:22px;background:rgba(15,23,42,.56);border:1px solid rgba(148,163,184,.35);}
    .title{font-size:46px;color:#fcd34d;font-weight:800}
    .sub{margin-top:8px;font-size:21px;color:#dbeafe;line-height:1.45}
    .grid{margin-top:18px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
    .card{padding:18px 18px 16px;border-radius:18px;background:rgba(15,23,42,.5);border:1px solid rgba(148,163,184,.28);min-height:180px}
    .sec-title{font-size:26px;font-weight:700;color:#fbbf24;margin-bottom:10px}
    .line{font-size:19px;line-height:1.55;color:#e2e8f0;margin:6px 0;word-break:break-all}
    .foot{margin-top:14px;font-size:18px;color:#cbd5e1}
  </style></head><body><div class='mask'><div class='hero'>
    <div class='title'>书籍图鉴帮助</div>
    <div class='sub'>覆盖书籍、角色故事、语音、剧情、圣遗物、武器故事。默认文本，带“图片”返回图片。</div>
    <div class='grid'>${cards}</div>
    <div class='foot'>引用帮助或搜索结果发送序号，可继续查看文本、图片或语音。</div>
  </div></div></body></html>`

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  try {
    const p = await browser.newPage()
    await p.setViewport({ width: 1440, height: 1800, deviceScaleFactor: 2 })
    await p.setContent(html, { waitUntil: 'domcontentloaded', timeout: 0 })
    const file = path.join(tmpRoot, `help-main-${Date.now()}.jpg`)
    await p.screenshot({ path: file, fullPage: true, type: 'jpeg', quality: 88 })
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
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] })
  try {
    const files = []
    const pages = splitTextPages(text, 1100)
    for (const [idx, body] of pages.entries()) {
      const page = await browser.newPage()
      try {
        const pageTitle = pages.length > 1 ? `${title}（${idx + 1}/${pages.length}）` : title
        const html = textPageHtml({ title: pageTitle, body, fontData })
        await page.setViewport({ width: 1120, height: 1400, deviceScaleFactor: 1.5 })
        await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 0 })
        const file = path.join(tmpRoot, `book-${Date.now()}-${idx + 1}.jpg`)
        await page.screenshot({ path: file, type: 'jpeg', quality: 82, fullPage: true })
        files.push(file)
      } finally {
        await page.close()
      }
    }
    return files
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

function buildPlotFileName(name = '', id = '') {
  const safeName = slugify(name || `plot-${id || Date.now()}`) || `plot-${id || Date.now()}`
  const safeId = String(id || '').replace(/[^\w-]/g, '')
  return safeId ? `${safeName}__${safeId}.json` : `${safeName}.json`
}

function resolvePlotFile(meta = {}) {
  const candidates = []
  if (meta.file) candidates.push(path.join(plotRoot, meta.file))
  if (meta.name && meta.id) candidates.push(path.join(plotRoot, buildPlotFileName(meta.name, meta.id)))
  if (meta.name) candidates.push(path.join(plotRoot, `${slugify(meta.name)}.json`))

  for (const full of candidates) {
    if (full && fss.existsSync(full)) return full
  }
  return candidates[0] || ''
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
  await ensureDirs()
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

  // 兜底：部分词条“剧情对话”模块是空壳，改抓“任务过程/任务概述”避免整条为空。
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

function parseInteractiveDialogue(component = {}) {
  if ((component.component_id || '') !== 'interactive_dialogue') return ''
  let data = {}
  try { data = JSON.parse(component.data || '{}') } catch { return '' }

  const blocks = []
  const groups = Array.isArray(data.list) && data.list.length ? data.list : [data]

  for (const group of groups) {
    const contents = group?.contents || data.contents || {}
    const childIds = group?.child_ids || data.child_ids || {}
    const orderedIds = []
    const seen = new Set()

    const pushId = (id) => {
      if (!id || seen.has(id)) return
      seen.add(id)
      orderedIds.push(id)
    }

    const walk = (id) => {
      if (!id || seen.has(id)) return
      pushId(id)
      for (const nid of (childIds?.[id] || [])) walk(nid)
    }

    walk(group?.root_id || data.root_id || '')

    for (const [id, nexts] of Object.entries(childIds || {})) {
      pushId(id)
      for (const nid of nexts || []) pushId(nid)
    }

    for (const id of Object.keys(contents || {})) pushId(id)

    const lines = []
    for (const id of orderedIds) {
      const node = contents?.[id]
      if (!node) continue
      const option = cleanPlotText(htmlToText(node.option || ''))
      const dialogue = cleanPlotText(htmlToText(node.dialogue || ''))
      if (option) lines.push(`【选项】${option}`)
      if (dialogue) lines.push(dialogue)
    }

    const txt = cleanPlotText(lines.join('\n'))
    if (txt) blocks.push(txt)
  }

  return cleanPlotText(blocks.join('\n\n'))
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
  await ensureDirs()
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
  await ensureDirs()
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
  await ensureDirs()
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
      const id = String(it.id || '').trim()
      if (id) map.set(id, it)
    }
  }

  const items = []
  const misses = []
  for (const it of map.values()) {
    const name = (it.title || it.name || '').trim() || `未命名任务-${it.id}`
    const id = String(it.id)
    const fileName = buildPlotFileName(name, id)
    const file = path.join(plotRoot, fileName)
    const u = new URL('https://act-api-takumi-static.mihoyo.com/hoyowiki/genshin/wapi/entry_page')
    u.searchParams.set('app_sn', 'ys_obc')
    u.searchParams.set('entry_page_id', id)
    const j = await (await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } })).json()
    const page = j?.data?.page
    if (!page) continue

    const sections = parsePlotPage(page)
    const searchText = parsePlotSearchText(page)
    const category = parsePlotCategory(it.ext)
    const item = { id, name, file: fileName, alias: [normalizeRoleName(name)], category, sections, searchText }

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
    items.push({ id, name, file: fileName, alias: item.alias, category, sectionCount: (item.sections || []).length })
  }

  items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || String(a.id).localeCompare(String(b.id)))
  await fs.writeFile(plotIndexFile, JSON.stringify({ items, updatedAt: Date.now() }, null, 2), 'utf8')
  await fs.writeFile(path.join(plotRoot, '_misses.json'), JSON.stringify({ total: misses.length, misses, updatedAt: Date.now() }, null, 2), 'utf8')
  return { total: items.length, misses: misses.length }
}

async function fetchVoiceAll() {
  await ensureDirs()
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
  const modules = [...(page.modules || [])]
  const orderedModules = modules
    .map((m, idx) => ({ idx, order: getBookModuleOrder(m?.name), module: m }))
    .sort((a, b) => {
      const av = a.order
      const bv = b.order
      if (av != null && bv != null) return av - bv || a.idx - b.idx
      if (av != null) return -1
      if (bv != null) return 1
      return a.idx - b.idx
    })
    .map(item => item.module)
  const segs = []
  for (const m of orderedModules) {
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
  const chunks = splitTextPages(text, 1600)
  if (chunks.length <= 1) return e.reply(text)
  return e.reply(await Bot.makeForwardArray(chunks))
}


export {
  inferTitleFromTxt,
  splitDocxBooks,
  parseChineseNumber,
  getBookModuleOrder,
  rebuildBooksFromInbox,
  buildHelpList,
  renderHelpImage,
  renderMainHelpImage,
  escapeHtml,
  splitTextPages,
  splitLeadingTitle,
  pickBgDataUri,
  pickFontDataUri,
  textPageHtml,
  renderTextAsImages,
  htmlToText,
  buildPlotFileName,
  resolvePlotFile,
  normalizeRoleName,
  pickSectionText,
  extractRoleStory,
  fetchRoleStoryAll,
  renderRoleStoryText,
  cleanPlotText,
  parsePlotCategory,
  collectPlotStrings,
  parseGenericPlotComponent,
  parsePlotPage,
  parsePlotSearchText,
  renderPlotText,
  parseInteractiveDialogue,
  parseRoleVoices,
  pickDefaultVoiceTab,
  renderVoiceListText,
  renderVoiceEntryText,
  sendVoiceRecord,
  parseRelicPiece,
  fetchRelicAll,
  renderRelicText,
  parseWeaponStory,
  fetchWeaponAll,
  fetchPlotAll,
  fetchVoiceAll,
  renderWeaponText,
  makeSnippet,
  chunkLines,
  buildBookTextFromEntryPage,
  fetchBooksFromWiki,
  replyLong
}
