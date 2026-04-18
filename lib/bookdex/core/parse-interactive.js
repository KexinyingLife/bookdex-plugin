import { cleanPlotText, htmlToText } from './text-volumes.js'

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

export { parseInteractiveDialogue }
