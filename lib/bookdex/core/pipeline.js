import { INTERACTIVE_DIALOGUE_PIPELINE_VERSION, INTERACTIVE_DIALOGUE_PIPELINE_VERSIONS, INTERACTIVE_PARSE_PIPELINE_KEYS } from './constants.js'

function interactiveDialoguePipelineVersion(moduleKey) {
  return Number(INTERACTIVE_DIALOGUE_PIPELINE_VERSIONS[moduleKey] || INTERACTIVE_DIALOGUE_PIPELINE_VERSION)
}

function interactiveDialogueParseOk(state, moduleKey) {
  const fileKey = INTERACTIVE_PARSE_PIPELINE_KEYS[moduleKey]
  if (!fileKey) return true
  return Number(state?.[fileKey] || 0) >= interactiveDialoguePipelineVersion(moduleKey)
}

export { interactiveDialoguePipelineVersion, interactiveDialogueParseOk }
