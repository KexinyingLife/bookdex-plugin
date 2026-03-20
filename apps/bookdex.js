import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import {
  pluginDir,
  pluginFolder,
  cacheRoot,
  sessionCacheFile,
  booksRoot,
  storyRoot,
  relicRoot,
  weaponRoot,
  voiceRoot,
  TEXT_PAGE_CHARS,
  TEXT_FORWARD_BATCH_SIZE,
  slugify,
  ensureDirs,
  loadIndex,
  clearPluginData,
  loadStoryIndex,
  loadRelicIndex,
  loadWeaponIndex,
  loadVoiceIndex,
  loadPlotIndex
} from '../lib/bookdex/base.js'
import {
  rebuildBooksFromInbox,
  renderTextAsImages,
  pickDefaultVoiceTab,
  renderRoleStoryText,
  renderVoiceListText,
  renderVoiceEntryText,
  renderPlotText,
  sendVoiceRecord,
  renderRelicText,
  renderWeaponText,
  normalizeRoleName,
  resolvePlotFile,
  fetchBooksFromWiki,
  fetchRoleStoryAll,
  fetchVoiceAll,
  fetchPlotAll,
  fetchRelicAll,
  fetchWeaponAll,
  makeSnippet,
  chunkLines,
  splitTextPages,
  splitLeadingTitle
} from '../lib/bookdex/core.js'

const helpSessionCache = new Map()
let helpSessionCacheLoaded = false

function loadHelpSessionCache() {
  if (helpSessionCacheLoaded) return
  helpSessionCacheLoaded = true
  try {
    if (fss.existsSync(sessionCacheFile) === false) return
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

function makeReplyError(res, label = 'reply failed') {
  const msg = res?.error?.[0]?.message || res?.error?.[0]?.wording || label
  return new Error(msg)
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
          reg: '^[#＃]?[0-9０-９]{1,4}\\s*(文本|图片|语音)?$',
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

  makeUpdateReporter(label, silent = false) {
    return {
      onProgress: async ({ done, total }) => {
        if (silent || !done || !total) return
        if (done % 100 !== 0 && done !== total) return
        await this.reply(`${label}进度：${done}/${total}`)
      },
      onError: async ({ done, total, name, error }) => {
        if (silent) return
        const at = done && total ? `（${done}/${total}）` : ''
        const who = name ? `：${name}` : ''
        await this.reply(`${label}报错${at}${who}\n${error?.message || error}`)
      }
    }
  }

  async updateAllTextsCommand() {
    return this.updateAllTexts(false)
  }

  async updateAllTexts(silent = false) {
    if (typeof silent !== 'boolean') silent = false
    try {
      if (!silent) await this.reply('开始统一更新（1/7）：准备任务')

      if (!silent) await this.reply('统一更新（2/7）：正在更新书籍数据…')
      const b = await fetchBooksFromWiki(this.makeUpdateReporter('书籍更新', silent))

      if (!silent) await this.reply('统一更新（3/7）：正在更新角色故事数据…')
      const r = await fetchRoleStoryAll(this.makeUpdateReporter('角色故事更新', silent))

      if (!silent) await this.reply('统一更新（4/7）：正在更新圣遗物与武器数据…')
      const s = await fetchRelicAll(this.makeUpdateReporter('圣遗物更新', silent))
      const w = await fetchWeaponAll(this.makeUpdateReporter('武器故事更新', silent))

      if (!silent) await this.reply('统一更新（5/7）：正在更新角色语音数据…')
      const v = await fetchVoiceAll(this.makeUpdateReporter('角色语音更新', silent))

      if (!silent) await this.reply('统一更新（6/7）：正在更新剧情文本数据…')
      const p = await fetchPlotAll(this.makeUpdateReporter('剧情文本更新', silent))

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
    } catch (err) {
      logger.error('[bookdex.updateAllTexts] ', err)
      if (!silent) return this.reply(`统一更新失败：${err?.message || err}`)
      throw err
    }
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
    const ret = await fetchRoleStoryAll(this.makeUpdateReporter('角色故事更新'))
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
    const ret = await fetchVoiceAll(this.makeUpdateReporter('角色语音更新'))
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
    const ret = await fetchPlotAll(this.makeUpdateReporter('剧情文本更新'))
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
    return this.replyContent(item.name, text, wantImage)
  }

  async updateRelics() {
    await this.reply('开始抓取圣遗物文本，请稍等（约1-2分钟）')
    const ret = await fetchRelicAll(this.makeUpdateReporter('圣遗物更新'))
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
    const ret = await fetchWeaponAll(this.makeUpdateReporter('武器故事更新'))
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
    const ret = await fetchBooksFromWiki(this.makeUpdateReporter('书籍更新'))
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
    if (isReplyError(res)) throw makeReplyError(res)
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
      try {
        const imgs = await renderTextAsImages(title, text)
        if (imgs.length <= 1) {
          for (const img of imgs) {
            if (tracked) {
              session = await this.replyWithSession(segment.image(`file://${img}`), session)
            } else {
              const res = await this.reply(segment.image(`file://${img}`))
              if (isReplyError(res)) throw makeReplyError(res, 'image reply failed')
            }
          }
          return tracked ? (session || true) : true
        }

        const imageMsgs = imgs.map(img => segment.image(`file://${img}`))
        if (title) {
          if (tracked) session = await this.replyWithSession(title, session)
          else {
            const res = await this.reply(title)
            if (isReplyError(res)) throw makeReplyError(res, 'title reply failed')
          }
        }
        if (tracked) {
          session = await this.replyForwardBatchesWithSession(imageMsgs, session, 4)
          return session || true
        }
        await this.replyForwardBatchesWithSession(imageMsgs, null, 4)
        return true
      } catch {
        await this.reply('图片消息发送失败，已改为 txt 文件发送')
        return this.sendTxtFallback(text, title, tracked ? session : null)
      }
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
    if (!quotedId && this.hasReplyContext()) {
      return sessions[sessions.length - 1] || null
    }
    if (!quotedId) return sessions[sessions.length - 1] || null

    for (let i = sessions.length - 1; i >= 0; i--) {
      const session = sessions[i]
      const ids = (session.messageIds || []).map(String)
      if (ids.includes(quotedId)) return session
    }
    return sessions[sessions.length - 1] || null
  }

  async pickByIndex() {
    const raw = String(this.e.msg || '').trim()
    const normalized = raw
      .replace(/[＃#]/g, '')
      .replace(/[０-９]/g, ch => String(ch.charCodeAt(0) - 65248))
      .replace(/\s+/g, '')
    const idx = Number(normalized.replace(/(文本|图片|语音)$/, ''))
    if (!idx || idx < 1) return false

    const { wantImage, wantVoice } = this.outputMode(normalized)
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
      return this.replyContent(item.name, text, wantImage)
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
        return this.replyContent(item.name, text, wantImage)
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
    const norm = normalizeRoleName(title)

    const index = await loadIndex()
    const books = index.books || []
    const exact = books.find(b => b.title === title)
    const plotsIndex = await loadPlotIndex()
    const plots = plotsIndex.items || []
    const exactPlot = plots.find(item => normalizeRoleName(item.name) === norm || (item.alias || []).includes(norm))
    const storyIndex = await loadStoryIndex()
    const roles = storyIndex.roles || []
    const exactRole = roles.find(item => normalizeRoleName(item.name) === norm || (item.alias || []).includes(norm))
    const voiceIndex = await loadVoiceIndex()
    const voiceRoles = voiceIndex.roles || []
    const exactVoice = voiceRoles.find(item => normalizeRoleName(item.name) === norm || (item.alias || []).includes(norm))
    const relicIndex = await loadRelicIndex()
    const relics = relicIndex.sets || []
    const exactRelic = relics.find(item => normalizeRoleName(item.name) === norm || (item.alias || []).includes(norm))
    const weaponIndex = await loadWeaponIndex()
    const weapons = weaponIndex.weapons || []
    const exactWeapon = weapons.find(item => normalizeRoleName(item.name) === norm || (item.alias || []).includes(norm))

    if (exact) {
      const full = path.join(booksRoot, exact.file)
      if (!fss.existsSync(full)) return this.reply(`书籍文件不存在：${exact.title}`)
      const content = await fs.readFile(full, 'utf8')
      return this.replyContent(exact.title, content, wantImage)
    }

    if (exactPlot) {
      const file = resolvePlotFile(exactPlot)
      if (!file || !fss.existsSync(file)) return this.reply(`未找到剧情文本：${exactPlot.name}`)
      const item = JSON.parse(await fs.readFile(file, 'utf8'))
      const text = renderPlotText(item, 'full')
      return this.replyContent(item.name, text, wantImage)
    }

    if (exactRole) {
      const file = path.join(storyRoot, `${slugify(exactRole.name)}.json`)
      if (!fss.existsSync(file)) return this.reply(`未找到角色故事：${exactRole.name}`)
      const role = JSON.parse(await fs.readFile(file, 'utf8'))
      const text = renderRoleStoryText(role, 'story')
      return this.replyContent(`${role.name}故事`, text, wantImage)
    }

    if (exactVoice) {
      const file = path.join(voiceRoot, `${slugify(exactVoice.name)}.json`)
      if (!fss.existsSync(file)) return this.reply(`未找到角色语音：${exactVoice.name}`)
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

    if (exactRelic) {
      const file = path.join(relicRoot, `${slugify(exactRelic.name)}.json`)
      if (!fss.existsSync(file)) return this.reply(`未找到圣遗物：${exactRelic.name}`)
      const set = JSON.parse(await fs.readFile(file, 'utf8'))
      const text = renderRelicText(set)
      return this.replyContent(`${set.name}圣遗物`, text, wantImage)
    }

    if (exactWeapon) {
      const file = path.join(weaponRoot, `${slugify(exactWeapon.name)}.json`)
      if (!fss.existsSync(file)) return this.reply(`未找到武器：${exactWeapon.name}`)
      const weapon = JSON.parse(await fs.readFile(file, 'utf8'))
      const text = renderWeaponText(weapon)
      return this.replyContent(`${weapon.name}武器故事`, text, wantImage)
    }

    const fuzzy = books.find(b => b.title.includes(title) || title.includes(b.title))
    const fuzzyPlot = plots.find(item => {
      const name = normalizeRoleName(item.name)
      return name.includes(norm) || norm.includes(name)
    })
    const fuzzyRole = roles.find(item => {
      const name = normalizeRoleName(item.name)
      return name.includes(norm) || norm.includes(name)
    })
    const fuzzyVoice = voiceRoles.find(item => {
      const name = normalizeRoleName(item.name)
      return name.includes(norm) || norm.includes(name)
    })
    const fuzzyRelic = relics.find(item => {
      const name = normalizeRoleName(item.name)
      return name.includes(norm) || norm.includes(name)
    })
    const fuzzyWeapon = weapons.find(item => {
      const name = normalizeRoleName(item.name)
      return name.includes(norm) || norm.includes(name)
    })

    if (fuzzy) {
      const full = path.join(booksRoot, fuzzy.file)
      if (!fss.existsSync(full)) return this.reply(`书籍文件不存在：${fuzzy.title}`)
      const content = await fs.readFile(full, 'utf8')
      return this.replyContent(fuzzy.title, content, wantImage)
    }

    if (fuzzyPlot) {
      const file = resolvePlotFile(fuzzyPlot)
      if (!file || !fss.existsSync(file)) return this.reply(`未找到剧情文本：${fuzzyPlot.name}`)
      const item = JSON.parse(await fs.readFile(file, 'utf8'))
      const text = renderPlotText(item, 'full')
      return this.replyContent(item.name, text, wantImage)
    }

    if (fuzzyRole) {
      const file = path.join(storyRoot, `${slugify(fuzzyRole.name)}.json`)
      if (!fss.existsSync(file)) return this.reply(`未找到角色故事：${fuzzyRole.name}`)
      const role = JSON.parse(await fs.readFile(file, 'utf8'))
      const text = renderRoleStoryText(role, 'story')
      return this.replyContent(`${role.name}故事`, text, wantImage)
    }

    if (fuzzyVoice) {
      const file = path.join(voiceRoot, `${slugify(fuzzyVoice.name)}.json`)
      if (!fss.existsSync(file)) return this.reply(`未找到角色语音：${fuzzyVoice.name}`)
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

    if (fuzzyRelic) {
      const file = path.join(relicRoot, `${slugify(fuzzyRelic.name)}.json`)
      if (!fss.existsSync(file)) return this.reply(`未找到圣遗物：${fuzzyRelic.name}`)
      const set = JSON.parse(await fs.readFile(file, 'utf8'))
      const text = renderRelicText(set)
      return this.replyContent(`${set.name}圣遗物`, text, wantImage)
    }

    if (fuzzyWeapon) {
      const file = path.join(weaponRoot, `${slugify(fuzzyWeapon.name)}.json`)
      if (!fss.existsSync(file)) return this.reply(`未找到武器：${fuzzyWeapon.name}`)
      const weapon = JSON.parse(await fs.readFile(file, 'utf8'))
      const text = renderWeaponText(weapon)
      return this.replyContent(`${weapon.name}武器故事`, text, wantImage)
    }

    return false
  }
}

export default BookDex
