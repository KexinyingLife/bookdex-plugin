import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
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
  slugify,
  ensureDirs,
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
  loadPipelineState,
  savePipelineModuleVersion
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

async function emitProgress(fn, payload) {
  if (typeof fn === 'function') await fn(payload)
}

async function fetchEntryPageById(id) {
  const u = new URL('https://act-api-takumi-static.mihoyo.com/hoyowiki/genshin/wapi/entry_page')
  u.searchParams.set('app_sn', 'ys_obc')
  u.searchParams.set('entry_page_id', String(id))
  const r = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } })
  const j = await r.json()
  return j?.data?.page || null
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]))
  }
  return value
}

function selectorSignature(item = {}) {
  const normalized = stableValue({
    id: String(item.id || ''),
    title: item.title || '',
    name: item.name || '',
    ext: item.ext || '',
    icon: item.icon || '',
    cover: item.cover || '',
    jump_type: item.jump_type || '',
    content_id: item.content_id || '',
    content_type: item.content_type || '',
    area_id: item.area_id || '',
    cate_id: item.cate_id || '',
    tag_id: item.tag_id || ''
  })
  return createHash('sha1').update(JSON.stringify(normalized)).digest('hex')
}

function hasUsableMeta(meta = {}, filePath = '') {
  return Boolean(meta && meta.id && filePath && fss.existsSync(filePath))
}

const ROLE_STORY_SCHEMA_VERSION = 2
const BOOK_TEXT_SCHEMA_VERSION = 3
const PLOT_TEXT_SCHEMA_VERSION = 3
const MAP_TEXT_SCHEMA_VERSION = 3

/**
 * 剧情 / 地图文本 / 角色逸闻共用 interactive_dialogue 解析逻辑。
 * 提高此版本后，对应分类在统一更新中会整表重拉（不依赖观测枢签名），直到各分类更新跑完并写入 pipeline.json。
 * 仅影响这三类；其它分类仍按原增量规则。
 */
const INTERACTIVE_DIALOGUE_PIPELINE_VERSION = 2

const INTERACTIVE_PARSE_PIPELINE_KEYS = {
  plot: 'plotInteractiveParse',
  map: 'mapInteractiveParse',
  anecdote: 'anecdoteInteractiveParse'
}

function interactiveDialogueParseOk(state, moduleKey) {
  const fileKey = INTERACTIVE_PARSE_PIPELINE_KEYS[moduleKey]
  if (!fileKey) return true
  return Number(state?.[fileKey] || 0) >= INTERACTIVE_DIALOGUE_PIPELINE_VERSION
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
  return Number.isFinite(total) ? total : NaN
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
        '#角色名语音 / #任务名剧情 / #地图名地图文本',
        '#角色名角色逸闻 / #圣牌名月谕圣牌',
        '#套装名圣遗物 / #武器名武器故事'
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
        '#书籍搜索 / #角色故事搜索 / #语音搜索 / #剧情搜索 / #地图文本搜索',
        '#角色逸闻搜索 / #月谕圣牌搜索',
        '#圣遗物搜索 / #武器搜索 关键词',
        '引用帮助或搜索结果发：序号 / 序号图片 / 序号语音'
      ]
    },
    {
      title: '更新命令',
      lines: [
        '#统一更新 / #重置更新',
        '#书籍更新 / #角色故事更新 / #语音更新 / #剧情更新 / #地图文本更新',
        '#角色逸闻更新 / #月谕圣牌更新',
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
    <div class='sub'>覆盖书籍、角色故事、语音、剧情、地图文本、圣遗物、武器故事。默认文本，带“图片”返回图片。</div>
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
  body{margin:0;width:960px;background:#0b1020;color:#f8fafc;}
  .wrap{padding:18px;}
  .card{border:1px solid rgba(148,163,184,.30);border-radius:12px;padding:14px;background:#111827;}
  .title{font-size:30px;font-weight:700;color:#fcd34d;margin-bottom:8px;line-height:1.2;}
  .content{white-space:pre-wrap;font-size:20px;line-height:1.35;color:#e5e7eb;word-break:break-word;margin:0;}
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
    const pages = splitTextPages(text, 800)
    for (const [idx, body] of pages.entries()) {
      const page = await browser.newPage()
      try {
        const pageTitle = pages.length > 1 ? `${title}（${idx + 1}/${pages.length}）` : title
        const html = textPageHtml({ title: pageTitle, body, fontData })
        await page.setViewport({ width: 960, height: 1200, deviceScaleFactor: 1.2 })
        await page.setContent(html, { waitUntil: 'domcontentloaded', timeout: 0 })
        const file = path.join(tmpRoot, `book-${Date.now()}-${idx + 1}.jpg`)
        await page.screenshot({ path: file, type: 'jpeg', quality: 68, fullPage: true })
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

function buildMapFileName(name = '', id = '') {
  const safeName = slugify(name || `map-${id || Date.now()}`) || `map-${id || Date.now()}`
  const safeId = String(id || '').replace(/[^\w-]/g, '')
  return safeId ? `${safeName}__${safeId}.json` : `${safeName}.json`
}

function resolveMapFile(meta = {}) {
  const candidates = []
  if (meta.file) candidates.push(path.join(mapRoot, meta.file))
  if (meta.name && meta.id) candidates.push(path.join(mapRoot, buildMapFileName(meta.name, meta.id)))
  if (meta.name) candidates.push(path.join(mapRoot, `${slugify(meta.name)}.json`))

  for (const full of candidates) {
    if (full && fss.existsSync(full)) return full
  }
  return candidates[0] || ''
}

function buildAnecdoteFileName(name = '', id = '') {
  const safeName = slugify(name || `anecdote-${id || Date.now()}`) || `anecdote-${id || Date.now()}`
  const safeId = String(id || '').replace(/[^\w-]/g, '')
  return safeId ? `${safeName}__${safeId}.json` : `${safeName}.json`
}

function resolveAnecdoteFile(meta = {}) {
  const candidates = []
  if (meta.file) candidates.push(path.join(anecdoteRoot, meta.file))
  if (meta.name && meta.id) candidates.push(path.join(anecdoteRoot, buildAnecdoteFileName(meta.name, meta.id)))
  if (meta.name) candidates.push(path.join(anecdoteRoot, `${slugify(meta.name)}.json`))

  for (const full of candidates) {
    if (full && fss.existsSync(full)) return full
  }
  return candidates[0] || ''
}

function buildCardFileName(name = '', id = '') {
  const safeName = slugify(name || `card-${id || Date.now()}`) || `card-${id || Date.now()}`
  const safeId = String(id || '').replace(/[^\w-]/g, '')
  return safeId ? `${safeName}__${safeId}.json` : `${safeName}.json`
}

function resolveCardFile(meta = {}) {
  const candidates = []
  if (meta.file) candidates.push(path.join(cardRoot, meta.file))
  if (meta.name && meta.id) candidates.push(path.join(cardRoot, buildCardFileName(meta.name, meta.id)))
  if (meta.name) candidates.push(path.join(cardRoot, `${slugify(meta.name)}.json`))

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

function normalizeBookVolumeToken(raw = '') {
  return parseBookVolumeLabel(raw)
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

async function fetchRoleStoryAll({ onProgress, onError, dryRun = false } = {}) {
  await ensureDirs()
  const roleMap = new Map()
  const oldIndex = await loadStoryIndex()
  const oldMetaMap = new Map((oldIndex.roles || []).map(item => [String(item.id || ''), item]))

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

  const currentIds = new Set([...roleMap.values()].map(it => String(it.id || '')))
  const removed = (oldIndex.roles || []).filter(item => !currentIds.has(String(item.id || '')))
  const changedItems = []
  const roles = []
  for (const it of roleMap.values()) {
    const roleName = (it.title || it.name || '').trim()
    const id = String(it.id)
    const sig = selectorSignature(it)
    const prev = oldMetaMap.get(id)
    const filePath = path.join(storyRoot, `${slugify(roleName)}.json`)
    const canReuse = hasUsableMeta(prev, filePath) &&
      prev.schemaVersion === ROLE_STORY_SCHEMA_VERSION &&
      (prev.selectorSig === sig || !prev.selectorSig)
    if (canReuse) roles.push({ ...prev, name: roleName, alias: [normalizeRoleName(roleName)], selectorSig: sig, schemaVersion: ROLE_STORY_SCHEMA_VERSION })
    else changedItems.push({ it, roleName, id, sig, filePath })
  }
  if (dryRun) return { total: roleMap.size, updated: changedItems.length + removed.length }

  const total = changedItems.length
  let done = 0
  for (const itemInfo of changedItems) {
    const { roleName, id, sig, filePath } = itemInfo
    try {
      const page = await fetchEntryPageById(id)
      if (page) {
        const ext = extractRoleStory(page)
        const detail = ext.detail || ''
        const stories = ext.stories || []
        const others = ext.others || []

        if (detail || stories.length || others.length) {
          const item = {
            id,
            name: roleName,
            alias: [normalizeRoleName(roleName)],
            detail,
            stories,
            others
          }
          await fs.writeFile(filePath, JSON.stringify(item, null, 2), 'utf8')
          roles.push({ id, name: roleName, alias: item.alias, storyCount: stories.length, otherCount: others.length, selectorSig: sig, schemaVersion: ROLE_STORY_SCHEMA_VERSION })
        }
      }
    } catch (error) {
      await emitProgress(onError, { type: 'role', done: done + 1, total, name: roleName, error })
    }
    done += 1
    if (total && (done % 100 === 0 || done === total)) await emitProgress(onProgress, { type: 'role', done, total })
  }

  roles.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  await fs.writeFile(storyIndexFile, JSON.stringify({ roles, updatedAt: Date.now() }, null, 2), 'utf8')
  return { total: roles.length, updated: changedItems.length + removed.length }
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

function parseModuleDialogueLike(module = {}) {
  const texts = []
  for (const comp of (module.components || [])) {
    const txt = parseGenericPlotComponent(comp)
    if (txt) texts.push(txt)
  }
  return cleanPlotText(texts.join('\n\n'))
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

function parseInteractiveDialogue(component = {}) {
  if ((component.component_id || '') !== 'interactive_dialogue') return ''
  let data = {}
  try { data = JSON.parse(component.data || '{}') } catch { return '' }

  const blocks = []
  const groups = Array.isArray(data.list) && data.list.length ? data.list : [data]

  for (const group of groups) {
    const contents = group?.contents || data.contents || {}
    const childIds = group?.child_ids || data.child_ids || {}
    const fullyEmitted = new Set()
    const recStack = new Set()

    /**
     * 观测枢对话图是 DAG：不同选项会在下游汇合。旧实现用「全局 visited」做 DFS，
     * 第二条分支在汇合点被截断，未遍历到的节点只能靠 Object.keys 补在全文末尾，
     * 表现为「只剩一个选项在对话旁边，其余选项整段堆在底部」。
     * 这里用 fullyEmitted 表示「该节点及其下游已完整输出过」，汇合时跳过重复；
     * 同时在「同一父节点的多个子节点」处分支时，先把所有【选项】连续列出，再依次展开各分支，
     * 阅读顺序才与游戏内选项面板一致。
     */
    const emitFrom = (id, skipOption = false) => {
      if (!id) return []
      if (fullyEmitted.has(id)) return []
      if (recStack.has(id)) return []

      recStack.add(id)
      const node = contents[id]
      if (!node) {
        recStack.delete(id)
        fullyEmitted.add(id)
        return []
      }

      const childList = childIds?.[id] || []
      const option = cleanPlotText(htmlToText(node.option || ''))
      const dialogue = cleanPlotText(htmlToText(node.dialogue || ''))
      const lines = []

      if (childList.length > 1) {
        if (!skipOption && option) lines.push(`【选项】${option}`)
        if (dialogue) lines.push(dialogue)
        for (const cid of childList) {
          const cn = contents[cid]
          if (!cn) continue
          const opt = cleanPlotText(htmlToText(cn.option || ''))
          if (opt) lines.push(`【选项】${opt}`)
        }
        for (const cid of childList) {
          lines.push(...emitFrom(cid, true))
        }
        recStack.delete(id)
        fullyEmitted.add(id)
        return lines
      }

      if (!skipOption && option) lines.push(`【选项】${option}`)
      if (dialogue) lines.push(dialogue)
      if (childList.length === 1) lines.push(...emitFrom(childList[0], false))

      recStack.delete(id)
      fullyEmitted.add(id)
      return lines
    }

    const lines = []
    lines.push(...emitFrom(group?.root_id || data.root_id || '', false))
    for (const id of Object.keys(contents || {})) {
      if (!fullyEmitted.has(id)) lines.push(...emitFrom(id, false))
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

async function fetchRelicAll({ onProgress, onError, dryRun = false } = {}) {
  await ensureDirs()
  const setMap = new Map()
  const oldIndex = await loadRelicIndex()
  const oldMetaMap = new Map((oldIndex.sets || []).map(item => [String(item.id || ''), item]))
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

  const removed = (oldIndex.sets || []).filter(item => !setMap.has(item.name))
  const changedItems = []
  const sets = []
  for (const it of setMap.values()) {
    const setName = (it.title || it.name || '').trim()
    const id = String(it.id)
    const sig = selectorSignature(it)
    const prev = oldMetaMap.get(id)
    const filePath = path.join(relicRoot, `${slugify(setName)}.json`)
    const canReuse = hasUsableMeta(prev, filePath) && (prev.selectorSig === sig || !prev.selectorSig)
    if (canReuse) sets.push({ ...prev, name: setName, alias: [normalizeRoleName(setName)], selectorSig: sig })
    else changedItems.push({ setName, id, sig, filePath })
  }
  if (dryRun) return { total: setMap.size, updated: changedItems.length + removed.length }

  const total = changedItems.length
  let done = 0
  for (const itemInfo of changedItems) {
    const { setName, id, sig, filePath } = itemInfo
    try {
      const u = new URL('https://act-api-takumi-static.mihoyo.com/hoyowiki/genshin/wapi/entry_page')
      u.searchParams.set('app_sn', 'ys_obc')
      u.searchParams.set('entry_page_id', id)
      const j = await (await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } })).json()
      const page = j?.data?.page
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
          sets.push({ id, name: setName, alias: item.alias, pieceCount: pieces.length, selectorSig: sig })
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
  return { total: sets.length, updated: changedItems.length + removed.length }
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

async function fetchWeaponAll({ onProgress, onError, dryRun = false } = {}) {
  await ensureDirs()
  const map = new Map()
  const oldIndex = await loadWeaponIndex()
  const oldMetaMap = new Map((oldIndex.weapons || []).map(item => [String(item.id || ''), item]))
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

  const removed = (oldIndex.weapons || []).filter(item => !map.has(item.name))
  const changedItems = []
  const weapons = []
  for (const it of map.values()) {
    const name = (it.title || it.name || '').trim()
    const id = String(it.id)
    const sig = selectorSignature(it)
    const prev = oldMetaMap.get(id)
    const filePath = path.join(weaponRoot, `${slugify(name)}.json`)
    const canReuse = hasUsableMeta(prev, filePath) && (prev.selectorSig === sig || !prev.selectorSig)
    if (canReuse) weapons.push({ ...prev, name, alias: [normalizeRoleName(name)], selectorSig: sig })
    else changedItems.push({ name, id, sig, filePath })
  }
  if (dryRun) return { total: map.size, updated: changedItems.length + removed.length }

  const total = changedItems.length
  let done = 0
  for (const itemInfo of changedItems) {
    const { name, id, sig, filePath } = itemInfo
    try {
      const u = new URL('https://act-api-takumi-static.mihoyo.com/hoyowiki/genshin/wapi/entry_page')
      u.searchParams.set('app_sn', 'ys_obc')
      u.searchParams.set('entry_page_id', id)
      const j = await (await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } })).json()
      const page = j?.data?.page
      if (page) {
        const story = parseWeaponStory(page)
        if (story) {
          const item = { id, name, alias: [normalizeRoleName(name)], story }
          await fs.writeFile(filePath, JSON.stringify(item, null, 2), 'utf8')
          weapons.push({ id, name, alias: item.alias, selectorSig: sig })
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
  return { total: weapons.length, updated: changedItems.length + removed.length }
}



async function fetchPlotAll({ onProgress, onError, dryRun = false } = {}) {
  await ensureDirs()
  const pipelineState = await loadPipelineState()
  const map = new Map()
  const oldIndex = await loadPlotIndex()
  const oldMetaMap = new Map((oldIndex.items || []).map(item => [String(item.id || ''), item]))
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
    const canReuse = hasUsableMeta(prev, prevFile) &&
      Number(prev.plotSchemaVersion || 0) === PLOT_TEXT_SCHEMA_VERSION &&
      (prev.selectorSig === sig || !prev.selectorSig) &&
      interactiveDialogueParseOk(pipelineState, 'plot')
    if (canReuse) {
      if (prev.file && prev.file !== fileName && prevFile && fss.existsSync(prevFile)) {
        await fs.rename(prevFile, file)
      }
      items.push({ ...prev, name, file: fileName, alias: [normalizeRoleName(name)], selectorSig: sig, plotSchemaVersion: PLOT_TEXT_SCHEMA_VERSION })
    } else {
      changedItems.push({ it, name, id, fileName, file, sig })
    }
  }
  if (dryRun) {
    // 勿在预览阶段逐条请求 entry_page：全量待更新时会产生数百次网络请求，导致 #统一更新 长时间无响应。
    return { total: map.size, updated: changedItems.length + removed.length }
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
        const searchText = parsePlotSearchText(page)
        const category = parsePlotCategory(it.ext)
        const subtitle = extractPlotSubtitle(page)
        const item = { id, name, file: fileName, alias: [normalizeRoleName(name)], category, subtitle, sections, searchText }

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
  await fs.writeFile(plotIndexFile, JSON.stringify({ items, updatedAt: Date.now() }, null, 2), 'utf8')
  await fs.writeFile(path.join(plotRoot, '_misses.json'), JSON.stringify({ total: misses.length, misses, updatedAt: Date.now() }, null, 2), 'utf8')
  if (!dryRun) {
    await savePipelineModuleVersion(
      INTERACTIVE_PARSE_PIPELINE_KEYS.plot,
      INTERACTIVE_DIALOGUE_PIPELINE_VERSION
    )
  }
  return { total: items.length, misses: misses.length, updated: saved + removed.length }
}

async function fetchMapAll({ onProgress, onError, dryRun = false } = {}) {
  await ensureDirs()
  const pipelineState = await loadPipelineState()
  const map = new Map()
  const oldIndex = await loadMapIndex()
  const oldMetaMap = new Map((oldIndex.items || []).map(item => [String(item.id || ''), item]))

  for (let page = 1; page <= 50; page++) {
    const u = new URL('https://act-api-takumi.mihoyo.com/common/blackboard/ys_obc/v1/content/selector')
    u.searchParams.set('app_sn', 'ys_obc')
    u.searchParams.set('channel_id', '251')
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
    const canReuse = hasUsableMeta(prev, prevFile) &&
      Number(prev.mapSchemaVersion || 0) === MAP_TEXT_SCHEMA_VERSION &&
      (prev.selectorSig === sig || !prev.selectorSig) &&
      interactiveDialogueParseOk(pipelineState, 'map')
    if (canReuse) {
      if (prev.file && prev.file !== fileName && prevFile && fss.existsSync(prevFile)) {
        await fs.rename(prevFile, file)
      }
      items.push({ ...prev, name, file: fileName, alias: [normalizeRoleName(name)], selectorSig: sig, mapSchemaVersion: MAP_TEXT_SCHEMA_VERSION })
    } else {
      changedItems.push({ name, id, fileName, file, sig })
    }
  }

  if (dryRun) return { total: map.size, updated: changedItems.length + removed.length }

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
      INTERACTIVE_DIALOGUE_PIPELINE_VERSION
    )
  }
  return { total: items.length, updated: saved + removed.length }
}

async function fetchAnecdoteAll({ onProgress, onError, dryRun = false } = {}) {
  await ensureDirs()
  const pipelineState = await loadPipelineState()
  const map = new Map()
  const oldIndex = await loadAnecdoteIndex()
  const oldMetaMap = new Map((oldIndex.items || []).map(item => [String(item.id || ''), item]))
  for (let page = 1; page <= 50; page++) {
    const u = new URL('https://act-api-takumi.mihoyo.com/common/blackboard/ys_obc/v1/content/selector')
    u.searchParams.set('app_sn', 'ys_obc')
    u.searchParams.set('channel_id', '261')
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
    const canReuse = hasUsableMeta(prev, prevFile) &&
      (prev.selectorSig === sig || !prev.selectorSig) &&
      interactiveDialogueParseOk(pipelineState, 'anecdote')
    if (canReuse) {
      if (prev.file && prev.file !== fileName && prevFile && fss.existsSync(prevFile)) await fs.rename(prevFile, file)
      items.push({ ...prev, name, file: fileName, alias: [normalizeRoleName(name)], selectorSig: sig })
    } else {
      changedItems.push({ name, id, fileName, file, sig })
    }
  }

  if (dryRun) return { total: map.size, updated: changedItems.length + removed.length }

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
          items.push({ id, name, file: fileName, alias: data.alias, sectionCount: sections.length, selectorSig: sig })
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
      INTERACTIVE_DIALOGUE_PIPELINE_VERSION
    )
  }
  return { total: items.length, updated: saved + removed.length }
}

async function fetchCardAll({ onProgress, onError, dryRun = false } = {}) {
  await ensureDirs()
  const map = new Map()
  const oldIndex = await loadCardIndex()
  const oldMetaMap = new Map((oldIndex.items || []).map(item => [String(item.id || ''), item]))
  for (let page = 1; page <= 50; page++) {
    const u = new URL('https://act-api-takumi.mihoyo.com/common/blackboard/ys_obc/v1/content/selector')
    u.searchParams.set('app_sn', 'ys_obc')
    u.searchParams.set('channel_id', '249')
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

  const removed = (oldIndex.items || []).filter(item => !map.has(String(item.id || '')))
  const changedItems = []
  const items = []

  for (const it of map.values()) {
    const name = (it.title || it.name || '').trim() || `未命名圣牌-${it.id}`
    const id = String(it.id)
    const fileName = buildCardFileName(name, id)
    const file = path.join(cardRoot, fileName)
    const sig = selectorSignature(it)
    const prev = oldMetaMap.get(id)
    const prevFile = prev?.file ? path.join(cardRoot, prev.file) : ''
    const canReuse = hasUsableMeta(prev, prevFile) && (prev.selectorSig === sig || !prev.selectorSig)
    if (canReuse) {
      if (prev.file && prev.file !== fileName && prevFile && fss.existsSync(prevFile)) await fs.rename(prevFile, file)
      items.push({ ...prev, name, file: fileName, alias: [normalizeRoleName(name)], selectorSig: sig })
    } else {
      changedItems.push({ name, id, fileName, file, sig })
    }
  }

  if (dryRun) return { total: map.size, updated: changedItems.length + removed.length }

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
          items.push({ id, name, file: fileName, alias: data.alias, sectionCount: sections.length, selectorSig: sig })
          saved += 1
        }
      }
    } catch (error) {
      await emitProgress(onError, { type: 'card', done: done + 1, total, name, error })
    }
    done += 1
    if (total && (done % 100 === 0 || done === total)) await emitProgress(onProgress, { type: 'card', done, total })
  }

  items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || String(a.id).localeCompare(String(b.id)))
  await fs.writeFile(cardIndexFile, JSON.stringify({ items, updatedAt: Date.now() }, null, 2), 'utf8')
  return { total: items.length, updated: saved + removed.length }
}

async function fetchVoiceAll({ onProgress, onError, dryRun = false } = {}) {
  await ensureDirs()
  const roleMap = new Map()
  const oldIndex = await loadVoiceIndex()
  const oldMetaMap = new Map((oldIndex.roles || []).map(item => [String(item.id || ''), item]))
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

  const currentIds = new Set([...roleMap.values()].map(it => String(it.id || '')))
  const removed = (oldIndex.roles || []).filter(item => !currentIds.has(String(item.id || '')))
  const changedItems = []
  const roles = []
  for (const it of roleMap.values()) {
    const roleName = (it.title || it.name || '').trim()
    const id = String(it.id)
    const sig = selectorSignature(it)
    const prev = oldMetaMap.get(id)
    const filePath = path.join(voiceRoot, `${slugify(roleName)}.json`)
    const canReuse = hasUsableMeta(prev, filePath) && (prev.selectorSig === sig || !prev.selectorSig)
    if (canReuse) {
      roles.push({ ...prev, name: roleName, alias: [normalizeRoleName(roleName)], selectorSig: sig })
    } else {
      changedItems.push({ roleName, id, sig, filePath })
    }
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
    return { total: roles.length + effectiveChanged.length, updated: effectiveChanged.length + removed.length }
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
            selectorSig: sig
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
  await fs.writeFile(voiceIndexFile, JSON.stringify({ roles, updatedAt: Date.now() }, null, 2), 'utf8')
  return { total: roles.length, updated: saved + removed.length }
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

    // 兜底：部分词条正文模块标题不是卷名（如“书籍内容/绣球”），按顺序回填描述。
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

  // 特例兼容：部分词条正文仍是“第11/12卷”，但元数据已标成“最终卷（版本一/二）”。
  // 这里优先把末尾数字卷映射为最终卷版本，满足“10正篇+2最终卷”的显示口径。
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

async function fetchBooksFromWiki({ onProgress, onError, dryRun = false } = {}) {
  await ensureDirs()
  const map = new Map()
  const oldIndex = await loadIndex()
  const oldMetaMap = new Map((oldIndex.books || []).map(item => [String(item.source || '').replace(/^wiki:/, ''), item]))
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
      (prev.selectorSig === sig || !prev.selectorSig) &&
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
        bookSchemaVersion: BOOK_TEXT_SCHEMA_VERSION
      })
    } else {
      changedItems.push({ name, id, filePath, out, sig })
    }
  }
  if (dryRun) return { total: map.size, updated: changedItems.length + removed.length }

  const total = changedItems.length
  let done = 0
  for (const itemInfo of changedItems) {
    const { name, id, filePath, out, sig } = itemInfo
    try {
      const u = new URL('https://act-api-takumi-static.mihoyo.com/hoyowiki/genshin/wapi/entry_page')
      u.searchParams.set('app_sn', 'ys_obc')
      u.searchParams.set('entry_page_id', id)
      const j = await (await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } })).json()
      const page = j?.data?.page
      if (page) {
        const text = await buildBookTextFromEntryPage(page)
        if (text) {
          await fs.writeFile(filePath, text, 'utf8')
          index.books.push({
            title: name,
            file: out,
            source: `wiki:${id}`,
            selectorSig: sig,
            bookSchemaVersion: BOOK_TEXT_SCHEMA_VERSION
          })
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
  return { total: index.books.length, updated: changedItems.length + removed.length }
}

function getSelectorItemName(item = {}) {
  return (item.title || item.name || '').trim()
}

async function listSelectorItems(channelId, maxPages = 50) {
  const items = []
  for (let page = 1; page <= maxPages; page++) {
    const u = new URL('https://act-api-takumi.mihoyo.com/common/blackboard/ys_obc/v1/content/selector')
    u.searchParams.set('app_sn', 'ys_obc')
    u.searchParams.set('channel_id', String(channelId))
    u.searchParams.set('page', String(page))
    u.searchParams.set('page_size', '100')
    const j = await (await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0' } })).json()
    const list = j?.data?.list || []
    if (!list.length) break
    items.push(...list)
  }
  return items
}

function pickSelectorItemByName(items = [], rawName = '') {
  const query = String(rawName || '').trim()
  const key = normalizeRoleName(query)
  if (!query || !items.length) return null

  const withName = items
    .map(item => ({ item, name: getSelectorItemName(item) }))
    .filter(x => x.name)

  const exact = withName.find(x => normalizeRoleName(x.name) === key || x.name === query)
  if (exact) return exact.item

  const partial = withName
    .filter(x => normalizeRoleName(x.name).includes(key))
    .sort((a, b) => a.name.length - b.name.length || a.name.localeCompare(b.name, 'zh-Hans-CN'))

  return partial[0]?.item || null
}

function upsertById(list = [], next = {}) {
  const id = String(next.id || '')
  const idx = list.findIndex(x => String(x.id || '') === id)
  if (idx >= 0) list[idx] = next
  else list.push(next)
}

async function updateOneBookByName(rawName = '') {
  await ensureDirs()
  const items = await listSelectorItems(68, 20)
  const picked = pickSelectorItemByName(items, rawName)
  if (!picked) return { ok: false, reason: 'not_found' }

  const name = getSelectorItemName(picked)
  const id = String(picked.id || '')
  const page = await fetchEntryPageById(id)
  if (!page) return { ok: false, reason: 'entry_missing', name, id }
  const text = await buildBookTextFromEntryPage(page)
  if (!text) return { ok: false, reason: 'empty', name, id }

  const out = `${slugify(name)}.txt`
  const filePath = path.join(booksRoot, out)
  await fs.writeFile(filePath, text, 'utf8')

  const index = await loadIndex()
  const books = index.books || []
  const sig = selectorSignature(picked)
  const next = {
    title: name,
    file: out,
    source: `wiki:${id}`,
    selectorSig: sig,
    bookSchemaVersion: BOOK_TEXT_SCHEMA_VERSION
  }
  const pos = books.findIndex(b => String(b.source || '') === `wiki:${id}`)
  if (pos >= 0) books[pos] = next
  else books.push(next)
  books.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
  await saveIndex({ books })
  return { ok: true, name, id }
}

async function updateOneRoleStoryByName(rawName = '') {
  await ensureDirs()
  const items = await listSelectorItems(25, 20)
  const picked = pickSelectorItemByName(items, rawName)
  if (!picked) return { ok: false, reason: 'not_found' }

  const name = getSelectorItemName(picked)
  const id = String(picked.id || '')
  const page = await fetchEntryPageById(id)
  if (!page) return { ok: false, reason: 'entry_missing', name, id }
  const ext = extractRoleStory(page)
  if (!ext.detail && !ext.stories?.length && !ext.others?.length) return { ok: false, reason: 'empty', name, id }

  const filePath = path.join(storyRoot, `${slugify(name)}.json`)
  const role = {
    id,
    name,
    alias: [normalizeRoleName(name)],
    detail: ext.detail || '',
    stories: ext.stories || [],
    others: ext.others || []
  }
  await fs.writeFile(filePath, JSON.stringify(role, null, 2), 'utf8')

  const idx = await loadStoryIndex()
  const roles = idx.roles || []
  upsertById(roles, {
    id,
    name,
    alias: role.alias,
    storyCount: role.stories.length,
    otherCount: role.others.length,
    selectorSig: selectorSignature(picked),
    schemaVersion: ROLE_STORY_SCHEMA_VERSION
  })
  roles.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  await fs.writeFile(storyIndexFile, JSON.stringify({ roles, updatedAt: Date.now() }, null, 2), 'utf8')
  return { ok: true, name, id }
}

async function updateOneVoiceByName(rawName = '') {
  await ensureDirs()
  const items = await listSelectorItems(25, 20)
  const picked = pickSelectorItemByName(items, rawName)
  if (!picked) return { ok: false, reason: 'not_found' }

  const name = getSelectorItemName(picked)
  const id = String(picked.id || '')
  const page = await fetchEntryPageById(id)
  if (!page) return { ok: false, reason: 'entry_missing', name, id }
  const tabs = parseRoleVoices(page)
  if (!tabs.length) return { ok: false, reason: 'empty', name, id }

  const filePath = path.join(voiceRoot, `${slugify(name)}.json`)
  const voice = { id, name, alias: [normalizeRoleName(name)], tabs }
  await fs.writeFile(filePath, JSON.stringify(voice, null, 2), 'utf8')

  const idx = await loadVoiceIndex()
  const roles = idx.roles || []
  upsertById(roles, {
    id,
    name,
    alias: voice.alias,
    langCount: tabs.length,
    itemCount: tabs.reduce((sum, t) => sum + (t.items || []).length, 0),
    selectorSig: selectorSignature(picked)
  })
  roles.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  await fs.writeFile(voiceIndexFile, JSON.stringify({ roles, updatedAt: Date.now() }, null, 2), 'utf8')
  return { ok: true, name, id }
}

async function updateOnePlotByName(rawName = '') {
  await ensureDirs()
  const items = await listSelectorItems(43, 50)
  const picked = pickSelectorItemByName(items, rawName)
  if (!picked) return { ok: false, reason: 'not_found' }

  const name = getSelectorItemName(picked)
  const id = String(picked.id || '')
  const page = await fetchEntryPageById(id)
  if (!page) return { ok: false, reason: 'entry_missing', name, id }
  const sections = parsePlotPage(page)
  const searchText = parsePlotSearchText(page)
  if (!sections.length && !searchText) return { ok: false, reason: 'empty', name, id }

  const fileName = buildPlotFileName(name, id)
  const filePath = path.join(plotRoot, fileName)
  const category = parsePlotCategory(picked.ext)
  const subtitle = extractPlotSubtitle(page)
  const data = { id, name, file: fileName, alias: [normalizeRoleName(name)], category, subtitle, sections, searchText }
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')

  const idx = await loadPlotIndex()
  const arr = idx.items || []
  upsertById(arr, {
    id,
    name,
    file: fileName,
    alias: data.alias,
    category,
    subtitle,
    sectionCount: sections.length,
    selectorSig: selectorSignature(picked),
    plotSchemaVersion: PLOT_TEXT_SCHEMA_VERSION
  })
  arr.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || String(a.id).localeCompare(String(b.id)))
  await fs.writeFile(plotIndexFile, JSON.stringify({ items: arr, updatedAt: Date.now() }, null, 2), 'utf8')
  return { ok: true, name, id }
}

async function updateOneMapByName(rawName = '') {
  await ensureDirs()
  const items = await listSelectorItems(251, 50)
  const picked = pickSelectorItemByName(items, rawName)
  if (!picked) return { ok: false, reason: 'not_found' }

  const name = getSelectorItemName(picked)
  const id = String(picked.id || '')
  const page = await fetchEntryPageById(id)
  if (!page) return { ok: false, reason: 'entry_missing', name, id }
  const sections = parseMapPage(page)
  const searchText = sections.map(sec => `【${sec.title || '交互文本'}】\n${sec.text || ''}`).join('\n\n').trim()
  if (!sections.length && !searchText) return { ok: false, reason: 'empty', name, id }

  const fileName = buildMapFileName(name, id)
  const filePath = path.join(mapRoot, fileName)
  const data = { id, name, file: fileName, alias: [normalizeRoleName(name)], sections, searchText }
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')

  const idx = await loadMapIndex()
  const arr = idx.items || []
  upsertById(arr, {
    id,
    name,
    file: fileName,
    alias: data.alias,
    sectionCount: sections.length,
    selectorSig: selectorSignature(picked),
    mapSchemaVersion: MAP_TEXT_SCHEMA_VERSION
  })
  arr.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || String(a.id).localeCompare(String(b.id)))
  await fs.writeFile(mapIndexFile, JSON.stringify({ items: arr, updatedAt: Date.now() }, null, 2), 'utf8')
  return { ok: true, name, id }
}

async function updateOneAnecdoteByName(rawName = '') {
  await ensureDirs()
  const items = await listSelectorItems(261, 50)
  const picked = pickSelectorItemByName(items, rawName)
  if (!picked) return { ok: false, reason: 'not_found' }

  const name = getSelectorItemName(picked)
  const id = String(picked.id || '')
  const page = await fetchEntryPageById(id)
  if (!page) return { ok: false, reason: 'entry_missing', name, id }
  const sections = parseAnecdotePage(page)
  const searchText = sections.map(sec => `【${sec.title || '文本'}】\n${sec.text || ''}`).join('\n\n').trim()
  if (!sections.length && !searchText) return { ok: false, reason: 'empty', name, id }

  const fileName = buildAnecdoteFileName(name, id)
  const filePath = path.join(anecdoteRoot, fileName)
  const data = { id, name, file: fileName, alias: [normalizeRoleName(name)], sections, searchText }
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')

  const idx = await loadAnecdoteIndex()
  const arr = idx.items || []
  upsertById(arr, {
    id,
    name,
    file: fileName,
    alias: data.alias,
    sectionCount: sections.length,
    selectorSig: selectorSignature(picked)
  })
  arr.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || String(a.id).localeCompare(String(b.id)))
  await fs.writeFile(anecdoteIndexFile, JSON.stringify({ items: arr, updatedAt: Date.now() }, null, 2), 'utf8')
  return { ok: true, name, id }
}

async function updateOneCardByName(rawName = '') {
  await ensureDirs()
  const items = await listSelectorItems(249, 50)
  const picked = pickSelectorItemByName(items, rawName)
  if (!picked) return { ok: false, reason: 'not_found' }

  const name = getSelectorItemName(picked)
  const id = String(picked.id || '')
  const page = await fetchEntryPageById(id)
  if (!page) return { ok: false, reason: 'entry_missing', name, id }
  const sections = parseCardPage(page)
  const searchText = sections.map(sec => `【${sec.title || '文本'}】\n${sec.text || ''}`).join('\n\n').trim()
  if (!sections.length && !searchText) return { ok: false, reason: 'empty', name, id }

  const fileName = buildCardFileName(name, id)
  const filePath = path.join(cardRoot, fileName)
  const data = { id, name, file: fileName, alias: [normalizeRoleName(name)], sections, searchText }
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')

  const idx = await loadCardIndex()
  const arr = idx.items || []
  upsertById(arr, {
    id,
    name,
    file: fileName,
    alias: data.alias,
    sectionCount: sections.length,
    selectorSig: selectorSignature(picked)
  })
  arr.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || String(a.id).localeCompare(String(b.id)))
  await fs.writeFile(cardIndexFile, JSON.stringify({ items: arr, updatedAt: Date.now() }, null, 2), 'utf8')
  return { ok: true, name, id }
}

async function updateOneRelicByName(rawName = '') {
  await ensureDirs()
  const items = await listSelectorItems(218, 20)
  const picked = pickSelectorItemByName(items, rawName)
  if (!picked) return { ok: false, reason: 'not_found' }

  const name = getSelectorItemName(picked)
  const id = String(picked.id || '')
  const page = await fetchEntryPageById(id)
  if (!page) return { ok: false, reason: 'entry_missing', name, id }
  const pieces = []
  for (const m of (page.modules || [])) {
    const p = parseRelicPiece(m)
    if (p && p.name) pieces.push(p)
  }
  if (!pieces.length) return { ok: false, reason: 'empty', name, id }

  const filePath = path.join(relicRoot, `${slugify(name)}.json`)
  const data = { id, name, alias: [normalizeRoleName(name)], pieces }
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')

  const idx = await loadRelicIndex()
  const sets = idx.sets || []
  upsertById(sets, {
    id,
    name,
    alias: data.alias,
    pieceCount: pieces.length,
    selectorSig: selectorSignature(picked)
  })
  sets.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  await fs.writeFile(relicIndexFile, JSON.stringify({ sets, updatedAt: Date.now() }, null, 2), 'utf8')
  return { ok: true, name, id }
}

async function updateOneWeaponByName(rawName = '') {
  await ensureDirs()
  const items = await listSelectorItems(5, 20)
  const picked = pickSelectorItemByName(items, rawName)
  if (!picked) return { ok: false, reason: 'not_found' }

  const name = getSelectorItemName(picked)
  const id = String(picked.id || '')
  const page = await fetchEntryPageById(id)
  if (!page) return { ok: false, reason: 'entry_missing', name, id }
  const story = parseWeaponStory(page)
  if (!story) return { ok: false, reason: 'empty', name, id }

  const filePath = path.join(weaponRoot, `${slugify(name)}.json`)
  const data = { id, name, alias: [normalizeRoleName(name)], story }
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8')

  const idx = await loadWeaponIndex()
  const weapons = idx.weapons || []
  upsertById(weapons, {
    id,
    name,
    alias: data.alias,
    selectorSig: selectorSignature(picked)
  })
  weapons.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  await fs.writeFile(weaponIndexFile, JSON.stringify({ weapons, updatedAt: Date.now() }, null, 2), 'utf8')
  return { ok: true, name, id }
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
  buildMapFileName,
  resolveMapFile,
  buildAnecdoteFileName,
  resolveAnecdoteFile,
  buildCardFileName,
  resolveCardFile,
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
  parseMapPage,
  renderMapText,
  parseAnecdotePage,
  renderAnecdoteText,
  parseCardPage,
  renderCardText,
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
  fetchMapAll,
  fetchAnecdoteAll,
  fetchCardAll,
  fetchVoiceAll,
  renderWeaponText,
  makeSnippet,
  chunkLines,
  buildBookSectionsFromEntryPage,
  buildBookTextFromEntryPage,
  fetchBooksFromWiki,
  updateOneBookByName,
  updateOneRoleStoryByName,
  updateOneVoiceByName,
  updateOnePlotByName,
  updateOneMapByName,
  updateOneAnecdoteByName,
  updateOneCardByName,
  updateOneRelicByName,
  updateOneWeaponByName,
  replyLong
}
