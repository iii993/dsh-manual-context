/** 消息不可变化辅助（与 @deepseek-ai/dsh-llm 的 freezeMessage 语义一致，避免插件依赖宿主包解析）。 */

/** 递归冻结一个 JSON 值。 */
export function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key])
    Object.freeze(value)
  }
  return value
}

/** 深拷贝后递归冻结，得到一份不可变快照。 */
export function freezeMessage(message) {
  return deepFreeze(structuredClone(message))
}

/**
 * 取出一个 tool-result 块里的可读文本。
 *
 * 真实结构是 **嵌套** 的（camelCase 且内容在 content 里）：
 *   { type: 'tool-result', toolCallId, content: [{ type: 'text', text }], isError? }
 * 只看顶层 type==='text' 会得到一个空串 —— 这正是工具输出显示不出内容的原因。
 */
export function toolResultText(block) {
  if (block === null || typeof block !== 'object') return ''
  const inner = block.content
  if (typeof inner === 'string') return inner
  if (Array.isArray(inner)) {
    const parts = []
    for (const part of inner) {
      if (part === null || typeof part !== 'object') continue
      if (typeof part.text === 'string') parts.push(part.text)
      else if (part.type === 'image') parts.push('[图片]')
    }
    return parts.join('\n')
  }
  if (typeof block.text === 'string') return block.text
  if (typeof block.output === 'string') return block.output
  if (typeof block.result === 'string') return block.result
  return ''
}

/** 拼接一条消息里所有文本块（思维链块单独用 messageReasoning，工具结果展开嵌套内容）。 */
export function messageText(message) {
  const parts = []
  for (const block of message?.content ?? []) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
      continue
    }
    if (block.type === 'tool-result') {
      const text = toolResultText(block)
      if (text !== '') parts.push(text)
    }
  }
  return parts.join('\n')
}

/** 拼接一条消息里所有思维链（reasoning）块。 */
export function messageReasoning(message) {
  const parts = []
  for (const block of message?.content ?? []) {
    if (block !== null && typeof block === 'object' && block.type === 'reasoning' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n')
}

/** 这条消息是否带有思维链块。 */
export function hasReasoning(message) {
  for (const block of message?.content ?? []) {
    if (block !== null && typeof block === 'object' && block.type === 'reasoning') return true
  }
  return false
}
/** 从消息内容里提取工具调用（名称 + 参数）。 */
export function messageToolCalls(message) {
  const calls = []
  for (const block of message?.content ?? []) {
    if (block === null || typeof block !== 'object') continue
    const type = typeof block.type === 'string' ? block.type : ''
    if (type === 'tool-call' || type === 'tool_call' || type === 'toolCall') {
      calls.push({ id: block.id ?? block.toolCallId ?? '', name: block.name ?? block.toolName ?? '', input: block.input ?? block.arguments ?? null })
    }
  }
  return calls
}
