import { cleanPlotText, htmlToText, sanitizeRichHtml } from './text-volumes.js'

function parseInteractiveDialogueBase(component = {}, rich = false) {
  if ((component.component_id || '') !== 'interactive_dialogue') return ''
  let data = {}
  try { data = JSON.parse(component.data || '{}') } catch { return '' }

  const blocks = []
  const groups = Array.isArray(data.list) && data.list.length ? data.list : [data]

  const dedupeAdjacentRepeatedBlocks = (lines = []) => {
    const out = []
    for (const line of lines) {
      out.push(line)
      for (let size = Math.floor(out.length / 2); size >= 2; size--) {
        const left = out.slice(out.length - size * 2, out.length - size)
        const right = out.slice(out.length - size)
        if (left.every((item, idx) => item === right[idx])) {
          out.splice(out.length - size, size)
          break
        }
      }
    }
    return out
  }

  for (const group of groups) {
    const contents = group?.contents || data.contents || {}
    const childIds = group?.child_ids || data.child_ids || {}
    const fullyEmitted = new Set()
    const recStack = new Set()

    const collectReachable = (id, seen = new Set()) => {
      if (!id || seen.has(id)) return seen
      seen.add(id)
      for (const cid of childIds?.[id] || []) collectReachable(cid, seen)
      return seen
    }

    const findFirstCommonDescendant = (ids = []) => {
      if (ids.length < 2) return ''
      const reachableList = ids.map(id => collectReachable(id, new Set()))
      const common = new Set([...reachableList[0]].filter(id => reachableList.every(set => set.has(id))))
      if (!common.size) return ''

      const visit = (id, seen = new Set()) => {
        if (!id || seen.has(id)) return ''
        if (common.has(id)) return id
        seen.add(id)
        for (const cid of childIds?.[id] || []) {
          const hit = visit(cid, seen)
          if (hit) return hit
        }
        return ''
      }

      for (const id of ids) {
        const hit = visit(id, new Set())
        if (hit) return hit
      }
      return ''
    }

    const emitFrom = (id, skipOption = false, stopIds = new Set()) => {
      if (!id) return []
      if (stopIds.has(id)) return []
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
      const option = rich ? sanitizeRichHtml(node.option || '') : cleanPlotText(htmlToText(node.option || ''))
      const dialogue = rich ? sanitizeRichHtml(node.dialogue || '') : cleanPlotText(htmlToText(node.dialogue || ''))
      const optionText = cleanPlotText(htmlToText(option || ''))
      const dialogueText = cleanPlotText(htmlToText(dialogue || ''))
      const lines = []

      if (childList.length > 1) {
        if (!skipOption && optionText) lines.push(rich ? `<div class="plot-option">【选项】${option}</div>` : `【选项】${option}`)
        if (dialogueText) lines.push(rich ? `<div class="plot-dialogue">${dialogue}</div>` : dialogue)

        const mergeId = findFirstCommonDescendant(childList)
        const branchStopIds = new Set(stopIds)
        if (mergeId) branchStopIds.add(mergeId)

        for (const cid of childList) {
          lines.push(...emitFrom(cid, false, branchStopIds))
        }
        if (mergeId && !stopIds.has(mergeId)) lines.push(...emitFrom(mergeId, false, stopIds))

        recStack.delete(id)
        fullyEmitted.add(id)
        return lines
      }

      if (!skipOption && optionText) lines.push(rich ? `<div class="plot-option">【选项】${option}</div>` : `【选项】${option}`)
      if (dialogueText) lines.push(rich ? `<div class="plot-dialogue">${dialogue}</div>` : dialogue)
      if (childList.length === 1) lines.push(...emitFrom(childList[0], false, stopIds))

      recStack.delete(id)
      fullyEmitted.add(id)
      return lines
    }

    const lines = []
    const rootId = group?.root_id || data.root_id || ''
    if (rootId) {
      lines.push(...emitFrom(rootId, false))
    } else {
      for (const id of Object.keys(contents || {})) {
        if (!fullyEmitted.has(id)) lines.push(...emitFrom(id, false))
      }
    }

    const txt = rich
      ? dedupeAdjacentRepeatedBlocks(lines).join('\n')
      : cleanPlotText(dedupeAdjacentRepeatedBlocks(lines.join('\n').split('\n')).join('\n'))
    if (txt) blocks.push(txt)
  }

  return rich ? blocks.join('\n') : cleanPlotText(blocks.join('\n\n'))
}

function parseInteractiveDialogue(component = {}) {
  return parseInteractiveDialogueBase(component, false)
}

function parseInteractiveDialogueRich(component = {}) {
  return parseInteractiveDialogueBase(component, true)
}

export { parseInteractiveDialogue, parseInteractiveDialogueRich }
