import fs from 'node:fs/promises'
import fss from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = process.cwd()
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const pluginDir = path.resolve(__dirname, '../..')
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

function slugify(name) {
  return name
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
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

async function loadStoryIndex() {
  try { return JSON.parse(await fs.readFile(storyIndexFile, 'utf8')) } catch { return { roles: [] } }
}

async function loadRelicIndex() {
  try { return JSON.parse(await fs.readFile(relicIndexFile, 'utf8')) } catch { return { sets: [] } }
}

async function loadWeaponIndex() {
  try { return JSON.parse(await fs.readFile(weaponIndexFile, 'utf8')) } catch { return { weapons: [] } }
}

async function loadVoiceIndex() {
  try { return JSON.parse(await fs.readFile(voiceIndexFile, 'utf8')) } catch { return { roles: [] } }
}

async function loadPlotIndex() {
  try { return JSON.parse(await fs.readFile(plotIndexFile, 'utf8')) } catch { return { items: [] } }
}

export {
  pluginRoot,
  pluginDir,
  pluginFolder,
  dataRoot,
  booksRoot,
  inboxRoot,
  cacheRoot,
  indexFile,
  sessionCacheFile,
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
  TEXT_PAGE_CHARS,
  TEXT_FORWARD_BATCH_SIZE,
  slugify,
  ensureDirs,
  loadIndex,
  saveIndex,
  clearPluginData,
  loadStoryIndex,
  loadRelicIndex,
  loadWeaponIndex,
  loadVoiceIndex,
  loadPlotIndex
}
