import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import puppeteer from 'puppeteer'
import { pluginDir, defaultBg, fontFile, tmpRoot, ensureDirs } from '../base.js'
import { escapeHtml, splitTextPages } from './text-volumes.js'

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
        '#圣遗物帮助 / #武器帮助 / #背包帮助'
      ]
    },
    {
      title: '直接读取',
      lines: [
        '#书名',
        '#角色名故事 / #角色名故事详情',
        '#角色名语音 / #任务名剧情 / #地图名地图文本',
        '#角色名角色逸闻 / #圣牌名月谕圣牌',
        '#套装名圣遗物 / #武器名武器故事 / #背包名背包'
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
        '#角色逸闻搜索 / #月谕圣牌搜索 / #背包搜索',
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
        '#圣遗物更新 / #武器更新 / #背包更新 / #书籍导入'
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
    <div class='sub'>覆盖书籍、角色故事、语音、剧情、地图文本、角色逸闻、月谕圣牌、圣遗物、武器故事、背包。默认文本，带“图片”返回图片。</div>
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

export {
  buildHelpList,
  renderHelpImage,
  renderMainHelpImage,
  pickBgDataUri,
  pickFontDataUri,
  textPageHtml,
  renderTextAsImages
}
