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
const sessionCacheFile = path.join(cacheRoot, 'sessions.json')
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
const TEXT_PAGE_CHARS = 800
const TEXT_FORWARD_BATCH_SIZE = 6

const helpSessionCache = new Map()
let helpSessionCacheLoaded = false

function loadHelpSessionCache() {
  if (helpSessionCacheLoaded) return
  helpSessionCacheLoaded = true
  try {
    if (!fss.existsSync(sessionCacheFile)) return
    const raw = fss.readFileSync(sessionCacheFile, 'utf8')
    const parsed = JSON.parse(raw)
    for (const [key, value] of Object.entries(parsed || {})) {
      const sessions = Array.isArray(value) ? value : value ? [value] : []
      helpSessionCache.set(key, sessions.filter(Boolean))
    }
  } catch {}
}

function persistHelpSessionCache() {
  try {
    fss.mkdirSync(cacheRoot, { recursive: true })
    const data = Object.fromEntries(helpSessionCache)
    fss.writeFileSync(sessionCacheFile, JSON.stringify(data, null, 2), 'utf8')
  } catch {}
}

function isValidTrackedSession(session) {
  return Boolean(session && typeof session === 'object' && session.type)
}

function isReplyError(res) {
  return Boolean(res && typeof res === 'object' && Array.isArray(res.error) && res.error.length)
}

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

async function clearPluginData() {
  if (!fss.existsSync(dataRoot)) return
  const entries = await fs.readdir(dataRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'inbox') continue
    const full = path.join(dataRoot, entry.name)
    await fs.rm(full, { recursive: true, force: true })
  }
  await ensureDirs()
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
          reg: '^#.+语音(?:文本|图片)?$',
          fnc: 'voiceRead'
        },
        {
          reg: '^#.+剧情(?:文本|图片)?$',
          fnc: 'plotRead'
        },
        {
          reg: '^#.+故事(详情)?(?:文本|图片)?$',
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
          reg: '^#.+圣遗物(?:文本|图片)?$',
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
          reg: '^#.+武器故事(?:文本|图片)?$',
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
          reg: '^\\d{1,3}(文本|图片|语音)?$',
          fnc: 'pickByIndex'
        },
        {
          reg: '^#重置更新$',
          fnc: 'resetAndUpdate',
          permission: 'master'
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

    if (!silent) await this.reply('开始统一更新（1/7）：准备任务')

    if (!silent) await this.reply('统一更新（2/7）：正在更新书籍数据…')
    const b = await fetchBooksFromWiki()

    if (!silent) await this.reply('统一更新（3/7）：正在更新角色故事数据…')
    const r = await fetchRoleStoryAll()

    if (!silent) await this.reply('统一更新（4/7）：正在更新圣遗物与武器数据…')
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

  async resetAndUpdate() {
    await this.reply('开始重置 bookdex 数据（1/2）：正在清空本地缓存与文本库…')
    await clearPluginData()
    await this.reply('重置完成（2/2）：开始重新全量拉取数据…')
    return this.updateAllTexts(false)
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

    let session = this.saveSession({
      type: 'book',
      books
    })

    if (!books.length) {
      return this.reply(`暂无书籍。请先将 txt/docx 放入 plugins/${pluginFolder}/data/inbox 后，发送 #书籍导入`)
    }

    const lines = books.map((b, i) => `${i + 1}. ${b.title}`)
    session = await this.replyChunkedListWithSession(
      [`📚 书籍图鉴（共 ${books.length} 本）`, '发送：引用本条后输入序号，或 #书名；加“图片”返回图片'],
      lines,
      40,
      session
    )
    return Boolean(session)
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

    let session = this.saveSession({
      type: 'role',
      roles
    })

    const lines = roles.map((r, i) => `${i + 1}. ${r.name}`)
    const head = [
      `📚 角色故事列表（共 ${roles.length}）`,
      '命令：#角色名故事 / #角色名故事详情 / 可加“图片”'
    ]
    session = await this.replyChunkedListWithSession(head, lines, 40, session)
    return Boolean(session)
  }

  async roleStoryRead() {
    const msg = this.e.msg.trim()
    const m = msg.match(/^#(.+?)故事(详情)?(?:文本|图片)?$/)
    if (!m) return false

    const roleNameRaw = this.trimOutputSuffix((m[1] || '').trim())
    const wantDetail = Boolean(m[2])
    const { wantImage } = this.outputMode(msg)
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
    return this.replyContent(wantDetail ? `${role.name}故事详情` : `${role.name}故事`, text, wantImage)
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

    let session = this.saveSession({
      type: 'voice-role',
      roles
    })

    const lines = roles.map((r, i) => `${i + 1}. ${r.name}`)
    session = await this.replyChunkedListWithSession([`🎙️ 角色语音列表（共 ${roles.length}）`, '命令：#角色名语音 / #角色名语音图片 / #语音搜索 关键词'], lines, 40, session)
    return Boolean(session)
  }

  async voiceRead() {
    const msg = this.e.msg.trim()
    const m = msg.match(/^#(.+?)语音(?:文本|图片)?$/)
    if (!m) return false
    const raw = this.trimOutputSuffix((m[1] || '').trim())
    const { wantImage } = this.outputMode(msg)
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

    const session = this.saveSession({
      at: Date.now(),
      type: 'voice-entry',
      role: voice.name,
      lang: tab.lang,
      entries: (tab.items || []).map(item => ({ role: voice.name, lang: tab.lang, ...item }))
    })

    const text = renderVoiceListText(voice, false)
    return this.replyContent(`${voice.name}语音列表`, text, wantImage, session)
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

    const order = ['魔神任务', '传说任务', '世界任务', '限时任务', '其他任务']
    const grouped = new Map(order.map(k => [k, []]))
    for (const item of items) {
      const key = order.includes(item.category) ? item.category : '其他任务'
      grouped.get(key).push(item)
    }

    const orderedPlots = []
    let session = this.saveSession({
      type: 'plot',
      plots: orderedPlots
    })

    const blocks = []
    let no = 1
    for (const key of order) {
      const arr = grouped.get(key) || []
      if (!arr.length) continue
      const entries = []
      for (const item of arr) {
        orderedPlots.push(item)
        entries.push(`${no}. ${item.name}`)
        no++
      }
      const parts = chunkLines(entries, 25)
      parts.forEach((part, idx) => {
        const head = idx === 0 ? `【${key}｜${arr.length}】` : `【${key}｜续 ${idx + 1}】`
        blocks.push([head, ...part].join('\n'))
      })
    }
    session = await this.replyWithSession(`📜 剧情文本列表（共 ${items.length}）\n命令：#任务名剧情 / #任务名剧情图片 / #剧情搜索 关键词`, session)
    if (blocks.length) session = await this.replyForwardBatchesWithSession(blocks, session, 10)
    this.saveSession({ ...session, plots: orderedPlots })
    return true
  }

  async plotRead() {
    const msg = this.e.msg.trim()
    const m = msg.match(/^#(.+?)剧情(?:文本|图片)?$/)
    if (!m) return false
    const raw = this.trimOutputSuffix((m[1] || '').trim())
    const { wantImage } = this.outputMode(msg)
    if (!raw) return false

    const idx = await loadPlotIndex()
    const items = idx.items || []
    if (!items.length) return this.reply('暂无剧情文本数据，请先发送 #剧情更新')

    const key = normalizeRoleName(raw)
    const meta = items.find(r => normalizeRoleName(r.name) === key || (r.alias || []).includes(key))
      || items.find(r => normalizeRoleName(r.name).includes(key) || key.includes(normalizeRoleName(r.name)))
    if (!meta) return false

    const file = resolvePlotFile(meta)
    if (!file || !fss.existsSync(file)) return this.reply(`未找到剧情文本：${meta.name}`)
    const item = JSON.parse(await fs.readFile(file, 'utf8'))
    const text = renderPlotText(item, 'full')
    return this.replyContent(`${item.name}剧情`, text, wantImage)
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
    let session = this.saveSession({
      type: 'relic',
      relics: sets
    })

    const lines = sets.map((s, i) => `${i + 1}. ${s.name}`)
    session = await this.replyChunkedListWithSession([`📗 圣遗物列表（共 ${sets.length} 套）`, '命令：#套装名圣遗物 / #套装名圣遗物图片；也可引用本条发序号'], lines, 40, session)
    return Boolean(session)
  }

  async relicRead() {
    const msg = this.e.msg.trim()
    const m = msg.match(/^#(.+?)圣遗物(?:文本|图片)?$/)
    if (!m) return false
    const raw = this.trimOutputSuffix((m[1] || '').trim())
    const { wantImage } = this.outputMode(msg)
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
    return this.replyContent(`${set.name}圣遗物`, text, wantImage)
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

    let session = this.saveSession({
      type: 'weapon',
      weapons
    })

    const lines = weapons.map((w, i) => `${i + 1}. ${w.name}`)
    session = await this.replyChunkedListWithSession([`📘 武器列表（共 ${weapons.length}）`, '命令：#武器名武器故事 / #武器名武器故事图片'], lines, 40, session)
    return Boolean(session)
  }

  async weaponRead() {
    const msg = this.e.msg.trim()
    const m = msg.match(/^#(.+?)武器故事(?:文本|图片)?$/)
    if (!m) return false
    const raw = this.trimOutputSuffix((m[1] || '').trim())
    const { wantImage } = this.outputMode(msg)
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
    return this.replyContent(`${weapon.name}武器故事`, text, wantImage)
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
        const full = resolvePlotFile(it)
        if (!full || !fss.existsSync(full)) continue
        const data = JSON.parse(await fs.readFile(full, 'utf8'))
        const merged = [
          (data.sections || []).map(s => `${s.title || ''}\n${s.text || ''}`).join('\n'),
          data.searchText || ''
        ].join('\n')
        const titleHit = it.name.includes(keyword) || (data.category || '').includes(keyword)
        const textHit = merged.includes(keyword)
        if (titleHit || textHit) rows.push({ type: 'plot', id: it.id, file: it.file || '', name: it.name, snippet: textHit ? makeSnippet(merged, keyword) : '' })
      }
    }

    return rows
  }

  async replySearch(keyword, types) {
    await this.reply(`🔎 正在搜索：${keyword}`)
    const rows = await this.runTextSearch(keyword, types)
    if (!rows.length) return this.reply(`未找到关键词“${keyword}”`)

    let session = this.saveSession({
      type: 'search',
      results: rows
    })

    const mapLabel = { book: '书籍', role: '角色', relic: '圣遗物', weapon: '武器', voice: '语音', plot: '剧情' }
    const lines = rows.map((r, i) => `${i + 1}. [${mapLabel[r.type]}] ${r.name}${r.snippet ? `\n  ↳ ${r.snippet}` : ''}`)

    session = await this.replyChunkedListWithSession([`🔎 关键词：${keyword}`, `共找到 ${rows.length} 条`, '可引用本搜索结果发序号查看详情（可加“图片”或“语音”）'], lines, 10, session)
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

      let session = this.saveSession({
        type: 'search',
        results: hit.map(b => ({ type: 'book', name: b.title, snippet: b.snippet || '' }))
      })

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
        '可直接发送 #书名 阅读；也可引用本搜索结果发送序号（可加“图片”）'
      ]

      // QQ 单条过长可能不下发，按块发送
      session = await this.replyChunkedListWithSession(header, lines, 10, session)
      return true
    } catch (err) {
      logger.error('[bookdex.searchBooks] ', err)
      return this.reply(`搜索失败：${err?.message || err}`)
    }
  }

  userKey() {
    return `${this.e.self_id || 'bot'}:${this.e.group_id || this.e.user_id || 'u'}`
  }

  getUserSessions() {
    loadHelpSessionCache()
    const sessions = (helpSessionCache.get(this.userKey()) || []).filter(isValidTrackedSession)
    if (sessions.length !== (helpSessionCache.get(this.userKey()) || []).length) {
      helpSessionCache.set(this.userKey(), sessions)
      persistHelpSessionCache()
    }
    return sessions
  }

  saveSession(session) {
    loadHelpSessionCache()
    if (!isValidTrackedSession(session)) return null
    const normalized = {
      ...session,
      sid: session.sid || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now(),
      messageIds: [...new Set((session.messageIds || []).map(id => String(id)).filter(Boolean))]
    }

    const maxAge = 7 * 24 * 60 * 60 * 1000
    const now = Date.now()
    const sessions = this.getUserSessions().filter(item => item && now - Number(item.at || 0) < maxAge)
    const idx = sessions.findIndex(item => item.sid === normalized.sid)
    if (idx >= 0) sessions[idx] = normalized
    else sessions.push(normalized)

    sessions.sort((a, b) => Number(a.at || 0) - Number(b.at || 0))
    const trimmed = sessions.slice(-60)
    helpSessionCache.set(this.userKey(), trimmed)
    persistHelpSessionCache()
    return normalized
  }

  appendSessionMessageIds(session, replyRes) {
    if (!isValidTrackedSession(session) || !replyRes) return session
    if (isReplyError(replyRes)) return session

    const ids = []
    if (Array.isArray(replyRes.message_id)) ids.push(...replyRes.message_id)
    else if (replyRes.message_id) ids.push(replyRes.message_id)
    if (!ids.length) return session

    return this.saveSession({
      ...session,
      messageIds: [...(session.messageIds || []), ...ids]
    })
  }

  async replyWithSession(msg, session, quote = false, data = {}) {
    const res = await this.reply(msg, quote, data)
    if (!isValidTrackedSession(session)) return res
    return this.appendSessionMessageIds(session, res)
  }

  async replyAdaptiveForwardBatch(messages, session = null) {
    const list = (messages || []).filter(Boolean)
    if (!list.length) return session

    try {
      return await this.replyWithSession(await Bot.makeForwardArray(list), session)
    } catch (err) {
      if (list.length === 1) {
        const only = list[0]
        if (typeof only === 'string') {
          const smaller = splitTextPages(only, Math.max(300, Math.floor(TEXT_PAGE_CHARS / 2)))
          if (smaller.length > 1 && smaller.length < list.length + 2) return this.replyAdaptiveForwardBatch(smaller, session)
        }
        throw err
      }
      const mid = Math.ceil(list.length / 2)
      session = await this.replyAdaptiveForwardBatch(list.slice(0, mid), session)
      return this.replyAdaptiveForwardBatch(list.slice(mid), session)
    }
  }

  async replyForwardBatchesWithSession(messages, session = null, batchSize = 8) {
    const list = (messages || []).filter(Boolean)
    if (!list.length) return session
    const tracked = isValidTrackedSession(session)

    for (let i = 0; i < list.length; i += batchSize) {
      const batch = list.slice(i, i + batchSize)
      session = await this.replyAdaptiveForwardBatch(batch, session)
    }
    return tracked ? session : true
  }

  async replyChunkedListWithSession(headerLines, lines, size = 30, session = null) {
    const header = (headerLines || []).filter(Boolean).join('\n')
    const chunks = chunkLines(lines || [], size).map(part => part.join('\n'))

    if (header) session = await this.replyWithSession(header, session)
    if (!chunks.length) return session
    return this.replyForwardBatchesWithSession(chunks, session)
  }

  async sendTxtFallback(text, fallbackTitle = '', session = null) {
    const tracked = isValidTrackedSession(session)
    const { title, body } = splitLeadingTitle(text, fallbackTitle)
    const content = [title, body].filter(Boolean).join('\n\n') || String(text || '')
    const base = slugify(title || fallbackTitle || 'bookdex')
    const file = path.join(tmpRoot, `${base || 'bookdex'}-${Date.now()}.txt`)
    await fs.writeFile(file, content, 'utf8')

    const notice = '合并消息发送失败，已改为 txt 文件发送'
    if (tracked) session = await this.replyWithSession(notice, session)
    else await this.reply(notice)

    if (tracked) session = await this.replyWithSession(segment.file(`file://${file}`, path.basename(file)), session)
    else await this.reply(segment.file(`file://${file}`, path.basename(file)))
    return tracked ? (session || true) : true
  }

  async replyStructuredText(text, fallbackTitle = '', session = null) {
    const tracked = isValidTrackedSession(session)
    const { title, body } = splitLeadingTitle(text, fallbackTitle)
    if (title) session = await this.replyWithSession(title, session)
    else if (!tracked) await this.reply(fallbackTitle || '')
    if (!body) return tracked ? (session || true) : true
    const chunks = splitTextPages(body, TEXT_PAGE_CHARS)
    if (!title && chunks.length <= 1) {
      if (!tracked) {
        await this.reply(body)
        return true
      }
      return this.replyWithSession(body, session)
    }
    try {
      return await this.replyForwardBatchesWithSession(chunks, tracked ? session : null, TEXT_FORWARD_BATCH_SIZE)
    } catch {
      return this.sendTxtFallback(text, fallbackTitle, tracked ? session : null)
    }
  }

  async replyContent(title, text, wantImage = false, session = null) {
    const tracked = isValidTrackedSession(session)
    if (wantImage) {
      const imgs = await renderTextAsImages(title, text)
      if (imgs.length <= 1) {
        for (const img of imgs) {
          if (tracked) session = await this.replyWithSession(segment.image(`file://${img}`), session)
          else await this.reply(segment.image(`file://${img}`))
        }
        return tracked ? (session || true) : true
      }

      const imageMsgs = imgs.map(img => segment.image(`file://${img}`))
      if (title) {
        if (tracked) session = await this.replyWithSession(title, session)
        else await this.reply(title)
      }
      if (tracked) {
        session = await this.replyForwardBatchesWithSession(imageMsgs, session, 4)
        return session || true
      }
      await this.replyForwardBatchesWithSession(imageMsgs, null, 4)
      return true
    }
    return this.replyStructuredText(text, title, tracked ? session : null)
  }

  outputMode(raw = '') {
    const text = String(raw || '').trim()
    return {
      wantImage: /图片$/.test(text),
      wantVoice: /语音$/.test(text),
      wantText: !/图片$/.test(text)
    }
  }

  trimOutputSuffix(raw = '') {
    return String(raw || '').replace(/(文本|图片|语音)$/, '').trim()
  }

  async getQuotedMessageId() {
    if (this.e.reply_id) return String(this.e.reply_id)
    if (this.e.quote?.id) return String(this.e.quote.id)

    if (this.e.getReply) {
      try {
        const reply = await this.e.getReply()
        if (reply?.message_id) return String(reply.message_id)
      } catch {}
    }

    return ''
  }

  hasReplyContext() {
    if (this.e.reply_id || this.e.quote?.id) return true
    return Array.isArray(this.e.message) && this.e.message.some(i => i?.type === 'reply')
  }

  async getMatchedSessionForIndex() {
    const sessions = this.getUserSessions()
    if (!sessions.length) return null

    const quotedId = await this.getQuotedMessageId()
    if (!quotedId && this.hasReplyContext()) return null
    if (!quotedId) return sessions[sessions.length - 1] || null

    for (let i = sessions.length - 1; i >= 0; i--) {
      const session = sessions[i]
      const ids = (session.messageIds || []).map(String)
      if (ids.includes(quotedId)) return session
    }
    return null
  }

  async pickByIndex() {
    const raw = this.e.msg.trim()
    const idx = Number(raw.replace(/(文本|图片|语音)$/, ''))
    if (!idx || idx < 1) return false

    const { wantImage, wantVoice } = this.outputMode(raw)
    const session = await this.getMatchedSessionForIndex()

    // 仅在“存在最近帮助/搜索会话”或“引用了 bookdex 自己发出的帮助/搜索消息”时响应纯数字
    if (!session) {
      if (this.hasReplyContext()) {
        return this.reply('引用会话已失效，请重新发送对应帮助或搜索结果后再选序号')
      }
      return false
    }

    // 1) 优先按最近帮助类型分发
    if (session?.type === 'role' && Array.isArray(session.roles)) {
      const meta = session.roles[idx - 1]
      if (!meta) return this.reply('序号超出范围，请先发送 #角色故事帮助')
      const file = path.join(storyRoot, `${slugify(meta.name)}.json`)
      if (!fss.existsSync(file)) return this.reply(`未找到角色故事：${meta.name}`)
      const role = JSON.parse(await fs.readFile(file, 'utf8'))
      const text = renderRoleStoryText(role, 'story')
      return this.replyContent(`${role.name}故事`, text, wantImage)
    }

    if (session?.type === 'relic' && Array.isArray(session.relics)) {
      const meta = session.relics[idx - 1]
      if (!meta) return this.reply('序号超出范围，请先发送 #圣遗物帮助')
      const file = path.join(relicRoot, `${slugify(meta.name)}.json`)
      if (!fss.existsSync(file)) return this.reply(`未找到圣遗物：${meta.name}`)
      const set = JSON.parse(await fs.readFile(file, 'utf8'))
      const text = renderRelicText(set)
      return this.replyContent(`${set.name}圣遗物`, text, wantImage)
    }

    if (session?.type === 'voice-role' && Array.isArray(session.roles)) {
      const meta = session.roles[idx - 1]
      if (!meta) return this.reply('序号超出范围，请先发送 #语音帮助')
      const file = path.join(voiceRoot, `${slugify(meta.name)}.json`)
      if (!fss.existsSync(file)) return this.reply(`未找到角色语音：${meta.name}`)
      const voice = JSON.parse(await fs.readFile(file, 'utf8'))
      const tab = pickDefaultVoiceTab(voice)
      const entries = (tab.items || []).map(item => ({ role: voice.name, lang: tab.lang, ...item }))
      const nextSession = this.saveSession({ type: 'voice-entry', role: voice.name, lang: tab.lang, entries })
      const text = renderVoiceListText(voice, false)
      return this.replyContent(`${voice.name}语音列表`, text, wantImage, nextSession)
    }

    if (session?.type === 'plot' && Array.isArray(session.plots)) {
      const meta = session.plots[idx - 1]
      if (!meta) return this.reply('序号超出范围，请先发送 #剧情帮助')
      const file = resolvePlotFile(meta)
      if (!file || !fss.existsSync(file)) return this.reply(`未找到剧情文本：${meta.name}`)
      const item = JSON.parse(await fs.readFile(file, 'utf8'))
      const text = renderPlotText(item, 'full')
      return this.replyContent(`${item.name}剧情`, text, wantImage)
    }

    if (session?.type === 'voice-entry' && Array.isArray(session.entries)) {
      const entry = session.entries[idx - 1]
      if (!entry) return this.reply('序号超出范围，请先重新打开语音列表')
      if (wantVoice) return sendVoiceRecord(this.e, entry.audioUrl)
      const text = renderVoiceEntryText(entry)
      return this.replyContent(`${entry.role}语音`, text, wantImage)
    }

    if (session?.type === 'weapon' && Array.isArray(session.weapons)) {
      const meta = session.weapons[idx - 1]
      if (!meta) return this.reply('序号超出范围，请先发送 #武器帮助')
      const file = path.join(weaponRoot, `${slugify(meta.name)}.json`)
      if (!fss.existsSync(file)) return this.reply(`未找到武器：${meta.name}`)
      const weapon = JSON.parse(await fs.readFile(file, 'utf8'))
      const text = renderWeaponText(weapon)
      return this.replyContent(`${weapon.name}武器故事`, text, wantImage)
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
        return this.replyContent(b.title, content, wantImage)
      }
      if (row.type === 'role') {
        const f = path.join(storyRoot, `${slugify(row.name)}.json`)
        if (!fss.existsSync(f)) return this.reply(`未找到角色故事：${row.name}`)
        const role = JSON.parse(await fs.readFile(f, 'utf8'))
        const text = renderRoleStoryText(role, 'story')
        return this.replyContent(`${role.name}故事`, text, wantImage)
      }
      if (row.type === 'relic') {
        const f = path.join(relicRoot, `${slugify(row.name)}.json`)
        if (!fss.existsSync(f)) return this.reply(`未找到圣遗物：${row.name}`)
        const set = JSON.parse(await fs.readFile(f, 'utf8'))
        const text = renderRelicText(set)
        return this.replyContent(`${set.name}圣遗物`, text, wantImage)
      }
      if (row.type === 'weapon') {
        const f = path.join(weaponRoot, `${slugify(row.name)}.json`)
        if (!fss.existsSync(f)) return this.reply(`未找到武器：${row.name}`)
        const w = JSON.parse(await fs.readFile(f, 'utf8'))
        const text = renderWeaponText(w)
        return this.replyContent(`${w.name}武器故事`, text, wantImage)
      }
      if (row.type === 'voice') {
        const entry = { role: row.role, lang: row.lang, name: row.voiceName, text: row.text, audioUrl: row.audioUrl }
        if (wantVoice) return sendVoiceRecord(this.e, entry.audioUrl)
        const text = renderVoiceEntryText(entry)
        return this.replyContent(`${entry.role}语音`, text, wantImage)
      }
      if (row.type === 'plot') {
        const f = resolvePlotFile(row)
        if (!f || !fss.existsSync(f)) return this.reply(`未找到剧情文本：${row.name}`)
        const item = JSON.parse(await fs.readFile(f, 'utf8'))
        const text = renderPlotText(item, 'full')
        return this.replyContent(`${item.name}剧情`, text, wantImage)
      }
    }

    // 2) 默认按书籍序号（仅限已有书籍帮助/搜索会话）
    if (!session.books?.length) return false

    const book = session.books[idx - 1]
    if (!book) return this.reply('序号超出范围，请先发送 #书籍帮助')

    const full = path.join(booksRoot, book.file)
    if (!fss.existsSync(full)) return this.reply(`书籍文件不存在：${book.title}`)
    const content = await fs.readFile(full, 'utf8')
    return this.replyContent(book.title, content, wantImage)
  }

  async pickByTitle() {
    const raw = this.e.msg.replace(/^#/, '').trim()
    if (!raw || raw.length < 2) return false
    if (/^书籍(帮助\d*|导入)$/.test(raw)) return false

    const { wantImage } = this.outputMode(raw)
    const title = this.trimOutputSuffix(raw)

    const index = await loadIndex()
    const books = index.books || []
    const exact = books.find(b => b.title === title)
    const fuzzy = exact || books.find(b => b.title.includes(title) || title.includes(b.title))

    if (!fuzzy) return false

    const full = path.join(booksRoot, fuzzy.file)
    if (!fss.existsSync(full)) return this.reply(`书籍文件不存在：${fuzzy.title}`)
    const content = await fs.readFile(full, 'utf8')
    return this.replyContent(fuzzy.title, content, wantImage)
  }
}

export default BookDex
