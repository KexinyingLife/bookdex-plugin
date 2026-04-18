import { INTERACTIVE_DIALOGUE_PIPELINE_VERSION, INTERACTIVE_PARSE_PIPELINE_KEYS } from './constants.js'

function interactiveDialogueParseOk(state, moduleKey) {
  const fileKey = INTERACTIVE_PARSE_PIPELINE_KEYS[moduleKey]
  if (!fileKey) return true
  return Number(state?.[fileKey] || 0) >= INTERACTIVE_DIALOGUE_PIPELINE_VERSION
}

export { interactiveDialogueParseOk }
