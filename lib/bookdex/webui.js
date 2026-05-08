import http from 'node:http'
import os from 'node:os'
import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import {
  booksRoot,
  storyRoot,
  relicRoot,
  weaponRoot,
  voiceRoot,
  plotRoot,
  mapRoot,
  anecdoteRoot,
  cardRoot,
  backpackRoot,
  fontFile,
  loadIndex,
  loadStoryIndex,
  loadRelicIndex,
  loadWeaponIndex,
  loadVoiceIndex,
  loadPlotIndex,
  loadMapIndex,
  loadAnecdoteIndex,
  loadCardIndex,
  loadBackpackIndex,
  slugify
} from './base.js'
import {
  fetchBooksFromWiki,
  fetchRoleStoryAll,
  fetchRelicAll,
  fetchWeaponAll,
  fetchVoiceAll,
  fetchPlotAll,
  fetchMapAll,
  fetchAnecdoteAll,
  fetchCardAll,
  fetchBackpackAll
} from './core/fetchers.js'
import {
  renderRoleStoryText,
  renderVoiceListText,
  renderRelicText,
  renderWeaponText
} from './core/parse-entities.js'
import { renderPlotText } from './core/parse-plot.js'
import { renderMapText, renderAnecdoteText, renderCardText, renderBackpackText } from './core/parse-map-card.js'
import { resolvePlotFile, resolveMapFile, resolveAnecdoteFile, resolveCardFile, resolveBackpackFile } from './core/paths.js'
import { formatFetchError } from './core/crypto-api.js'
import { runBookDexTextSearch } from './core/search.js'
import { renderBookTextWithDescription } from './core/inbox-books.js'
import {
  loadBookDexWebConfig,
  saveBookDexWebConfig,
  getConfiguredNextAutoRun,
  formatGmt8
} from './webui-config.js'

const TYPE_LABELS = {
  book: '书籍',
  role: '角色故事',
  relic: '圣遗物',
  weapon: '武器故事',
  voice: '角色语音',
  plot: '剧情文本',
  map: '地图文本',
  anecdote: '角色逸闻',
  card: '月谕圣牌',
  backpack: '背包'
}

const CARD_EXCLUDE_NAMES = new Set(['本期规则', '演出奖励'])
const CARD_NUMERAL_VALUES = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
  十一: 11,
  十二: 12,
  十三: 13,
  十四: 14,
  十五: 15,
  十六: 16,
  十七: 17,
  十八: 18,
  十九: 19,
  二十: 20,
  二十一: 21,
  二十二: 22
}

const UPDATE_TASKS = {
  book: fetchBooksFromWiki,
  role: fetchRoleStoryAll,
  relic: fetchRelicAll,
  weapon: fetchWeaponAll,
  voice: fetchVoiceAll,
  plot: fetchPlotAll,
  map: fetchMapAll,
  anecdote: fetchAnecdoteAll,
  card: fetchCardAll,
  backpack: fetchBackpackAll
}

let webServer = null
let webInfo = null
const jobs = new Map()

function makeJson(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(JSON.stringify(data))
}

function makeText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store'
  })
  res.end(text)
}

async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? JSON.parse(text) : {}
}

function getLanHost() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.family === 'IPv4' && !item.internal) return item.address
    }
  }
  return '127.0.0.1'
}

function makePublicUrl(cfg) {
  const host = cfg.webui.publicHost || (['0.0.0.0', '::'].includes(cfg.webui.host) ? getLanHost() : cfg.webui.host)
  return `http://${host}:${cfg.webui.port}/`
}

function createWebServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url)
      if (url.pathname === '/assets/zh-cn.ttf') {
        const font = await fs.readFile(fontFile)
        res.writeHead(200, {
          'content-type': 'font/ttf',
          'cache-control': 'public, max-age=604800'
        })
        return res.end(font)
      }
      return makeText(res, 200, clientHtml(), 'text/html; charset=utf-8')
    } catch (error) {
      return makeJson(res, error.status || 500, { error: formatFetchError(error) })
    }
  })
}

function listenServer(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

function isPortUnavailable(error) {
  return ['EADDRINUSE', 'EACCES'].includes(error?.code)
}

function normalizeKeyword(value) {
  return String(value || '').trim().toLowerCase()
}

function scoreText(name = '', text = '', keyword = '') {
  if (!keyword) return 1
  const n = String(name || '').toLowerCase()
  const t = String(text || '').toLowerCase()
  if (n === keyword) return 100
  if (n.includes(keyword)) return 80
  const pos = t.indexOf(keyword)
  return pos >= 0 ? Math.max(5, 60 - Math.floor(pos / 500)) : 0
}

function snippet(text = '', keyword = '') {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  if (!keyword) return flat.slice(0, 160)
  const idx = flat.toLowerCase().indexOf(keyword)
  if (idx < 0) return flat.slice(0, 160)
  const start = Math.max(0, idx - 60)
  return `${start ? '...' : ''}${flat.slice(start, idx + 120)}${idx + 120 < flat.length ? '...' : ''}`
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'))
}

function pageItems(items, page = 1, pageSize = 50) {
  const p = Math.max(1, Number(page) || 1)
  const size = Math.min(200, Math.max(10, Number(pageSize) || 50))
  return {
    page: p,
    pageSize: size,
    total: items.length,
    items: items.slice((p - 1) * size, p * size)
  }
}

function getCardOrder(name = '') {
  const match = String(name || '').match(/月谕圣牌[·・](.+?)[·・]/)
  return CARD_NUMERAL_VALUES[match?.[1]] || 999
}

async function getTypeEntries(type) {
  if (type === 'book') {
    const index = await loadIndex()
    return (index.books || []).map(item => ({ type, id: String(item.source || '').replace(/^wiki:/, ''), name: item.title, file: item.file, desc: item.desc || '' }))
  }
  if (type === 'role') {
    const index = await loadStoryIndex()
    return (index.roles || []).map(item => ({ type, id: String(item.id || item.name), name: item.name }))
  }
  if (type === 'relic') {
    const index = await loadRelicIndex()
    return (index.sets || []).map(item => ({ type, id: String(item.id || item.name), name: item.name }))
  }
  if (type === 'weapon') {
    const index = await loadWeaponIndex()
    return (index.weapons || []).map(item => ({ type, id: String(item.id || item.name), name: item.name }))
  }
  if (type === 'voice') {
    const index = await loadVoiceIndex()
    return (index.roles || []).map(item => ({ type, id: String(item.id || item.name), name: item.name }))
  }
  const indexLoaders = { plot: loadPlotIndex, map: loadMapIndex, anecdote: loadAnecdoteIndex, card: loadCardIndex, backpack: loadBackpackIndex }
  const index = await indexLoaders[type]?.()
  return (index?.items || [])
    .filter(item => type !== 'card' || !CARD_EXCLUDE_NAMES.has(String(item.name || '').trim()))
    .map(item => ({ type, id: String(item.id || item.name), name: item.name, file: item.file, subtitle: item.subtitle, category: item.category }))
}

async function listEntries(type, page, pageSize) {
  const entries = await getTypeEntries(type)
  entries.sort((a, b) => {
    if (type === 'card') return getCardOrder(a.name) - getCardOrder(b.name) || String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN')
    return String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hans-CN')
  })
  return pageItems(entries, page, pageSize)
}

async function getEntryContent(type, id) {
  const entries = await getTypeEntries(type)
  const meta = entries.find(item => String(item.id) === String(id) || item.name === id)
  if (!meta) return null

  if (type === 'book') {
    const file = path.join(booksRoot, meta.file || `${meta.name}.txt`)
    const text = fss.existsSync(file) ? await fs.readFile(file, 'utf8') : ''
    return { ...meta, text: renderBookTextWithDescription(meta.name, text, meta.desc) }
  }
  if (type === 'role') {
    const file = path.join(storyRoot, `${slugify(meta.name)}.json`)
    const data = await readJson(file)
    return { ...meta, text: renderRoleStoryText(data, 'story') }
  }
  if (type === 'relic') {
    const file = path.join(relicRoot, `${slugify(meta.name)}.json`)
    const data = await readJson(file)
    return { ...meta, text: renderRelicText(data) }
  }
  if (type === 'weapon') {
    const file = path.join(weaponRoot, `${slugify(meta.name)}.json`)
    const data = await readJson(file)
    return { ...meta, text: renderWeaponText(data) }
  }
  if (type === 'voice') {
    const file = path.join(voiceRoot, `${slugify(meta.name)}.json`)
    const data = await readJson(file)
    return { ...meta, text: renderVoiceListText(data, true) }
  }

  const roots = { plot: plotRoot, map: mapRoot, anecdote: anecdoteRoot, card: cardRoot, backpack: backpackRoot }
  const resolvers = { plot: resolvePlotFile, map: resolveMapFile, anecdote: resolveAnecdoteFile, card: resolveCardFile, backpack: resolveBackpackFile }
  const renderers = { plot: renderPlotText, map: renderMapText, anecdote: renderAnecdoteText, card: renderCardText, backpack: renderBackpackText }
  const file = meta.file ? path.join(roots[type], meta.file) : resolvers[type](meta)
  const data = await readJson(file)
  return { ...meta, text: renderers[type](data, 'full') }
}

async function searchEntries(keyword, types) {
  const selected = (types?.length ? types : Object.keys(TYPE_LABELS)).filter(type => TYPE_LABELS[type])
  const rows = await runBookDexTextSearch(keyword, selected)
  return rows.map(row => ({ ...row, label: TYPE_LABELS[row.type] || row.type })).slice(0, 200)
}

function createJob(type) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const job = {
    id,
    type,
    status: 'running',
    step: '',
    done: 0,
    total: 0,
    percent: 0,
    logs: [],
    startedAt: Date.now(),
    finishedAt: 0
  }
  jobs.set(id, job)
  setTimeout(() => jobs.delete(id), 2 * 3600 * 1000).unref?.()
  return job
}

function updateJob(job, patch = {}) {
  Object.assign(job, patch)
  if (job.total) job.percent = Math.min(100, Math.round((Number(job.done || 0) / Number(job.total || 1)) * 100))
}

function makeJobReporter(job, label) {
  return {
    onProgress: ({ done, total }) => updateJob(job, { step: label, done, total }),
    onError: ({ name, error }) => job.logs.push(`${label}${name ? `｜${name}` : ''}：${formatFetchError(error)}`)
  }
}

async function runUpdateJob(job, type) {
  try {
    const keys = type === 'all' ? Object.keys(UPDATE_TASKS) : [type]
    let index = 0
    const results = []
    for (const key of keys) {
      index += 1
      const label = TYPE_LABELS[key]
      updateJob(job, { step: `正在更新${label}`, done: 0, total: 0, percent: Math.round(((index - 1) / keys.length) * 100) })
      const ret = await UPDATE_TASKS[key](makeJobReporter(job, label))
      results.push({ type: key, label, ...ret })
      job.logs.push(`${label}完成：${ret.total ?? 0} 条目，本次变更 ${ret.updated ?? 0}`)
    }
    updateJob(job, { status: 'done', step: '完成', done: keys.length, total: keys.length, percent: 100, results, finishedAt: Date.now() })
  } catch (error) {
    updateJob(job, { status: 'failed', step: '失败', error: formatFetchError(error), finishedAt: Date.now() })
  }
}

async function startUpdate(type) {
  if (type !== 'all' && !UPDATE_TASKS[type]) throw new Error('未知更新分量')
  for (const job of jobs.values()) {
    if (job.status === 'running') throw new Error('已有更新任务正在运行，请稍后再试')
  }
  const job = createJob(type)
  runUpdateJob(job, type)
  return job
}

async function getStats() {
  const pairs = await Promise.all(Object.keys(TYPE_LABELS).map(async type => {
    try {
      const entries = await getTypeEntries(type)
      return [type, entries.length]
    } catch {
      return [type, 0]
    }
  }))
  return Object.fromEntries(pairs)
}

function clientHtml() {
  const types = Object.entries(TYPE_LABELS).map(([key, label]) => ({ key, label }))
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>原神文本助手</title>
<style>
@font-face{font-family:"GenshinText";src:url("/assets/zh-cn.ttf") format("truetype");font-display:swap}
:root{--bg:#fff;--ink:#1f1f1f;--muted:#666;--card:#fff;--line:#e8e8e8;--accent:#111;--accent2:#555;--danger:#b3261e}
*{box-sizing:border-box}body{margin:0;font-family:"GenshinText","Songti SC","STSong",serif;background:#fff;color:var(--ink)}
header{padding:28px clamp(16px,4vw,52px) 18px;display:flex;gap:18px;justify-content:space-between;align-items:end;flex-wrap:wrap}
h1{font-size:clamp(30px,6vw,62px);line-height:.9;margin:0;letter-spacing:-.05em}header p{margin:10px 0 0;color:var(--muted)}
main{padding:0 clamp(16px,4vw,52px) 44px;display:grid;grid-template-columns:minmax(230px,300px) 1fr;gap:18px}
.panel{background:#fff;border:1px solid var(--line);border-radius:24px;box-shadow:none}
aside{padding:16px;position:sticky;top:14px;height:max-content}.content{padding:18px;min-height:70vh}
button,input,select{font:inherit}button{border:1px solid var(--line);border-radius:14px;background:#fff;color:var(--ink);padding:10px 13px;cursor:pointer}button.secondary{background:#fff;color:var(--ink)}button.accent{background:#111;color:#fff}button.danger{background:var(--danger);color:#fff}
input,select{width:100%;border:1px solid var(--line);border-radius:14px;background:#fff;padding:11px 12px;color:var(--ink)}input::placeholder{color:#999}label{display:block;margin:12px 0 6px;color:var(--muted);font-size:13px}
.tabs{display:grid;gap:8px}.tab{display:flex;justify-content:space-between;align-items:center;background:#fff;color:var(--ink);text-align:left}.tab.active{background:#111;color:#fff}
.toolbar{display:grid;grid-template-columns:1fr auto auto;gap:10px;margin-bottom:14px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px}.card{padding:14px;border:1px solid var(--line);border-radius:18px;background:#fff;color:var(--ink);cursor:pointer}.card:hover{border-color:#111;transform:translateY(-1px)}
.name{font-weight:700;color:var(--ink)}.meta,.small{color:var(--muted);font-size:13px}.viewer{white-space:pre-wrap;line-height:1.72;background:#fff;border:1px solid var(--line);border-radius:18px;padding:18px;max-height:68vh;overflow:auto;color:var(--ink)}
.progress{height:14px;background:#f0f0f0;border-radius:999px;overflow:hidden}.bar{height:100%;width:0;background:#111;transition:.3s}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.search-row{display:grid;grid-template-columns:1fr auto;gap:8px}.settings{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}.pill{display:inline-flex;padding:4px 9px;border-radius:999px;background:#fff;color:var(--ink);border:1px solid var(--line);font-size:12px}
@media(max-width:820px){header{padding:20px 14px 12px}main{grid-template-columns:1fr;padding:0 12px 28px}.panel{border-radius:18px}aside{position:static}.toolbar{grid-template-columns:1fr}.grid{grid-template-columns:1fr}.row button,.search-row button{width:100%}.search-row{grid-template-columns:1fr}.viewer{max-height:none}}
</style>
</head>
<body>
<header><div><h1>原神文本助手</h1></div><div class="row"><span id="health" class="pill">连接中</span><button class="secondary" onclick="showSettings()">设置</button></div></header>
<main>
<aside class="panel">
<label>搜索</label><div class="search-row"><input id="q" placeholder="输入关键词，回车搜索"><button class="accent" id="searchBtn" type="button">搜索</button></div>
<label>分类</label><div id="tabs" class="tabs"></div>
<label>更新</label><div class="row"><button class="accent" onclick="startUpdate('all')">统一更新</button><button class="secondary" onclick="startUpdate(currentType)">更新当前分量</button></div>
<div id="jobBox" style="display:none;margin-top:14px"><div class="small" id="jobText"></div><div class="progress"><div id="jobBar" class="bar"></div></div><pre class="small" id="jobLog"></pre></div>
</aside>
<section class="panel content"><div id="app"></div></section>
</main>
<script>
const TYPES=${JSON.stringify(types)};
let currentType='book', currentPage=1;
const el=id=>document.getElementById(id);
const api=(url,opt={})=>fetch(url,{...opt,headers:{'content-type':'application/json',...(opt.headers||{})}}).then(async r=>{const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.statusText);return j});
function esc(s){return String(s||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]))}
function showError(e){el('app').innerHTML='<p class="small">操作失败：'+esc(e.message||e)+'</p>'}
function renderTabs(stats={}){el('tabs').innerHTML=TYPES.map(t=>'<button class="tab '+(t.key===currentType?'active':'')+'" onclick="openType(\\''+t.key+'\\')"><span>'+t.label+'</span><span>'+(stats[t.key]||0)+'</span></button>').join('')}
async function boot(){const s=await api('/api/status');el('health').textContent='在线｜'+s.url;renderTabs(s.stats);return openType(currentType)}
async function openType(type,page=1){try{currentType=type;currentPage=page;document.querySelectorAll('.tab').forEach(x=>x.classList.remove('active'));const data=await api('/api/list?type='+type+'&page='+page);el('app').innerHTML='<div class="toolbar"><div><b>'+TYPES.find(t=>t.key===type).label+'</b><div class="small">共 '+data.total+' 条</div></div><button class="secondary" '+(page<=1?'disabled':'')+' onclick="openType(currentType,currentPage-1)">上一页</button><button class="secondary" '+(page*data.pageSize>=data.total?'disabled':'')+' onclick="openType(currentType,currentPage+1)">下一页</button></div><div class="grid">'+data.items.map(item=>'<div class="card" onclick="openEntry(\\''+item.type+'\\',\\''+item.id+'\\')"><div class="name">'+esc(item.name)+'</div><div class="meta">'+esc(item.category||item.subtitle||item.id)+'</div></div>').join('')+'</div>'}catch(e){showError(e)}}
async function openEntry(type,id){try{const item=await api('/api/content?type='+type+'&id='+encodeURIComponent(id));el('app').innerHTML='<div class="toolbar"><div><b>'+esc(item.name)+'</b><div class="small">'+TYPES.find(t=>t.key===type).label+'</div></div><button class="secondary" onclick="openType(currentType,currentPage)">返回</button><button class="accent" onclick="startUpdate(currentType)">更新分量</button></div><div class="viewer">'+esc(item.text||'暂无内容')+'</div>'}catch(e){showError(e)}}
async function doSearch(){try{const q=el('q').value.trim();if(!q)return openType(currentType);el('app').innerHTML='<p class="small">正在搜索...</p>';const data=await api('/api/search?q='+encodeURIComponent(q));el('app').innerHTML='<div class="toolbar"><div><b>搜索：'+esc(q)+'</b><div class="small">找到 '+data.items.length+' 条，最多显示 200 条</div></div></div><div class="grid">'+data.items.map(item=>'<div class="card" onclick="openEntry(\\''+item.type+'\\',\\''+item.id+'\\')"><span class="pill">'+item.label+'</span><div class="name">'+esc(item.name)+'</div><div class="meta">'+esc(item.snippet||item.id)+'</div></div>').join('')+'</div>'}catch(e){showError(e)}}
async function startUpdate(type){el('jobBox').style.display='block';el('jobText').textContent='正在创建更新任务...';el('jobBar').style.width='3%';el('jobLog').textContent='';try{const data=await api('/api/update',{method:'POST',body:JSON.stringify({type})});pollJob(data.id)}catch(e){el('jobText').textContent='更新启动失败';el('jobLog').textContent=e.message}}
async function pollJob(id){try{const j=await api('/api/job?id='+id);el('jobText').textContent=(j.status==='running'?'更新中：':'更新结束：')+j.step+' '+(j.percent||0)+'%';el('jobBar').style.width=(j.percent||0)+'%';el('jobLog').textContent=(j.logs||[]).slice(-10).join('\\n')+(j.error?'\\n'+j.error:'');if(j.status==='running')setTimeout(()=>pollJob(id),1200);else boot()}catch(e){el('jobText').textContent='进度获取失败';el('jobLog').textContent=e.message}}
async function showSettings(){try{const s=await api('/api/settings');el('app').innerHTML='<h2>设置</h2><div class="settings"><div><label><input id="autoEnabled" type="checkbox" '+(s.autoUpdate.enabled?'checked':'')+' style="width:auto"> 自动更新</label><div class="small">默认下次：'+esc(s.autoUpdate.defaultNextRunAtText)+'</div><div class="small">当前下次：'+esc(s.autoUpdate.nextRunAtText)+'</div></div><div><label>自定义下次时间（GMT+8，可留空）</label><input id="nextRunAt" placeholder="YYYY-MM-DD HH:mm" value="'+esc(s.autoUpdate.nextRunAt||'')+'"></div></div><p class="row"><button class="accent" onclick="saveSettings()">保存设置</button></p>'}catch(e){showError(e)}}
async function saveSettings(){try{await api('/api/settings',{method:'POST',body:JSON.stringify({autoUpdate:{enabled:el('autoEnabled').checked,nextRunAt:el('nextRunAt').value.trim()}})});showSettings()}catch(e){showError(e)}}
el('q').addEventListener('keydown',e=>{if(e.key==='Enter')doSearch()});
el('searchBtn').addEventListener('click',doSearch);
boot().catch(e=>{el('health').textContent='异常';showError(e)});
</script>
</body></html>`
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/status') {
    const cfg = await loadBookDexWebConfig()
    return makeJson(res, 200, { ok: true, url: webInfo?.url || makePublicUrl(cfg), stats: await getStats() })
  }
  if (url.pathname === '/api/list') {
    const type = url.searchParams.get('type') || 'book'
    return makeJson(res, 200, await listEntries(type, url.searchParams.get('page'), url.searchParams.get('pageSize')))
  }
  if (url.pathname === '/api/content') {
    const item = await getEntryContent(url.searchParams.get('type'), url.searchParams.get('id'))
    if (!item) return makeJson(res, 404, { error: '未找到条目' })
    return makeJson(res, 200, item)
  }
  if (url.pathname === '/api/search') {
    const types = url.searchParams.get('types')?.split(',').filter(Boolean)
    return makeJson(res, 200, { items: await searchEntries(url.searchParams.get('q'), types) })
  }
  if (url.pathname === '/api/job') {
    const job = jobs.get(url.searchParams.get('id'))
    if (!job) return makeJson(res, 404, { error: '任务不存在或已过期' })
    return makeJson(res, 200, job)
  }
  if (url.pathname === '/api/settings' && req.method === 'GET') {
    const cfg = await loadBookDexWebConfig()
    const next = getConfiguredNextAutoRun(cfg)
    return makeJson(res, 200, {
      autoUpdate: {
        enabled: Boolean(cfg.autoUpdate.enabled),
        nextRunAt: cfg.autoUpdate.nextRunAt || '',
        nextRunAtText: next.nextRunAtText,
        defaultNextRunAtText: getConfiguredNextAutoRun({ ...cfg, autoUpdate: { enabled: true, nextRunAt: '' } }).nextRunAtText
      },
      webui: {
        port: webInfo?.port || cfg.webui.port,
        host: cfg.webui.host,
        publicHost: cfg.webui.publicHost || '',
        url: webInfo?.url || makePublicUrl(cfg)
      }
    })
  }
  if (url.pathname === '/api/settings' && req.method === 'POST') {
    const cfg = await loadBookDexWebConfig()
    const body = await readBody(req)
    const next = {
      ...cfg,
      autoUpdate: {
        ...cfg.autoUpdate,
        enabled: Boolean(body?.autoUpdate?.enabled),
        nextRunAt: String(body?.autoUpdate?.nextRunAt || '').trim()
      }
    }
    return makeJson(res, 200, { ok: true, config: await saveBookDexWebConfig(next) })
  }
  if (url.pathname === '/api/update' && req.method === 'POST') {
    const body = await readBody(req)
    const job = await startUpdate(body.type || 'all')
    return makeJson(res, 200, { id: job.id })
  }
  return makeJson(res, 404, { error: '接口不存在' })
}

async function startBookDexWebUi({ logger: log = console } = {}) {
  if (webServer) return webInfo
  const cfg = await loadBookDexWebConfig()
  if (!cfg.webui.enabled) return null

  const host = cfg.webui.host
  const basePort = Number(cfg.webui.port) || 14522
  let lastError = null

  for (let offset = 0; offset < 50; offset++) {
    const port = basePort + offset
    const server = createWebServer()
    try {
      await listenServer(server, host, port)
      const runtimeCfg = { ...cfg, webui: { ...cfg.webui, port } }
      webServer = server
      webInfo = { ...runtimeCfg.webui, url: makePublicUrl(runtimeCfg) }
      webServer.on('error', error => log.error?.('[bookdex.webui]', error))
      if (port !== basePort) {
        log.warn?.(`[bookdex.webui] port ${basePort} unavailable, fallback to ${port}`)
      }
      log.mark?.(`[bookdex.webui] listening ${host}:${port}`)
      return webInfo
    } catch (error) {
      lastError = error
      try { server.close() } catch {}
      if (!isPortUnavailable(error)) throw error
    }
  }

  throw lastError || new Error(`WebUI 端口不可用：${basePort}-${basePort + 49}`)
}

function getBookDexWebUiInfo() {
  return webInfo
}

export { startBookDexWebUi, getBookDexWebUiInfo, TYPE_LABELS }
