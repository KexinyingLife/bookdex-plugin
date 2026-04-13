import fss from 'node:fs'
import path from 'node:path'
import { slugify, plotRoot, mapRoot, anecdoteRoot, cardRoot, backpackRoot } from '../base.js'

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

function buildBackpackFileName(name = '', id = '') {
  const safeName = slugify(name || `backpack-${id || Date.now()}`) || `backpack-${id || Date.now()}`
  const safeId = String(id || '').replace(/[^\w-]/g, '')
  return safeId ? `${safeName}__${safeId}.json` : `${safeName}.json`
}

function resolveBackpackFile(meta = {}) {
  const candidates = []
  if (meta.file) candidates.push(path.join(backpackRoot, meta.file))
  if (meta.name && meta.id) candidates.push(path.join(backpackRoot, buildBackpackFileName(meta.name, meta.id)))
  if (meta.name) candidates.push(path.join(backpackRoot, `${slugify(meta.name)}.json`))

  for (const full of candidates) {
    if (full && fss.existsSync(full)) return full
  }
  return candidates[0] || ''
}

export {
  buildPlotFileName,
  resolvePlotFile,
  buildMapFileName,
  resolveMapFile,
  buildAnecdoteFileName,
  resolveAnecdoteFile,
  buildCardFileName,
  resolveCardFile,
  buildBackpackFileName,
  resolveBackpackFile
}
