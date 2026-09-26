/**
 * 手动上下文编辑器 — 浏览器端插件。
 *
 * 在会话头部动作区放一个入口按钮，打开一个面板：
 *   1. 手动上下文：列出/manual-context 文件夹里的条目，可新建、编辑、删除、刷新
 *   2. 对话历史：列出当前模型可见的全部消息（系统提示词/用户输入/模型输出/工具输出），
 *      可就地编辑并通过宿主写回会话历史
 *
 * 与宿主通过同源 HTTP /manual-context 通信。
 */
window.__ModuleLoader__.load({
  id: '@dsh-external/manual-context',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    'use strict'

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const PATH = '/manual-context'
    const STYLE_ID = '@dsh-external/manual-context'
    const ENTRY_POINT = 'conversation.session.header.actions'
    // 侧边栏底部动作区：会话头部那个入口在没有会话时不渲染，这里始终可见
    const SIDEBAR_POINT = 'sidebar.footer.action'

    const styles = [
      '.mc-anchor{display:inline-flex;align-items:center;gap:6px}',
      '.mc-trigger{display:inline-flex;align-items:center;gap:6px;height:28px;max-width:100%;box-sizing:border-box;overflow:hidden;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1;cursor:pointer}',
      '.mc-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.mc-overlay{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.42);padding:24px}',
      '.mc-panel{display:flex;flex-direction:column;width:min(1080px,100%);height:min(760px,100%);min-height:0;overflow:hidden;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 24px 64px rgba(0,0,0,.32)}',
      '.mc-head{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.mc-title{font-size:15px;font-weight:600}',
      '.mc-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mc-spacer{flex:1}',
      '.mc-x{width:28px;height:28px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:16px;cursor:pointer}',
      '.mc-x:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.mc-tabs{display:flex;gap:4px;padding:10px 18px 0}',
      '.mc-tab{padding:7px 14px;border:0;border-radius:8px 8px 0 0;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:13px;cursor:pointer}',
      '.mc-tab[data-on="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.mc-body{flex:1;display:flex;min-height:0;gap:0}',
      '.mc-col{display:flex;flex-direction:column;min-height:0;min-width:0}',
      '.mc-list{width:280px;flex:none;border-right:1px solid var(--dsw-alias-border-l1);overflow-y:auto;padding:10px}',
      '.mc-item{display:block;width:100%;text-align:left;padding:9px 10px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mc-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.mc-item[data-on="true"]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}',
      '.mc-badge{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:999px;font-size:11px;background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary)}',
      '.mc-badge[data-pending="delete"]{background:var(--dsw-alias-state-error-tertiary);color:var(--dsw-alias-state-error-primary)}',
      '.mc-badge[data-pending="add"]{background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-state-success-primary)}',
      '.mc-item[data-pending="add"]{border-style:dashed}',
      '.mc-item.mc-pending{overflow:visible;cursor:default}',
      '.mc-pending-text{margin-top:4px;padding:8px 10px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto}',
      '.mc-pending-ta{width:100%;box-sizing:border-box;min-height:120px;margin-top:4px;resize:vertical;padding:8px 10px;border:1px solid var(--dsw-alias-state-business-primary);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:1.6;font-family:inherit}',
      '.mc-main{flex:1;display:flex;flex-direction:column;min-height:0;min-width:0;padding:12px 16px;gap:10px}',
      '.mc-ta{flex:1;min-height:0;width:100%;box-sizing:border-box;resize:none;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;line-height:1.6}',
      '.mc-ta:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      '.mc-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.mc-btn{height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12.5px;cursor:pointer}',
      '.mc-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.mc-btn[data-primary="true"]{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:#fff}',
      '.mc-btn:disabled{opacity:.5;cursor:not-allowed}',
      // 条目级注入开关：一眼看出这个 .md 参不参与注入
      '.mc-toggle{flex:none;height:22px;padding:0 8px;font-size:12px;border-radius:999px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary)}',
      '.mc-toggle[data-on="true"]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}',
      '.mc-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.mc-kind{padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600}',
      '.mc-kind[data-k="system"]{background:#6b7280;color:#fff}',
      '.mc-kind[data-k="user"]{background:#2563eb;color:#fff}',
      '.mc-kind[data-k="assistant"]{background:#059669;color:#fff}',
      '.mc-kind[data-k="tool"]{background:#b45309;color:#fff}',
      '.mc-meta{color:var(--dsw-alias-label-tertiary)}',
      '.mc-note{padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6}',
      '.mc-err{color:var(--dsw-alias-state-error-primary);font-size:12.5px;padding:4px 0}',
      '.mc-empty{padding:28px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px}',
      '.mc-headline{padding:12px 18px 0;color:var(--dsw-alias-label-tertiary);font-size:12px;word-break:break-all}',
      '.mc-select{height:30px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;cursor:pointer}',
      '.mc-input{flex:1;min-width:120px;height:30px;box-sizing:border-box;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12.5px}',
      '.mc-input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      '.mc-check{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-tertiary);font-size:12px;cursor:pointer}',
      '.mc-compose{display:flex;flex-direction:column;gap:8px}',
      '.mc-compose-body{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}',
      // ---- 历史页：双栏布局 + 放大字号（覆盖上面的密集列表样式） ----
      '.mc-panel{width:min(1440px,96vw);height:min(920px,94vh)}',
      '.mc-head{padding:16px 20px}',
      '.mc-title{font-size:16px}',
      '.mc-tabs{padding:12px 20px 0}',
      '.mc-tab{font-size:13.5px;padding:8px 16px}',
      '.mc-list{width:300px;padding:12px;gap:6px;display:flex;flex-direction:column}',
      '.mc-hlist{width:360px}',
      '.mc-item{font-size:13.5px;padding:10px 12px}',
      '.mc-hitem{display:flex;flex-direction:column;align-items:stretch;gap:6px;white-space:normal;overflow:visible}',
      '.mc-hpreview{color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:1.55;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}',
      '.mc-kind{font-size:11.5px;padding:3px 9px}',
      '.mc-meta{font-size:12.5px}',
      '.mc-main{padding:16px 20px;gap:12px}',
      '.mc-btn{height:32px;padding:0 14px;font-size:13px}',
      '.mc-select{height:32px;font-size:12.5px;padding:0 8px}',
      '.mc-input{height:32px;font-size:13px}',
      '.mc-ta{font-size:13.5px;line-height:1.75;padding:14px}',
      '.mc-fulltext{flex:1;min-height:0;overflow:auto;margin:0;padding:16px 18px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-2);white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13.5px;line-height:1.8;color:var(--dsw-alias-label-secondary)}',
      '.mc-toolrow{margin:0;padding:10px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:1.6;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}',
      '.mc-note{font-size:12.5px;line-height:1.65}',
      '.mc-empty{font-size:13.5px}',
      '.mc-sub{font-size:12.5px}',
      '.mc-x-sm{width:22px;height:22px;font-size:12px;line-height:1;flex:none}',
      '.mc-item-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.mc-reason{margin:0;padding:10px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}',
      '.mc-reason-head{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-bottom:6px}',
      '.mc-reason-body{margin:0;max-height:180px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;line-height:1.7;color:var(--dsw-alias-label-tertiary)}',
      '.mc-reason-ta{flex:none;min-height:96px;max-height:200px}',
      '.mc-list{overflow:hidden}',
      '.mc-head-fixed{flex:none;display:flex;flex-direction:column;gap:6px}',
      '.mc-head-fixed > *{flex:none}',
      '.mc-scroll{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding-right:2px}',
      '.mc-ta-code{white-space:pre;overflow-wrap:normal;overflow-x:auto;font-size:13px;line-height:1.6}',
      // ---- 历史列表：可拖动排序的消息卡片 + 可独立操作的片段行 ----
      '.mc-drag{flex:none;cursor:grab;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1;user-select:none;letter-spacing:-1px}',
      '.mc-drag:active{cursor:grabbing}',
      '.mc-hitem[data-drag="true"]{opacity:.4}',
      '.mc-hitem[data-over="true"]{border-color:var(--dsw-alias-state-business-primary)}',
      '.mc-hitem[data-over="true"]::before{content:"";display:block;height:2px;margin:-2px 0 6px;border-radius:2px;background:var(--dsw-alias-state-business-primary)}',
      '.mc-parts{display:flex;flex-direction:column;gap:4px;margin-top:4px;cursor:default}',
      '.mc-part{display:flex;align-items:flex-start;gap:6px;padding:5px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}',
      '.mc-part:hover{border-color:var(--dsw-alias-border-l2)}',
      '.mc-part[data-on="true"]{border-color:var(--dsw-alias-state-business-primary)}',
      '.mc-part-kind{flex:none;padding:1px 6px;border-radius:999px;font-size:10.5px;font-weight:600;line-height:1.7;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary)}',
      '.mc-part-kind[data-k="reasoning"]{background:#7c3aed;color:#fff}',
      '.mc-part-kind[data-k="tool-call"]{background:#0ea5e9;color:#fff}',
      '.mc-part-kind[data-k="tool-result"]{background:#b45309;color:#fff}',
      '.mc-part-kind[data-k="assistant"]{background:#059669;color:#fff}',
      '.mc-part-kind[data-k="user"]{background:#2563eb;color:#fff}',
      '.mc-part-kind[data-k="system"]{background:#6b7280;color:#fff}',
      '.mc-part-text{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.55;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}',
      '.mc-part-acts{flex:none;display:flex;gap:2px}',
      '.mc-parts .mc-part{cursor:grab}',
      '.mc-parts .mc-part:active{cursor:grabbing}',
      '.mc-part[data-drag="true"]{opacity:.4}',
      '.mc-part[data-over="true"]{border-color:var(--dsw-alias-state-business-primary)}',
      '.mc-hint{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:1.5}',
      // ---- 右栏不裁切：内容超出时整栏可滚动，文本框保留最小高度 ----
      '.mc-main{overflow-y:auto;overflow-x:hidden}',
      '.mc-ta{min-height:180px}',
      '.mc-select{max-width:100%;text-overflow:ellipsis}',
    ].join('\n')

    function installStyles() {
      if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return function () {}
      const tag = document.createElement('style')
      tag.dataset.plugin = '@dsh-external/manual-context'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = styles
      document.head.appendChild(tag)
      return function () { tag.remove() }
    }

    /** 排队提示：空闲时的写操作要等下一轮请求才能落盘，这里给一次性说明。 */
    let queuedNoticeTimer = null
    function showQueuedNotice(message) {
      try {
        let bar = document.querySelector('[data-mc-queued-notice]')
        if (bar === null) {
          bar = document.createElement('div')
          bar.dataset.mcQueuedNotice = '1'
          bar.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;max-width:320px;'
            + 'padding:10px 12px;border-radius:8px;background:rgba(32,32,36,.94);color:#fff;font-size:12px;'
            + 'line-height:1.5;box-shadow:0 6px 20px rgba(0,0,0,.35)'
          document.body.appendChild(bar)
        }
        bar.textContent = message
        if (queuedNoticeTimer !== null) clearTimeout(queuedNoticeTimer)
        queuedNoticeTimer = setTimeout(function () {
          bar.remove()
          queuedNoticeTimer = null
        }, 6000)
      } catch {
        // 提示失败不影响主流程
      }
    }

    /** 解析 JSON 响应；空响应或非 JSON 都换成可读的错误说明。 */
    async function readJson(response) {
      const text = await response.text()
      if (text.trim() === '') {
        if (response.status === 404) {
          throw new Error('宿主插件未挂载 /manual-context 路由（HTTP 404）。请重启 dsh web 后刷新页面。')
        }
        throw new Error('服务端返回了空响应（HTTP ' + String(response.status) + '）')
      }
      let value
      try {
        value = JSON.parse(text)
      } catch {
        throw new Error('服务端返回了非 JSON 响应（HTTP ' + String(response.status) + '）')
      }
      if (value && value.ok === false) throw new Error(value.error || '请求失败')
      // 空闲时的写入会被宿主排队，等下一轮请求组装时应用 —— 这不是错误，但要说清。
      if (value && value.queued === true) showQueuedNotice(value.message || '改动已排队，将在下一次请求组装时自动应用。')
      return value
    }

    async function api(op, params, payload) {
      // 过滤掉 null / undefined：侧边栏入口在挑到会话之前没有 sessionId
      const clean = {}
      for (const key of Object.keys(params || {})) {
        const value = params[key]
        if (value !== undefined && value !== null && value !== '') clean[key] = value
      }
      const query = new URLSearchParams(Object.assign({ op: op }, clean))
      const init = payload === undefined
        ? { headers: { accept: 'application/json' }, cache: 'no-store' }
        : {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          cache: 'no-store',
          body: JSON.stringify(Object.assign({ op: op }, payload)),
        }
      let response
      try {
        response = await fetch(PATH + (payload === undefined ? '?' + query.toString() : ''), init)
      } catch (caught) {
        throw new Error('无法访问宿主接口：' + String(caught && caught.message ? caught.message : caught))
      }
      return readJson(response)
    }

    const ROLE_CHOICES = [
      ['user', '用户输入'],
      ['assistant', '模型输出'],
      ['reasoning', '思维链'],
      ['tool-call', '工具调用'],
      ['tool-result', '工具返回'],
    ]


    /** 角色下拉的 option 列表。 */
    function roleOptions() {
      return ROLE_CHOICES.map(function (pair) {
        return h('option', { key: pair[0], value: pair[0] }, pair[1])
      })
    }

    function Editor(props) {
      const propsSessionId = props.sessionId
      const [open, setOpen] = useState(false)
      const [tab, setTab] = useState('context')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [status, setStatus] = useState(null)
      const [entries, setEntries] = useState([])
      const [activeId, setActiveId] = useState(null)
      const [draft, setDraft] = useState('')
      const [dirty, setDirty] = useState(false)
      const [history, setHistory] = useState(null)
      const [editing, setEditing] = useState(null)
      const [selectedSeq, setSelectedSeq] = useState(null)
      const [editDraft, setEditDraft] = useState('')
      const [newName, setNewName] = useState('')
      const [newRoot, setNewRoot] = useState(0)
      const [role, setRole] = useState('user')
      const [showCompose, setShowCompose] = useState(false)
      const [composeKind, setComposeKind] = useState('user')
      const [composeText, setComposeText] = useState('')
      const [composeToolName, setComposeToolName] = useState('')
      const [composeToolInput, setComposeToolInput] = useState('')
      const [composeIsError, setComposeIsError] = useState(false)
      const [newRole, setNewRole] = useState('user')
      const [editMode, setEditMode] = useState('text')
      const [multiSelect, setMultiSelect] = useState(false)
      const [selectedSeqs, setSelectedSeqs] = useState([])
      const [entryMulti, setEntryMulti] = useState(false)
      const [selectedIds, setSelectedIds] = useState([])
      const [entryMode, setEntryMode] = useState('text')
      const [entryMeta, setEntryMeta] = useState({})
      const [entryBody, setEntryBody] = useState('')
      const [reasoningDraft, setReasoningDraft] = useState('')
      const [editingPart, setEditingPart] = useState(null)
      const [focusPart, setFocusPart] = useState(null)
      const [dragSeq, setDragSeq] = useState(null)
      const [dragOverSeq, setDragOverSeq] = useState(null)
      // 侧边栏入口拿不到 slot 的 sessionId，所以它也可以是 state：打开面板时自己挑一个
      const [sessionId, setSessionId] = useState(propsSessionId === undefined ? null : propsSessionId)
      const [sessionOptions, setSessionOptions] = useState([])
      // 追加在最后：测试与外部按声明顺序引用下标，插在中间会让既有下标错位
      // 条目的启用开关与注入权重（weight <= 0 放系统提示词下方，> 0 放对话末尾）
      const [entryEnabled, setEntryEnabled] = useState(true)
      const [entryWeight, setEntryWeight] = useState(0)
      const [dragEntryId, setDragEntryId] = useState(null)
      const [dragOverEntry, setDragOverEntry] = useState(null)
      // 片段级编辑（像「对话历史」那样逐段处理）：文件 → 片段 → 片段正文
      const [entryView, setEntryView] = useState('segment')
      const [segList, setSegList] = useState([])
      const [segIndex, setSegIndex] = useState(0)
      const [segText, setSegText] = useState('')
      const [segRole, setSegRole] = useState('user')
      const [segDirty, setSegDirty] = useState(false)
      const [dragSegIndex, setDragSegIndex] = useState(null)
      const [dragOverSegIndex, setDragOverSegIndex] = useState(null)
      // 新增状态一律追加在最后：渲染测试（tests/client.test.mjs）按 useState 的调用序号
      // 覆盖初值，插在中间会让后面所有状态错位。
      const [pendingEdit, setPendingEdit] = useState(null)
      const [pendingDraft, setPendingDraft] = useState('')
      const [pendingReasoning, setPendingReasoning] = useState('')
      const [pendingToolName, setPendingToolName] = useState('')
      const [pendingToolInput, setPendingToolInput] = useState('')
      const [composeReasoning, setComposeReasoning] = useState('')
      const mounted = useRef(true)

      /** 片段生效的角色：段标记 > 文件 frontmatter > user。 */
      const segmentRoleOf = function (segment, fallback) {
        const meta = segment !== null && typeof segment === 'object' && segment.meta !== null && typeof segment.meta === 'object' ? segment.meta : {}
        const own = typeof meta.role === 'string' ? meta.role.trim() : ''
        if (own !== '') return own
        if (typeof fallback === 'string' && fallback !== '') return fallback
        return typeof role === 'string' && role !== '' ? role : 'user'
      }

      useEffect(function () {
        mounted.current = true
        return function () { mounted.current = false }
      }, [])

      const loadContext = useCallback(async function () {
        setBusy(true); setError(null)
        try {
          const value = await api('status', { sessionId: sessionId })
          if (!mounted.current) return
          setStatus(value)
          setEntries(value.entries || [])
          setActiveId(function (current) {
            if (current !== null && (value.entries || []).some(function (e) { return e.id === current })) return current
            const first = (value.entries || [])[0]
            return first ? first.id : null
          })
        } catch (caught) {
          if (mounted.current) setError(String(caught && caught.message ? caught.message : caught))
        } finally {
          if (mounted.current) setBusy(false)
        }
      }, [sessionId])

      /** 静默刷新：只拿「排队中 / 现在能不能写」这类实时信息，不碰编辑区、不闪 busy。 */
      const refreshStatus = useCallback(async function () {
        try {
          const value = await api('status', { sessionId: sessionId })
          if (mounted.current) setStatus(value)
        } catch {
          // 轮询失败静默忽略：下一次成功时自愈
        }
      }, [sessionId])

      // 面板停在手动上下文页时轮询，让「已排队 N 项」实时反映出来。
      useEffect(function () {
        if (!open || tab !== 'context') return undefined
        const timer = setInterval(function () { void refreshStatus() }, 2500)
        return function () { clearInterval(timer) }
      }, [open, tab, refreshStatus])

      // 打开面板时若发现「已启用的条目没有注入进来」，自动补一次。
      //
      // 注入原本只在两个时机自动跑：点「同步到会话」，或发新消息时（agent/pre-step 钩子）。
      // 单纯打开一个旧对话不会触发 —— 而注入内容版本升级后，会话里存的旧节点不再被认作
      // 「已注入」，于是打开对话看起来就像「手动上下文消失了」。这里自动补上，让面板与会话
      // 重新一致；同一个会话只自动补一次，之后交给手动同步与 pre-step 钩子。
      const autoSyncedRef = useRef(null)
      useEffect(function () {
        if (!open || tab !== 'context') return
        if (status === null || sessionId === null || sessionId === '') return
        if (autoSyncedRef.current === sessionId) return
        const rows = Array.isArray(status.injected) ? status.injected : []
        const entries = Array.isArray(status.entries) ? status.entries : []
        const missing = entries.filter(function (entry) {
          if (entry === null || typeof entry !== 'object' || entry.enabled === false) return false
          const hit = rows.find(function (row) { return row !== null && typeof row === 'object' && row.id === entry.id })
          return hit === undefined || hit.inContext !== true
        })
        if (missing.length === 0) return
        autoSyncedRef.current = sessionId
        void syncContext()
      }, [open, tab, status, sessionId])

      const loadFile = useCallback(async function (id) {
        if (id === null || id === undefined) {
          setDraft(''); setSegList([]); setSegIndex(0); setSegText(''); setSegDirty(false)
          return
        }
        try {
          const value = await api('file', { sessionId: sessionId, id: id })
          if (!mounted.current) return
          setDraft(value.entry ? value.entry.content : '')
          setRole(value.entry && value.entry.role ? value.entry.role : 'user')
          setEntryMeta(value.entry && value.entry.meta ? value.entry.meta : {})
          setEntryBody(value.entry && typeof value.entry.body === 'string' ? value.entry.body : '')
          setEntryEnabled(!(value.entry && value.entry.enabled === false))
          setEntryWeight(value.entry && Number.isFinite(value.entry.weight) ? value.entry.weight : 0)
          setDirty(false)
          // 片段视图：把文件正文按段标记拆开，选中第一段
          const fileRole = value.entry && value.entry.role ? value.entry.role : 'user'
          const segments = Array.isArray(value.entry && value.entry.segments) ? value.entry.segments : []
          setSegList(segments)
          setSegIndex(0)
          setSegText(segments.length > 0 && typeof segments[0].text === 'string' ? segments[0].text : '')
          setSegRole(segments.length > 0 ? segmentRoleOf(segments[0], fileRole) : fileRole)
          setSegDirty(false)
        } catch (caught) {
          if (mounted.current) setError(String(caught && caught.message ? caught.message : caught))
        }
      }, [sessionId])

      const loadHistory = useCallback(async function () {
        setBusy(true); setError(null)
        try {
          const value = await api('history', { sessionId: sessionId })
          if (mounted.current) {
            setHistory(value)
            setSelectedSeq(function (current) {
              const list = value.messages || []
              // 已经选中过就保持不动：保存/删除/刷新后不要跳回第一条（系统提示词）
              if (current !== null) return current
              return list.length > 0 ? list[0].seq : null
            })
          }
        } catch (caught) {
          if (mounted.current) setError(String(caught && caught.message ? caught.message : caught))
        } finally {
          if (mounted.current) setBusy(false)
        }
      }, [sessionId])

      useEffect(function () {
        if (!open) return
        if (tab === 'context') { void loadContext(); void loadFile(activeId) }
        else void loadHistory()
      }, [open, tab, sessionId])

      useEffect(function () {
        if (open && tab === 'context') void loadFile(activeId)
      }, [activeId])

      /** 侧边栏入口没有 sessionId：拉一份宿主里的会话列表，挑一个正在跑的。 */
      const pickSession = useCallback(async function () {
        try {
          const value = await api('sessions', undefined)
          if (!mounted.current) return
          const list = value.sessions || []
          setSessionOptions(list)
          const pick = list.find(function (item) { return item.status === 'running' }) || list[0]
          if (pick !== undefined) setSessionId(pick.id)
          else setError('宿主里还没有可用会话，先在左侧新建一个会话')
        } catch (caught) {
          if (mounted.current) setError(String(caught && caught.message ? caught.message : caught))
        }
      }, [])

      const openPanel = function () {
        setOpen(true); setError(null); setTab('context')
        if (sessionId === null || sessionId === '') void pickSession()
      }

      // 侧边栏折叠成 56px 轨道时只留图标，避免文字被裁
      const triggerLabel = typeof props.wide === 'boolean' && props.wide === false ? '✎' : '✎ 上下文编辑'
      const closePanel = function () { if (!busy) setOpen(false) }

      const saveFile = async function () {
        if (activeId === null) return
        setBusy(true); setError(null)
        try {
          if (entryMode === 'json') {
            let parsed
            try {
              parsed = JSON.parse(draft)
            } catch (caught) {
              throw new Error('JSON 解析失败：' + String(caught && caught.message ? caught.message : caught))
            }
            if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
              throw new Error('JSON 顶层必须是一个对象')
            }
            await api('save-file', undefined, {
              sessionId: sessionId,
              id: activeId,
              meta: {
                role: parsed.role,
                tool: parsed.tool,
                args: parsed.args,
                callId: parsed.callId,
                isError: parsed.isError,
                enabled: parsed.enabled === undefined ? entryEnabled : parsed.enabled,
                weight: parsed.weight === undefined ? entryWeight : parsed.weight,
              },
              body: typeof parsed.body === 'string' ? parsed.body : '',
            })
          } else {
            await api('save-file', undefined, { sessionId: sessionId, id: activeId, content: draft })
          }
          setDirty(false)
          await loadContext()
          await loadFile(activeId)
        } catch (caught) { setError(String(caught && caught.message ? caught.message : caught)) }
        finally { setBusy(false) }
      }

      /** 只改某条目的 frontmatter 设置（启用开关 / 权重），正文原样保留。 */
      const patchEntry = async function (id, patch, bodyText) {
        const file = await api('file', { sessionId: sessionId, id: id })
        const parsed = splitEntry(file.entry ? file.entry.content : '')
        const meta = Object.assign({}, parsed.meta, patch)
        await api('save-file', undefined, {
          sessionId: sessionId,
          id: id,
          meta: meta,
          body: typeof bodyText === 'string' ? bodyText : parsed.body,
        })
        await loadContext()
        if (id === activeId) await loadFile(id)
      }

      /** 启用 / 停用某个条目：停用后同步时它的节点会被遮蔽掉。 */
      const toggleEntryEnabled = async function (id, next) {
        setBusy(true); setError(null)
        try {
          await patchEntry(id, { enabled: next ? '' : 'false' })
        } catch (caught) { setError(String(caught && caught.message ? caught.message : caught)) }
        finally { setBusy(false) }
      }

      /** 批量启用 / 停用所选条目（停用的条目在同步时会被移除）。 */
      const setEntriesEnabled = async function (next) {
        if (selectedIds.length === 0) return
        const ids = [...selectedIds]
        setBusy(true); setError(null)
        try {
          for (const id of ids) await patchEntry(id, { enabled: next ? '' : 'false' })
          showQueuedNotice('已' + (next ? '启用' : '停用') + ' ' + String(ids.length) + ' 个条目，点「同步到会话」应用。')
          await loadContext()
        } catch (caught) { setError(String(caught && caught.message ? caught.message : caught)) }
        finally { setBusy(false) }
      }

      /** 直接编辑注入权重（<=0 系统提示词下方，>0 对话末尾且越大越靠前）。 */
      const saveEntryWeight = async function (id, weight) {
        const num = Number(weight)
        if (!Number.isFinite(num)) { setError('权重必须是数字'); return }
        setBusy(true); setError(null)
        try {
          await patchEntry(id, { weight: String(num) })
        } catch (caught) { setError(String(caught && caught.message ? caught.message : caught)) }
        finally { setBusy(false) }
      }

      /** 权重数值（缺省 0）。 */
      const entryWeightOf = function (item) {
        return item !== null && item !== undefined && Number.isFinite(item.weight) ? item.weight : 0
      }

      /** 列表显示顺序：先「系统提示词下方」组，再「对话末尾」组，组内权重降序。 */
      const orderedEntries = function () {
        const list = entries.slice()
        list.sort(function (a, b) {
          const az = entryWeightOf(a) <= 0 ? 0 : 1
          const bz = entryWeightOf(b) <= 0 ? 0 : 1
          if (az !== bz) return az - bz
          if (entryWeightOf(b) !== entryWeightOf(a)) return entryWeightOf(b) - entryWeightOf(a)
          return a.name < b.name ? -1 : 1
        })
        return list
      }

      /**
       * 拖动调整位置：按新顺序重写权重。
       * 上区（系统提示词下方）按 0,-1,-2… 赋值；下区（对话末尾）按 m…1 赋值，
       * 于是「权重越大越靠前」与列表顺序始终一致。
       */
      const moveEntry = async function (fromId, toId, zone) {
        if (fromId === null || fromId === undefined || fromId === toId) return
        const list = orderedEntries().map(function (item) {
          return { id: item.id, zone: entryWeightOf(item) <= 0 ? 'head' : 'tail' }
        })
        const fromAt = list.findIndex(function (item) { return item.id === fromId })
        if (fromAt < 0) return
        const moved = { id: fromId, zone: zone === 'tail' ? 'tail' : (zone === 'head' ? 'head' : list[fromAt].zone) }
        const rest = list.filter(function (_, index) { return index !== fromAt })
        let insertAt = toId === null || toId === undefined ? -1 : rest.findIndex(function (item) { return item.id === toId })
        if (insertAt < 0) {
          if (moved.zone === 'head') {
            const firstTail = rest.findIndex(function (item) { return item.zone === 'tail' })
            insertAt = firstTail < 0 ? rest.length : firstTail
          } else insertAt = rest.length
        }
        rest.splice(insertAt, 0, moved)
        setBusy(true); setError(null)
        try {
          const head = rest.filter(function (item) { return item.zone === 'head' })
          const tail = rest.filter(function (item) { return item.zone === 'tail' })
          for (let i = 0; i < head.length; i += 1) {
            const current = entries.find(function (item) { return item.id === head[i].id })
            if (current === undefined || entryWeightOf(current) === -i) continue
            await patchEntry(head[i].id, { weight: String(-i) })
          }
          for (let i = 0; i < tail.length; i += 1) {
            const current = entries.find(function (item) { return item.id === tail[i].id })
            const wanted = tail.length - i
            if (current === undefined || entryWeightOf(current) === wanted) continue
            await patchEntry(tail[i].id, { weight: String(wanted) })
          }
          await loadContext()
        } catch (caught) { setError(String(caught && caught.message ? caught.message : caught)) }
        finally { setBusy(false) }
      }

      /** 立即把当前条目同步进会话；旧格式会话里写不进去的部分会排队，下一轮请求自动应用。 */
      const syncContext = async function () {
        if (sessionId === null || sessionId === '') return
        setBusy(true); setError(null)
        try {
          const value = await api('sync-context', undefined, { sessionId: sessionId })
          const added = Number.isFinite(value.added) ? value.added : 0
          const removed = Number.isFinite(value.removed) ? value.removed : 0
          const deferred = Number.isFinite(value.deferred) ? value.deferred : 0
          const total = Number.isFinite(value.total) ? value.total : 0
          const idle = value !== null && typeof value === 'object' && value.idle === true
          if (idle) {
            // 空闲时写入会把节点排在系统提示词前面，会话下次就打不开了 —— 一律排队。
            showQueuedNotice(deferred > 0
              ? '会话当前空闲：改动已排队，下一次对话开始时自动注入（空闲直接写会让对话打不开）。'
              : '会话当前空闲，没有需要改动的节点。')
          } else if (deferred > 0) {
            showQueuedNotice('已注入 ' + String(added) + ' 段，还有 ' + String(deferred)
              + ' 段在排队：这段会话是 v4 之前的旧格式，下一次对话开始时自动补上。')
          } else {
            showQueuedNotice('已注入 ' + String(added) + ' 段（共 ' + String(total) + ' 段）'
              + (removed > 0 ? '，清理 ' + String(removed) + ' 个旧节点' : '') + '。')
          }
          await loadContext()
        } catch (caught) { setError(String(caught && caught.message ? caught.message : caught)) }
        finally { setBusy(false) }
      }

      /** 切换注入总开关；关掉时后端会把已经注入的节点一并遮蔽掉。 */
      const toggleInject = async function () {
        const next = !(status !== null && status.inject === true)
        setBusy(true); setError(null)
        try {
          const value = await api('set-inject', undefined, { sessionId: sessionId, enabled: next })
          const sync = value !== null && typeof value === 'object' && value.sync !== null && typeof value.sync === 'object' ? value.sync : null
          const removed = sync !== null && Number.isFinite(sync.removed) ? sync.removed : 0
          const pending = sync !== null && Number.isFinite(sync.deferred) && sync.deferred > 0
          showQueuedNotice(next
            ? '注入已开启：点「同步到会话」把当前条目写进上下文。'
            : '注入已关闭' + (removed > 0 ? '，已移除 ' + String(removed) + ' 个注入节点' : '')
              + (pending ? '；旧格式会话要等下一次对话开始时清理。' : '。'))
          await loadContext()
        } catch (caught) { setError(String(caught && caught.message ? caught.message : caught)) }
        finally { setBusy(false) }
      }

      /**
       * 修复会话日志（「对话点开一片空白」的根因）。
       *
       * onlySession 非空时只处理那一个对话 —— 会话日志是逐个损坏的，没必要每次都把
       * 全部会话扫一遍；不传才是全量扫描。
       */
      const repairSessionsRun = async function (onlySession) {
        setBusy(true); setError(null)
        try {
          const target = onlySession === null || onlySession === '' ? undefined : onlySession
          const value = await api('repair-sessions', target, { apply: true, sessionId: target })
          if (value === null || typeof value !== 'object' || value.ok === false) {
            throw new Error(String(value !== null && typeof value === 'object' && value.error ? value.error : '修复失败'))
          }
          const scanned = Number.isFinite(value.scanned) ? value.scanned : 0
          const broken = Number.isFinite(value.broken) ? value.broken : 0
          const repaired = Number.isFinite(value.repaired) ? value.repaired : 0
          const skipped = Number.isFinite(value.skippedRunning) ? value.skippedRunning : 0
          const rows = Array.isArray(value.sessions) ? value.sessions : []
          const stuck = rows.filter(function (row) { return row !== null && typeof row === 'object' && typeof row.reason === 'string' })
          if (broken === 0) {
            showQueuedNotice(target === undefined
              ? '扫描 ' + String(scanned) + ' 个对话，全都打得开，没有要修的。'
              : '这个对话的日志没问题，不用修。')
          } else if (stuck.length === 0) {
            showQueuedNotice('修好 ' + String(repaired) + ' 个对话'
              + (skipped > 0 ? '（跳过 ' + String(skipped) + ' 个正在运行的）' : '')
              + '。原文件已备份为 *.corrupt-bak，重启 dsh 后就能打开。')
          } else {
            showQueuedNotice('修好 ' + String(repaired) + ' 个，还有 ' + String(stuck.length)
              + ' 个需要另一种修法：' + String(stuck[0].reason ?? '').slice(0, 70))
          }
          await loadContext()
        } catch (caught) { setError(String(caught && caught.message ? caught.message : caught)) }
        finally { setBusy(false) }
      }
      /** 只修当前选中的对话。 */
      const repairCurrent = function () { void repairSessionsRun(sessionId) }
      /** 扫描全部对话并修复。 */
      const repairAll = function () { void repairSessionsRun(null) }

      /** 导出当前会话（含手动上下文节点）为 JSON 文件。 */
      const exportSessionFile = async function () {
        if (sessionId === null || sessionId === '') return
        setBusy(true); setError(null)
        try {
          const value = await api('export-session', { sessionId: sessionId })
          const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const link = document.createElement('a')
          link.href = url
          link.download = 'session-' + String(sessionId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24) + '.json'
          document.body.appendChild(link)
          link.click()
          link.remove()
          setTimeout(function () { URL.revokeObjectURL(url) }, 2000)
        } catch (caught) { setError(String(caught && caught.message ? caught.message : caught)) }
        finally { setBusy(false) }
      }

      /** 解析导入文件：既接受导出文件本身，也接受裸的 messages 数组。 */
      const messagesOfImport = function (text) {
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch (caught) {
          throw new Error('JSON 解析失败：' + String(caught && caught.message ? caught.message : caught))
        }
        if (Array.isArray(parsed)) return parsed
        if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.messages)) return parsed.messages
        throw new Error('导入文件里没有 messages 数组')
      }

      /** 选择 JSON 文件并导入到当前会话末尾（按 message.id 去重）。 */
      const pickImportFile = function () {
        if (sessionId === null || sessionId === '') return
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = '.json,application/json'
        input.onchange = async function () {
          const file = input.files && input.files[0]
          if (file === undefined || file === null) return
          setBusy(true); setError(null)
          try {
            const messages = messagesOfImport(await file.text())
            await api('import-session', undefined, { sessionId: sessionId, messages: messages })
            await loadHistory()
          } catch (caught) { setError(String(caught && caught.message ? caught.message : caught)) }
          finally { setBusy(false) }
        }
        input.click()
      }

      const createFile = async function () {
        const name = newName.trim()
        if (name === '') return
        setBusy(true); setError(null)
        try {
          const value = await api('create-file', undefined, { sessionId: sessionId, name: name, content: '# ' + name + '\n\n', root: newRoot, role: newRole })
          setNewName('')
          await loadContext()
          if (value.entry) setActiveId(value.entry.id)
        } catch (caught) { setError(String(caught && caught.message ? caught.message : caught)) }
        finally { setBusy(false) }
      }

      const removeFile = async function () {
        if (activeId === null) return
        setBusy(true); setError(null)
        try {
          await api('delete-file', undefined, { sessionId: sessionId, id: activeId })
          setActiveId(null); setDraft(''); setDirty(false)
          await loadContext()
        } catch (caught) { setError(String(caught && caught.message ? caught.message : caught)) }
        finally { setBusy(false) }
      }

      const saveEdit = async function (message) {
        setBusy(true); setError(null)
        try {
          // 片段编辑：只改这一个 content 块，其余块原样写回
          if (editingPart !== null) {
            await savePartEdit(message, editingPart)
            setEditing(null); setEditingPart(null); setEditDraft('')
            await loadHistory()
            return
          }
          let payload
          if (editMode === 'json') {
            let blocks
            try {
              blocks = JSON.parse(editDraft)
            } catch (caught) {
              throw new Error('JSON 解析失败：' + String(caught && caught.message ? caught.message : caught))
            }
            if (!Array.isArray(blocks)) throw new Error('JSON 顶层必须是数组（content blocks）')
            payload = { sessionId: sessionId, seq: message.seq, content: blocks }
          } else {
            payload = {
              sessionId: sessionId, seq: message.seq,
              text: editDraft, expectedText: message.text,
              reasoning: reasoningDraft,
            }
          }
          const result = await api('save-edit', undefined, payload)
          setEditing(null); setEditDraft('')
          await loadHistory()
          // 替换会生成一个新节点：把选中项移到它上面，列表位置与选中状态都保持不变
          if (result && Number.isSafeInteger(result.replacedSeq)) setSelectedSeq(result.replacedSeq)
        } catch (caught) { setError(String(caught && caught.message ? caught.message : caught)) }
        finally { setBusy(false) }
      }

      const forgetEdit = async function (seq) {
        setBusy(true); setError(null)
        try {
          await api('forget-edit', undefined, { sessionId: sessionId, seq: seq })
          await loadHistory()
        } catch (caught) { setError(String(caught && caught.message ? caught.message : caught)) }
        finally { setBusy(false) }
      }

      /** 文本 / JSON 编辑形态切换。 */
      const switchEditMode = function (next, message) {
        if (next === editMode) return
        if (next === 'json') setEditDraft(JSON.stringify(message.blocks || [], null, 2))
        else setEditDraft(message.text)
        setEditMode(next)
      }

      const toggleSeq = function (seq) {
        setSelectedSeqs(function (list) {
          return list.indexOf(seq) >= 0 ? list.filter(function (item) { return item !== seq }) : list.concat([seq])
        })
      }

      const toggleId = function (id) {
        setSelectedIds(function (list) {
          return list.indexOf(id) >= 0 ? list.filter(function (item) { return item !== id }) : list.concat([id])
        })
      }

      /**
       * 改写一条「排着队、还没写进去」的消息正文。
       *
       * 这是「将要添加进对话的内容改不了」的补丁：以前排队中的追加在面板上完全隐形，
       * 只能等它写进去以后才看得见、才改得动。
       */
      const savePendingAdd = async function (queueIndex, text) {
        if (sessionId === null || sessionId === '') return
        setBusy(true); setError(null)
        try {
          await api('edit-pending', undefined, {
            sessionId: sessionId,
            queueIndex: queueIndex,
            text: text,
            reasoning: pendingReasoning,
            toolName: pendingToolName,
            toolInput: pendingToolInput,
          })
          setPendingEdit(null)
          showQueuedNotice('已改写排队中的内容；下一次对话开始时按新内容加进去。')
          await loadHistory()
        } catch (caught) { setError(String(caught && caught.message ? caught.message : caught)) }
        finally { setBusy(false) }
      }

      /** 丢弃一条排队中的改动（还没写进日志，丢掉不留痕迹）。 */
      const dropPendingAdd = async function (queueIndex) {
        if (sessionId === null || sessionId === '') return
        setBusy(true); setError(null)
        try {
          await api('drop-pending', undefined, { sessionId: sessionId, queueIndex: queueIndex })
          setPendingEdit(null)
          showQueuedNotice('已丢弃这条排队中的改动。')
          await loadHistory()
        } catch (caught) { setError(String(caught && caught.message ? caught.message : caught)) }
        finally { setBusy(false) }
      }

      /** 把若干条历史消息从模型可见上下文里移除。 */
      const removeMessages = async function (seqs) {
        if (!seqs || seqs.length === 0) return
        setBusy(true); setError(null)
        try {
          await api('delete-messages', undefined, { sessionId: sessionId, seqs: seqs })
          setSelectedSeqs([]); setEditing(null)
          await loadHistory()
        } catch (caught) { setError(String(caught && caught.message ? caught.message : caught)) }
        finally { setBusy(false) }
      }

      /** 删除若干手动上下文条目。 */
      const removeEntries = async function (ids) {
        if (!ids || ids.length === 0) return
        setBusy(true); setError(null)
        try {
          await api('delete-files', undefined, { sessionId: sessionId, ids: ids })
          setSelectedIds([]); setActiveId(null); setDraft(''); setDirty(false)
          await loadContext()
        } catch (caught) { setError(String(caught && caught.message ? caught.message : caught)) }
        finally { setBusy(false) }
      }

      const appendNew = async function () {
        setBusy(true); setError(null)
        try {
          // 思维链 / 正文 / 工具调用组装成同一条 assistant 消息的多个内容块
          // （相邻的自动合并，和历史里的形状一致）。
          // 只有模型输出与工具调用才可能带思维链 —— 用户输入、工具返回本身就是单块消息。
          const canReason = composeKind === 'assistant' || composeKind === 'tool-call'
          const withReasoning = canReason && composeReasoning.trim() !== ''
          const blocks = []
          if (withReasoning) {
            blocks.push({ type: 'reasoning', text: composeReasoning })
            if (composeText.trim() !== '') blocks.push({ type: 'text', text: composeText })
            if (composeKind === 'tool-call' && composeToolName.trim() !== '') {
              blocks.push({ type: 'tool-call', name: composeToolName, args: composeToolInput })
            }
          }
          const kind = withReasoning ? 'assistant' : composeKind
          await api('append-message', undefined, {
            sessionId: sessionId,
            kind: kind,
            text: composeText,
            blocks: blocks.length > 0 ? blocks : undefined,
            toolName: composeToolName,
            toolInput: composeToolInput,
            isError: composeIsError,
          })
          setComposeText('')
          setComposeReasoning('')
          setComposeToolName('')
          setComposeToolInput('')
          setComposeIsError(false)
          setShowCompose(false)
          setTab('history')
          await loadHistory()
        } catch (caught) { setError(String(caught && caught.message ? caught.message : caught)) }
        finally { setBusy(false) }
      }

      /** 拆出 frontmatter 与正文（与宿主 parseEntry 行为一致）。 */
      const splitEntry = function (text) {
        const source = typeof text === 'string' ? text : ''
        const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source)
        if (match === null) return { meta: {}, body: source }
        const meta = {}
        for (const line of match[1].split(/\r?\n/)) {
          const trimmed = line.trim()
          if (trimmed === '' || trimmed.startsWith('#')) continue
          const sep = trimmed.indexOf(':')
          if (sep <= 0) continue
          meta[trimmed.slice(0, sep).trim().toLowerCase()] = trimmed.slice(sep + 1).trim()
        }
        return { meta, body: source.slice(match[0].length) }
      }

      /** 与宿主 composeEntry 一致：把结构化元数据 + 正文拼回文件内容。 */
      const composeEntryText = function (meta, body) {
        const keys = ['role', 'tool', 'args', 'callId', 'isError', 'enabled', 'weight']
        const lines = []
        for (const key of keys) {
          const value = meta ? meta[key] : undefined
          if (value === undefined || value === null) continue
          if (key === 'role') { if (value !== 'user') lines.push('role: ' + value); continue }
          if (key === 'isError') { if (value === true || value === 'true') lines.push('isError: true'); continue }
          if (key === 'enabled') { if (value !== undefined && value !== null && value !== '' && String(value) !== 'true') lines.push('enabled: false'); continue }
          if (key === 'weight') { const num = Number(value); if (Number.isFinite(num) && num !== 0) lines.push('weight: ' + String(num)); continue }
          const text = String(value)
          if (text !== '') lines.push(key + ': ' + text)
        }
        const text = typeof body === 'string' ? body : ''
        if (lines.length === 0) return text
        return '---\n' + lines.join('\n') + '\n---\n' + text
      }

      /** 在文本 / JSON 两种条目编辑形态之间切换，已输入的正文不会丢。 */
      const switchEntryMode = function (next) {
        if (next === entryMode) return
        if (next === 'json') {
          const parsed = splitEntry(draft)
          setDraft(JSON.stringify({
            role: parsed.meta.role || role,
            tool: parsed.meta.tool || '',
            args: parsed.meta.args || '',
            callId: parsed.meta.callId || '',
            isError: parsed.meta.isError === 'true',
            enabled: parsed.meta.enabled === undefined ? entryEnabled : parsed.meta.enabled,
            weight: parsed.meta.weight === undefined ? entryWeight : parsed.meta.weight,
            body: parsed.body,
          }, null, 2))
        } else {
          let parsed = null
          try { parsed = JSON.parse(draft) } catch (caught) { parsed = null }
          if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            setDraft(composeEntryText(parsed, parsed.body))
          }
        }
        setEntryMode(next)
        setDirty(false)
      }

      /** 文本编辑框的 ref —— 用来读取光标位置，以便插入段标记。 */
      const draftRef = useRef(null)

      /** 在光标处插入一段角色标记（解析交给宿主）。 */
      const insertSegment = function (nextRole) {
        const marker = '<!-- role: ' + nextRole + ' -->'
        const area = draftRef.current
        if (area === null || area === undefined) {
          const base = draft === '' || draft.endsWith('\n') ? draft : draft + '\n'
          setDraft(base + marker + '\n')
          setDirty(true)
          return
        }
        const start = area.selectionStart
        const end = area.selectionEnd
        const before = draft.slice(0, start)
        const after = draft.slice(end)
        const prefix = before === '' || before.endsWith('\n') ? '' : '\n'
        const inserted = prefix + marker + '\n'
        setDraft(before + inserted + after)
        setDirty(true)
        const position = before.length + inserted.length
        try {
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(function () {
              area.focus()
              area.setSelectionRange(position, position)
            })
          }
        } catch {
          // 忽略：插入本身已经完成
        }
      }

      /** 片段在下拉里的显示文本：编号 + 角色 + 工具名 + 前 40 字预览。 */
      const segmentOptionLabel = function (segment, index) {
        const meta = segment !== null && typeof segment === 'object' && segment.meta !== null && typeof segment.meta === 'object' ? segment.meta : {}
        const kind = segmentRoleOf(segment)
        const pair = ROLE_CHOICES.find(function (item) { return item[0] === kind })
        const parts = ['#' + String(index + 1), pair === undefined ? kind : pair[1]]
        if (typeof meta.tool === 'string' && meta.tool !== '') parts.push(meta.tool)
        const preview = (typeof segment.text === 'string' ? segment.text : '').replace(/\s+/g, ' ').trim().slice(0, 26)
        return parts.join(' · ') + (preview === '' ? '（空片段）' : ' — ' + preview)
      }

      /** 就地切换当前片段（不写盘）。 */
      const applySegment = function (list, at) {
        const index = Math.max(0, Math.min(list.length - 1, at))
        const segment = list[index]
        setSegList(list)
        setSegIndex(index)
        setSegText(segment !== undefined && typeof segment.text === 'string' ? segment.text : '')
        setSegRole(segment !== undefined ? segmentRoleOf(segment) : 'user')
      }

      /** 下拉切换片段。 */
      const selectSegment = function (index) {
        if (!Number.isFinite(index)) return
        applySegment(segList, index)
        setSegDirty(false)
      }

      /** 把整份片段数组交给宿主重组正文并写盘（解析/重组规则只存在于 store.js）。 */
      const commitSegments = async function (nextList, nextIndex) {
        if (activeId === null) return
        setBusy(true); setError(null)
        try {
          await api('save-segments', undefined, { sessionId: sessionId, id: activeId, segments: nextList })
          await loadContext()
          await loadFile(activeId)
          applySegment(nextList, nextIndex)
          setSegDirty(false)
        } catch (caught) { setError(String(caught && caught.message ? caught.message : caught)) }
        finally { setBusy(false) }
      }

      /** 保存当前片段的正文与角色。 */
      const saveSegment = async function () {
        if (activeId === null || segList.length === 0) return
        const next = segList.map(function (segment, index) {
          if (index !== segIndex) return segment
          const meta = Object.assign({}, segment.meta)
          meta.role = segRole
          return { meta: meta, text: segText }
        })
        await commitSegments(next, segIndex)
      }

      /** 删除当前片段（至少保留一段）。 */
      const deleteSegment = async function () {
        if (segList.length <= 1) return
        const next = segList.filter(function (_, index) { return index !== segIndex })
        await commitSegments(next, segIndex - 1)
      }

      /** 与相邻片段交换位置。 */
      const moveSegment = async function (delta) {
        const to = segIndex + delta
        if (to < 0 || to >= segList.length) return
        const next = segList.slice()
        const moved = next[segIndex]
        next[segIndex] = next[to]
        next[to] = moved
        await commitSegments(next, to)
      }

      /** 在当前片段下方插入一个空片段（带上角色标记，写盘后才不会跟上一段黏在一起）。 */
      const addSegment = async function () {
        const at = segList.length === 0 ? 0 : segIndex + 1
        const next = segList.slice()
        next.splice(at, 0, { meta: { role: segRole }, text: '' })
        await commitSegments(next, at)
      }

      /**
       * 下标所在的「可合并组」大小：连续的思维链 / 模型输出 / 工具调用算一组，
       * 它们会合并成同一条 assistant 消息（user 与 tool-result 是分界线）。
       */
      const mergeGroupSizeAt = function (at) {
        if (at < 0 || at >= segList.length) return 0
        const mergeable = function (index) {
          const kind = segmentRoleOf(segList[index])
          return kind === 'reasoning' || kind === 'assistant' || kind === 'tool-call'
        }
        if (!mergeable(at)) return 1
        let start = at
        while (start > 0 && mergeable(start - 1)) start -= 1
        let end = at
        while (end + 1 < segList.length && mergeable(end + 1)) end += 1
        return end - start + 1
      }

      /** 拖动片段调整顺序（写回文件；文件里的顺序就是注入顺序）。 */
      const reorderSegments = async function (fromIndex, toIndex) {
        if (fromIndex === null || fromIndex === undefined) return
        if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return
        if (fromIndex >= segList.length || toIndex >= segList.length) return
        const next = segList.slice()
        const moved = next.splice(fromIndex, 1)[0]
        next.splice(toIndex, 0, moved)
        await commitSegments(next, toIndex)
      }

      /** 片段 / 整篇 两种编辑视图切换。 */
      const switchEntryView = function (next) {
        if (next === entryView) return
        setEntryView(next)
        setSegDirty(false)
      }

      const injectedMap = useMemo(function () {
        const map = {}
        for (const row of (status && status.injected) || []) map[row.id] = row.inContext
        return map
      }, [status])

      const activeEntry = entries.find(function (e) { return e.id === activeId })

      /** 片段视图：两条下拉（文件 / 片段）+ 片段工具条 + 正文。 */
      const fragmentEditor = function () {
        const hasSegments = segList.length > 0
        return h(React.Fragment, null,
          h('div', { className: 'mc-row' },
            h('span', { className: 'mc-sub' }, '文件'),
            h('select', {
              className: 'mc-select', style: { flex: '1', minWidth: '150px' },
              value: activeId === null ? '' : activeId, title: '选择 .md 文件',
              onChange: function (event) { setActiveId(event.target.value) },
            }, orderedEntries().map(function (item) {
              return h('option', { key: item.id, value: item.id, title: item.path },
                (item.enabled === false ? '［停用］' : '') + item.name)
            })),
            h('span', { className: 'mc-sub' }, '片段'),
            h('select', {
              className: 'mc-select', style: { flex: '2', minWidth: '220px' },
              value: String(segIndex), title: '选择该文件里的上下文片段', disabled: !hasSegments || busy,
              onChange: function (event) { selectSegment(Number(event.target.value)) },
            }, hasSegments
              ? segList.map(function (segment, index) {
                return h('option', { key: String(index), value: String(index) }, segmentOptionLabel(segment, index))
              })
              : h('option', { value: '0' }, '（这个文件还没有片段）')),
          ),
          hasSegments
            ? h('div', { className: 'mc-parts', title: '这个 .md 里的全部片段：拖动调整顺序；带「合」的会合并成同一条消息' },
              segList.map(function (segment, index) {
                const kind = segmentRoleOf(segment)
                const pair = ROLE_CHOICES.find(function (item) { return item[0] === kind })
                const body = typeof segment.text === 'string' ? segment.text : ''
                const merged = mergeGroupSizeAt(index) > 1
                return h('div', {
                  key: String(index),
                  className: 'mc-part',
                  'data-on': String(index === segIndex),
                  'data-drag': String(dragSegIndex === index),
                  'data-over': String(dragOverSegIndex === index),
                  draggable: true,
                  title: merged
                    ? '拖动调整片段顺序；这一段会和相邻的思维链 / 模型输出 / 工具调用合并成同一条 assistant 消息'
                    : '拖动调整片段顺序',
                  onClick: function () { selectSegment(index) },
                  onDragStart: function (event) {
                    setDragSegIndex(index)
                    if (event.dataTransfer !== undefined && event.dataTransfer !== null) {
                      event.dataTransfer.effectAllowed = 'move'
                      try { event.dataTransfer.setData('text/plain', String(index)) } catch { /* 忽略 */ }
                    }
                  },
                  onDragOver: function (event) { event.preventDefault(); setDragOverSegIndex(index) },
                  onDragLeave: function () { setDragOverSegIndex(null) },
                  onDragEnd: function () { setDragSegIndex(null); setDragOverSegIndex(null) },
                  onDrop: function (event) {
                    event.preventDefault()
                    const from = dragSegIndex
                    setDragSegIndex(null); setDragOverSegIndex(null)
                    void reorderSegments(from, index)
                  },
                },
                  h('span', { className: 'mc-drag', title: '拖动调整片段顺序' }, '⠿'),
                  h('span', { className: 'mc-part-kind', 'data-k': kind }, pair === undefined ? kind : pair[1]),
                  merged
                    ? h('span', {
                      className: 'mc-part-kind',
                      style: { background: 'var(--dsw-alias-state-business-primary)', color: '#fff' },
                      title: '与相邻的思维链 / 模型输出 / 工具调用合并成同一条 assistant 消息',
                    }, '合')
                    : null,
                  h('span', { className: 'mc-part-text' }, body.trim() === '' ? '（空片段）' : body),
                )
              }),
            )
            : null,
          h('div', { className: 'mc-row' },
            h('span', { className: 'mc-sub' }, '该片段注入为'),
            h('select', {
              className: 'mc-select', value: segRole, title: '这段内容以什么角色进入上下文',
              onChange: function (event) { setSegRole(event.target.value); setSegDirty(true) },
            }, roleOptions()),
            h('button', { className: 'mc-btn', onClick: function () { void moveSegment(-1) }, disabled: busy || segIndex <= 0, title: '与上一段交换位置' }, '上移'),
            h('button', { className: 'mc-btn', onClick: function () { void moveSegment(1) }, disabled: busy || segIndex >= segList.length - 1, title: '与下一段交换位置' }, '下移'),
            h('button', { className: 'mc-btn', onClick: function () { void addSegment() }, disabled: busy, title: '在当前片段下方插入一个空片段' }, '＋ 新增片段'),
            h('button', { className: 'mc-btn', onClick: function () { void deleteSegment() }, disabled: busy || segList.length <= 1, title: '删除当前片段' }, '删除片段'),
            h('span', { className: 'mc-spacer' }),
            h('span', { className: 'mc-meta' }, '第 ' + String(segIndex + 1) + ' / ' + String(Math.max(1, segList.length)) + ' 段'),
          ),
          h('textarea', {
            className: 'mc-ta', value: segText, spellCheck: false,
            placeholder: '这一段的内容 —— 注入进上下文时就是这些文字',
            onChange: function (event) { setSegText(event.target.value); setSegDirty(true) },
          }),
          h('div', { className: 'mc-note' },
            '一个 .md 文件可以拆成多个片段：拖动片段行（或点「上移 / 下移」）调整顺序，「＋ 新增片段」分段，每段各自选注入角色。',
            h('br', null),
            '连续的「思维链 / 模型输出 / 工具调用」会自动合并成同一条 assistant 消息 —— 片段行上带「合」标记的就是它们，相当于同一条回复里的 reasoning 块、正文块与 tool-call 块；',
            '用户输入与工具返回是分界线，始终各自独立成消息。',
            h('br', null),
            '片段之间靠 <!-- role: xxx --> 这类标记行分隔；正文里的标记行就是分界点，写进正文即可再拆一段。',
          ),
        )
      }

      /** 整篇视图：直接改文件原文（文本 / JSON），以及插入段标记。 */
      const rawEditor = function () {
        return h(React.Fragment, null,
          h('div', { className: 'mc-row' },
            h('span', { className: 'mc-sub' }, '编辑方式'),
            h('button', {
              className: 'mc-btn', 'data-primary': String(entryMode === 'text'),
              onClick: function () { switchEntryMode('text') },
              title: '编辑整个文件（含 frontmatter）',
            }, '文本'),
            h('button', {
              className: 'mc-btn', 'data-primary': String(entryMode === 'json'),
              onClick: function () { switchEntryMode('json') },
              title: '按结构化字段编辑 role / tool / args / callId / isError / body',
            }, 'JSON'),
          ),
          entryMode === 'text'
            ? h('div', { className: 'mc-row' },
              h('span', { className: 'mc-sub' }, '插入段标记'),
              ROLE_CHOICES.map(function (pair) {
                return h('button', {
                  key: pair[0], className: 'mc-btn',
                  onClick: function () { insertSegment(pair[0]) },
                  title: '在光标处插入 ' + pair[1] + ' 段标记',
                }, pair[1])
              }),
              h('span', { className: 'mc-meta' }, '同一个文件里可以混排多种角色'),
            )
            : null,
          h('textarea', {
            className: 'mc-ta', ref: draftRef, value: draft, spellCheck: false,
            onChange: function (event) { setDraft(event.target.value); setDirty(true) },
          }),
        )
      }

      const contextTab = h('div', { className: 'mc-body' },
        h('div', { className: 'mc-list' },
          h('div', { className: 'mc-head-fixed' },
          h('div', { className: 'mc-row', style: { marginBottom: '8px' } },
            h('button', { className: 'mc-btn', onClick: function () { void loadContext(); void loadFile(activeId) }, disabled: busy }, '刷新'),
            h('button', {
              className: 'mc-btn', title: '把条目立即同步进会话；写不进去的部分会自动排队，下一次对话开始时应用',
              onClick: function () { void syncContext() }, disabled: busy || sessionId === null,
            }, '同步到会话'),
            h('button', {
              className: 'mc-btn', 'data-primary': String(status !== null && status.inject === true),
              title: '注入总开关：关掉之后不再把手动上下文注入会话，并移除已经注入的节点',
              onClick: function () { void toggleInject() }, disabled: busy || sessionId === null,
            }, status !== null && status.inject === true ? '注入：开' : '注入：关'),
            h('button', {
              className: 'mc-btn',
              title: '只修复当前选中的这个对话 —— 修「对话打不开、点开一片空白」',
              onClick: repairCurrent, disabled: busy || sessionId === null,
            }, '修复此对话'),
            h('button', {
              className: 'mc-btn',
              title: '扫描全部对话并修复打不开的那些（会话多时比较慢）',
              onClick: repairAll, disabled: busy,
            }, '修复全部'),
            h('button', {
              className: 'mc-btn', 'data-primary': String(entryMulti),
              onClick: function () { setEntryMulti(!entryMulti); setSelectedIds([]) },
            }, entryMulti ? '退出多选' : '多选'),
          ),
          (status !== null && Number.isFinite(status.queued) && status.queued > 0)
            ? h('div', { className: 'mc-note' },
              '⏳ 排队中：' + String(status.queued) + ' 项改动等下一次对话开始时自动应用'
              + (status.canWrite === true ? '（当前会话已可立即写入，点「同步到会话」即可应用）' : ''))
            : null,
          entryMulti
            ? h('div', { className: 'mc-row', style: { marginBottom: '6px' } },
              h('span', { className: 'mc-sub' }, '已选 ' + String(selectedIds.length) + ' 项'),
              h('span', { className: 'mc-spacer' }),
              h('button', {
                className: 'mc-btn', title: '所选条目恢复注入',
                onClick: function () { void setEntriesEnabled(true) },
                disabled: busy || selectedIds.length === 0,
              }, '启用选中'),
              h('button', {
                className: 'mc-btn', title: '所选条目不再注入（同步时它们的节点会被移除）',
                onClick: function () { void setEntriesEnabled(false) },
                disabled: busy || selectedIds.length === 0,
              }, '停用选中'),
              h('button', {
                className: 'mc-btn', onClick: function () { void removeEntries(selectedIds) },
                disabled: busy || selectedIds.length === 0,
              }, '删除选中'),
            )
            : null,
          h('div', { className: 'mc-row', style: { marginBottom: '6px' } },
            h('select', {
              className: 'mc-select', style: { flex: '1' }, value: String(newRoot), title: '写到哪个目录',
              onChange: function (event) { setNewRoot(Number(event.target.value)) },
            }, ((status && status.roots) || []).map(function (root) {
              return h('option', { key: String(root.index), value: String(root.index), title: root.path }, root.label)
            })),
            h('select', {
              className: 'mc-select', value: newRole, title: '注入到上下文时模拟的消息类型',
              onChange: function (event) { setNewRole(event.target.value) },
            }, roleOptions()),
          ),
          h('div', { className: 'mc-row', style: { marginBottom: '10px' } },
            h('input', {
              className: 'mc-input', placeholder: '新建条目名，如 项目约定', value: newName,
              onChange: function (event) { setNewName(event.target.value) },
              onKeyDown: function (event) { if (event.key === 'Enter') void createFile() },
            }),
            h('button', { className: 'mc-btn', onClick: createFile, disabled: busy || newName.trim() === '' }, '新建'),
          ),
          ),
          h('div', { className: 'mc-scroll' },
          entries.length === 0
            ? h('div', { className: 'mc-empty' }, '文件夹为空')
            : (function () {
              // 两个分区：系统提示词下方（权重<=0）与对话末尾（权重>0），组内权重降序
              const ordered = orderedEntries()
              const headList = ordered.filter(function (item) { return entryWeightOf(item) <= 0 })
              const tailList = ordered.filter(function (item) { return entryWeightOf(item) > 0 })
              const rowOf = function (entry, zone) {
                return h('div', {
                  key: entry.id,
                  className: 'mc-item',
                  'data-on': String(entry.id === activeId),
                  'data-drag': String(dragEntryId === entry.id),
                  'data-over': String(dragOverEntry === entry.id),
                  draggable: true,
                  onClick: function () { setActiveId(entry.id) },
                  title: entry.path,
                  onDragStart: function (event) {
                    setDragEntryId(entry.id)
                    if (event.dataTransfer !== undefined && event.dataTransfer !== null) {
                      event.dataTransfer.effectAllowed = 'move'
                      try { event.dataTransfer.setData('text/plain', entry.id) } catch { /* 忽略 */ }
                    }
                  },
                  onDragOver: function (event) { event.preventDefault(); setDragOverEntry(entry.id) },
                  onDragLeave: function () { setDragOverEntry(null) },
                  onDragEnd: function () { setDragEntryId(null); setDragOverEntry(null) },
                  onDrop: function (event) {
                    event.preventDefault()
                    const from = dragEntryId
                    setDragEntryId(null); setDragOverEntry(null)
                    void moveEntry(from, entry.id, zone)
                  },
                },
                  h('span', { className: 'mc-row', style: { gap: '6px' } },
                    h('span', { className: 'mc-drag', title: '拖动调整注入位置' }, '⠿'),
                    entryMulti
                      ? h('input', {
                        type: 'checkbox', checked: selectedIds.indexOf(entry.id) >= 0,
                        onClick: function (event) { event.stopPropagation() },
                        onChange: function () { toggleId(entry.id) },
                      })
                      : null,
                    // 单个 .md 的注入开关：停用后同步时它的节点会被移除（文件本身保留）
                    h('button', {
                      className: 'mc-toggle',
                      'data-on': String(entry.enabled !== false),
                      title: entry.enabled !== false
                        ? '正在注入 —— 点一下停用（同步时移除它的节点，文件保留）'
                        : '已停用 —— 点一下恢复注入',
                      onClick: function (event) {
                        event.stopPropagation()
                        void toggleEntryEnabled(entry.id, entry.enabled === false)
                      },
                    }, entry.enabled !== false ? '注入中' : '已停用'),
                    h('span', { className: 'mc-item-name' }, entry.name),
                    h('input', {
                      className: 'mc-input', type: 'number', step: '1',
                      style: { width: '62px', flex: 'none' },
                      value: String(entryWeightOf(entry)),
                      title: '注入权重：<=0 放系统提示词下方；>0 放对话末尾，越大越靠前',
                      onClick: function (event) { event.stopPropagation() },
                      onChange: function (event) {
                        const next = Number(event.target.value)
                        if (!Number.isFinite(next)) return
                        setEntries(function (list) {
                          return list.map(function (item) {
                            return item.id === entry.id ? Object.assign({}, item, { weight: next }) : item
                          })
                        })
                      },
                      onBlur: function (event) { void saveEntryWeight(entry.id, Number(event.target.value)) },
                      onKeyDown: function (event) { if (event.key === 'Enter') event.target.blur() },
                    }),
                    entry.enabled === false
                      ? h('span', { className: 'mc-badge' }, '已停用')
                      : (injectedMap[entry.id] === true ? null : h('span', { className: 'mc-badge' }, '未注入')),
                    h('span', { className: 'mc-spacer' }),
                    h('button', {
                      className: 'mc-x mc-x-sm', title: '删除该条目',
                      onClick: function (event) { event.stopPropagation(); void removeEntries([entry.id]) },
                    }, '✕'),
                  ),
                )
              }
              const zoneRow = function (key, label, zone) {
                return h('div', {
                  key: key,
                  className: 'mc-note',
                  style: { padding: '4px 8px', textAlign: 'center' },
                  'data-over': String(dragOverEntry === key),
                  onDragOver: function (event) { event.preventDefault(); setDragOverEntry(key) },
                  onDragLeave: function () { setDragOverEntry(null) },
                  onDrop: function (event) {
                    event.preventDefault()
                    const from = dragEntryId
                    setDragEntryId(null); setDragOverEntry(null)
                    void moveEntry(from, null, zone)
                  },
                }, label)
              }
              return [
                h('div', { key: 'label-head', className: 'mc-sub', style: { padding: '4px 8px' } }, '系统提示词下方（权重 ≤ 0）'),
                headList.map(function (item) { return rowOf(item, 'head') }),
                zoneRow('zone-head', '拖到这里 → 系统提示词下方', 'head'),
                h('div', { key: 'label-tail', className: 'mc-sub', style: { padding: '4px 8px' } }, '对话末尾（权重 > 0）'),
                tailList.map(function (item) { return rowOf(item, 'tail') }),
                zoneRow('zone-tail', '拖到这里 → 对话末尾', 'tail'),
              ]
            })(),
          ),
        ),
        h('div', { className: 'mc-main' },
          activeEntry === null || activeEntry === undefined
            ? h('div', { className: 'mc-empty' }, '选择或新建一个手动上下文条目')
            : h(React.Fragment, null,
              h('div', { className: 'mc-row' },
                h('strong', null, activeEntry.name),
                h('button', {
                  className: 'mc-btn', 'data-primary': String(entryView === 'segment'),
                  onClick: function () { switchEntryView('segment') },
                  title: '按片段编辑：一个 .md 可拆成多段，逐段选角色、改内容、调顺序',
                }, '片段'),
                h('button', {
                  className: 'mc-btn', 'data-primary': String(entryView === 'raw'),
                  onClick: function () { switchEntryView('raw') },
                  title: '整篇编辑：直接改文件原文（含 frontmatter）',
                }, '整篇'),
                h('span', { className: 'mc-spacer' }),
                entryView === 'segment'
                  ? h('button', {
                    className: 'mc-btn', 'data-primary': String(segDirty),
                    onClick: function () { void saveSegment() }, disabled: busy || !segDirty,
                  }, segDirty ? '保存片段 *' : '已保存')
                  : h('button', { className: 'mc-btn', onClick: saveFile, disabled: busy || !dirty, 'data-primary': String(dirty) }, dirty ? '保存 *' : '已保存'),
                h('button', { className: 'mc-btn', onClick: removeFile, disabled: busy }, '删除'),
              ),
              entryView === 'segment' ? fragmentEditor() : rawEditor(),
            ),
        ),
      )

      /** 徽章按消息本身判断：编辑过的节点事件类型会变，不能只看宿主给的 kind。 */
      const badgeOf = function (message) {
        const blocks = Array.isArray(message.blocks) ? message.blocks : []
        for (const block of blocks) {
          if (block !== null && typeof block === 'object' && block.type === 'tool-result') {
            return { kind: 'tool', label: '工具输出' }
          }
        }
        if (message.role === 'assistant') return { kind: 'assistant', label: '模型输出' }
        if (message.role === 'system') return { kind: 'system', label: '系统提示词' }
        if (message.role === 'user') return { kind: 'user', label: '用户输入' }
        return { kind: message.kind, label: message.label }
      }

      /** 列表里的一行预览（文本与工具调用都体现）。 */
      const previewOf = function (message) {
        const parts = []
        const text = String(message.text || '').replace(/\s+/g, ' ').trim()
        if (text !== '') parts.push(text)
        if (message.toolCalls && message.toolCalls.length > 0) {
          parts.push('工具调用：' + message.toolCalls.map(function (call) { return call.name || 'tool' }).join(', '))
        }
        return parts.length > 0 ? parts.join(' · ') : '（无文本内容）'
      }

      /** 片段预览：工具调用显示 name(args)，工具返回与正文显示内容。 */
      const partPreview = function (part) {
        if (part.kind === 'tool-call') {
          const args = String(part.toolInput || '').replace(/\s+/g, ' ').trim()
          const shown = args.length > 160 ? args.slice(0, 160) + '…' : args
          return (part.toolName || 'tool') + '(' + shown + ')'
        }
        const text = String(part.text || '').replace(/\s+/g, ' ').trim()
        if (text === '') return '（空）'
        return text.length > 200 ? text.slice(0, 200) + '…' : text
      }

      const partOf = function (message, index) {
        return (message.parts || []).find(function (part) { return part.index === index }) || null
      }

      /** 选中一条消息；part 为 null 时看整条。 */
      const selectMessage = function (seq, part) {
        setSelectedSeq(seq)
        setFocusPart(part === undefined ? null : part)
        setEditing(null)
        setEditingPart(null)
        setShowCompose(false)
      }

      /** 编辑整条消息。 */
      const startEditMessage = function (message) {
        setEditing(message.seq)
        setEditingPart(null)
        setEditMode('text')
        setEditDraft(message.text)
        setReasoningDraft(message.reasoning || '')
      }

      /** 编辑单个片段：工具调用走 JSON，其余走纯文本。 */
      const startEditPart = function (message, part) {
        setEditing(message.seq)
        setEditingPart(part.index)
        setFocusPart(part.index)
        if (part.kind === 'tool-call') {
          const block = (message.blocks || [])[part.index]
          setEditMode('json')
          setEditDraft(JSON.stringify(block === undefined ? {} : block, null, 2))
        } else {
          setEditMode('text')
          setEditDraft(part.text === undefined ? '' : part.text)
        }
        setReasoningDraft('')
      }

      /** 把片段的新内容写回所在消息的 content 数组。 */
      const savePartEdit = async function (message, index) {
        const blocks = Array.isArray(message.blocks) ? message.blocks.slice() : []
        const part = partOf(message, index)
        if (part === null) throw new Error('片段已不存在，请刷新')
        const current = blocks[index]
        if (part.kind === 'tool-call') {
          let parsed
          try { parsed = JSON.parse(editDraft) } catch (caught) {
            throw new Error('JSON 解析失败：' + String(caught && caught.message ? caught.message : caught))
          }
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('工具调用必须是一个 JSON 对象')
          blocks[index] = Object.assign({}, current, parsed)
        } else if (part.kind === 'tool-result') {
          blocks[index] = Object.assign({}, current, { content: editDraft === '' ? [] : [{ type: 'text', text: editDraft }] })
        } else {
          blocks[index] = Object.assign({}, current, { text: editDraft })
        }
        return api('save-edit', undefined, { sessionId: sessionId, seq: message.seq, content: blocks })
      }

      /** 只删掉消息里的一个片段，其余块原样保留。 */
      const removePart = async function (message, index) {
        setBusy(true); setError(null)
        try {
          await api('delete-part', undefined, { sessionId: sessionId, seq: message.seq, index: index })
          setEditing(null); setEditingPart(null); setFocusPart(null)
          await loadHistory()
        } catch (caught) { setError(String(caught && caught.message ? caught.message : caught)) }
        finally { setBusy(false) }
      }

      /** 拖动排序：把 fromSeq 放到 toSeq 前面（toSeq 为 null 表示放到最后）。 */
      const moveMessage = async function (fromSeq, toSeq) {
        if (history === null || fromSeq === null) return
        const ids = (history.messages || [])
          .filter(function (item) { return !item.protected })
          .map(function (item) { return item.seq })
        const from = ids.indexOf(fromSeq)
        if (from < 0) return
        const next = ids.slice()
        next.splice(from, 1)
        let at = toSeq === null ? next.length : next.indexOf(toSeq)
        if (at < 0) at = next.length
        next.splice(at, 0, fromSeq)
        if (next.join(',') === ids.join(',')) return
        setBusy(true); setError(null)
        try {
          const result = await api('reorder-messages', undefined, { sessionId: sessionId, order: next })
          const mapped = result && result.replaced ? result.replaced[String(fromSeq)] : undefined
          await loadHistory()
          if (Number.isSafeInteger(mapped)) setSelectedSeq(mapped)
        } catch (caught) { setError(String(caught && caught.message ? caught.message : caught)) }
        finally { setBusy(false) }
      }

      const selected = history === null
        ? null
        : (history.messages || []).find(function (item) { return item.seq === selectedSeq }) || null

      const composePanel = h(React.Fragment, null,
        h('div', { className: 'mc-row' },
          h('strong', null, '新增消息'),
          h('span', { className: 'mc-sub' }, '追加到模型可见上下文末尾，不遮蔽已有历史'),
          h('span', { className: 'mc-spacer' }),
          h('button', { className: 'mc-btn', onClick: function () { setShowCompose(false) } }, '返回列表'),
        ),
        h('div', { className: 'mc-row' },
          h('select', {
            className: 'mc-select', value: composeKind,
            onChange: function (event) { setComposeKind(event.target.value) },
          },
            h('option', { value: 'user' }, '用户输入'),
            h('option', { value: 'assistant' }, '模型输出'),
            h('option', { value: 'tool-call' }, '工具调用'),
            h('option', { value: 'tool-result' }, '工具返回'),
          ),
          composeKind === 'tool-call'
            ? h('input', {
              className: 'mc-input', placeholder: '工具名，如 read_file', value: composeToolName,
              onChange: function (event) { setComposeToolName(event.target.value) },
            })
            : null,
          composeKind === 'tool-result'
            ? h('label', { className: 'mc-check' },
              h('input', {
                type: 'checkbox', checked: composeIsError,
                onChange: function (event) { setComposeIsError(event.target.checked) },
              }), '标记为失败')
            : null,
        ),
        composeKind === 'tool-call'
          ? h('input', {
            className: 'mc-input', placeholder: '工具参数（JSON，可留空）', value: composeToolInput,
            onChange: function (event) { setComposeToolInput(event.target.value) },
          })
          : null,
        // 思维链只有模型输出才有：用户输入、工具返回不该出现这个字段。
        composeKind === 'assistant' || composeKind === 'tool-call'
          ? h(React.Fragment, null,
            h('div', { className: 'mc-reason-head' }, '思维链（reasoning 块，可留空）'),
            h('textarea', {
              className: 'mc-ta mc-reason-ta',
              placeholder: '留空就不产生思维链块',
              value: composeReasoning,
              onChange: function (event) { setComposeReasoning(event.target.value) },
            }),
          )
          : null,
        h('div', { className: 'mc-reason-head' }, '正文'),
        h('textarea', {
          className: 'mc-ta',
          placeholder: composeKind === 'tool-call' ? '工具调用前的说明文字（可留空）' : '要追加的内容',
          value: composeText,
          onChange: function (event) { setComposeText(event.target.value) },
        }),
        h('div', { className: 'mc-row' },
          h('span', { className: 'mc-spacer' }),
          h('button', {
            className: 'mc-btn', 'data-primary': 'true', onClick: appendNew,
            disabled: busy || (composeKind !== 'tool-call' && composeText.trim() === ''),
          }, '追加到上下文'),
        ),
        h('div', { className: 'mc-note' }, '工具调用与工具返回会各自生成一个 callId，成对使用更贴近真实轨迹。'),
      )

      /** 详情页顶部的片段切换条：一条消息里有多个块时用来分别查看。 */
      const partStrip = function (message) {
        const parts = Array.isArray(message.parts) ? message.parts : []
        if (parts.length <= 1) return null
        return h('div', { className: 'mc-row', style: { gap: '6px' } },
          h('span', { className: 'mc-sub' }, '片段'),
          h('button', {
            className: 'mc-btn', 'data-primary': String(focusPart === null),
            onClick: function () { setFocusPart(null) },
          }, '整条'),
          parts.map(function (part) {
            return h('button', {
              key: String(part.index),
              className: 'mc-btn',
              'data-primary': String(focusPart === part.index),
              title: partPreview(part),
              onClick: function () { setFocusPart(part.index) },
            }, part.label + ' ' + String(part.index + 1))
          }),
        )
      }

      /**
       * 「排队中 · 将被添加」区块。
       *
       * 排队还没写进日志的追加，以前在面板上完全看不见，用户既不知道排了什么、
       * 也没法改它 —— 这里把它们如实列出来，手动追加的消息还能就地改写。
       */
      const pendingRows = (function () {
        const adds = history !== null && Array.isArray(history.pendingAdds) ? history.pendingAdds : []
        const deletes = history !== null && Array.isArray(history.messages)
          ? history.messages.filter(function (message) { return message.pendingDelete === true })
          : []
        if (adds.length === 0 && deletes.length === 0) return []
        const rows = []
        if (deletes.length > 0) {
          rows.push(h('div', { className: 'mc-note', key: 'pending-del' },
            '⏳ 排队中：「' + String(deletes.length) + ' 条消息将在下一次对话开始时被删除」'
            + '（' + deletes.map(function (message) { return '#' + String(message.seq) }).join('、') + '）'))
        }
        for (const item of adds) {
          // 一次 sync-context 会展开成好几个段、共用一个 queueIndex，所以「正在编辑哪一条」
          // 不能拿 queueIndex 当身份 —— 否则点一条、全都会变成编辑框。
          const key = String(item.queueIndex) + '|' + String(item.entryId ?? '') + '|' + String(item.text ?? '').slice(0, 16)
          const editing = pendingEdit === key
          const label = item.source === 'manual-context' ? '将被添加 · 手动上下文' : '将被添加'
          const body = String(item.text ?? '')
          const reasoning = String(item.reasoning ?? '')
          const toolName = String(item.toolName ?? '')
          const toolInput = String(item.toolInput ?? '')
          rows.push(h('div', { className: 'mc-item mc-hitem', key: 'pending-add-' + key, 'data-pending': 'add' },
            h('span', { className: 'mc-row', style: { gap: '6px' } },
              h('span', { className: 'mc-badge', 'data-pending': 'add' }, label),
              h('span', { className: 'mc-kind', 'data-k': item.kind }, String(item.kind ?? '')),
              item.entryName !== null && item.entryName !== undefined
                ? h('span', { className: 'mc-meta' }, String(item.entryName))
                : null,
              h('span', { className: 'mc-spacer' }),
              item.editable === true
                ? (editing
                  ? h(React.Fragment, null,
                    h('button', { className: 'mc-btn', 'data-primary': 'true', onClick: function () { void savePendingAdd(item.queueIndex, pendingDraft) }, disabled: busy }, '保存'),
                    h('button', { className: 'mc-btn', onClick: function () { setPendingEdit(null) }, disabled: busy }, '取消'),
                  )
                  : h('button', {
                    className: 'mc-btn', disabled: busy,
                    onClick: function () {
                      setPendingEdit(key)
                      setPendingDraft(body)
                      setPendingReasoning(reasoning)
                      setPendingToolName(toolName)
                      setPendingToolInput(toolInput)
                    },
                  }, '编辑'))
                : h('span', { className: 'mc-meta' }, '内容来自条目文件，去「手动上下文」页改'),
              h('button', {
                className: 'mc-btn', disabled: busy,
                title: item.source === 'manual-context'
                  ? '取消这次手动上下文同步（这次排队的所有待注入段会一起取消）'
                  : '丢掉这条排队中的改动（还没写进日志，丢掉不留痕迹）',
                onClick: function () { void dropPendingAdd(item.queueIndex) },
              }, item.source === 'manual-context' ? '取消同步' : '丢弃'),
            ),
            editing
              ? h(React.Fragment, null,
                // 思维链 / 工具调用只属于模型输出（含工具调用消息）；
                // 用户输入、工具返回是单块消息，没有思维链这回事。
                item.kind === 'assistant' || item.kind === 'tool-call'
                  ? h(React.Fragment, null,
                    h('div', { className: 'mc-reason-head' }, '思维链（reasoning 块，可留空）'),
                    h('textarea', {
                      className: 'mc-pending-ta mc-reason-ta',
                      value: pendingReasoning,
                      disabled: busy,
                      placeholder: '留空就不产生思维链块',
                      onChange: function (event) { setPendingReasoning(event.target.value) },
                    }),
                  )
                  : null,
                h('div', { className: 'mc-reason-head' }, '正文'),
                h('textarea', {
                  className: 'mc-pending-ta',
                  value: pendingDraft,
                  disabled: busy,
                  onChange: function (event) { setPendingDraft(event.target.value) },
                }),
                item.kind === 'assistant' || item.kind === 'tool-call'
                  ? h('div', { className: 'mc-row', style: { gap: '6px' } },
                  h('input', {
                    className: 'mc-input', style: { flex: '1' },
                    placeholder: '工具名（可留空；填了会和思维链、正文合并成同一条模型输出）',
                    value: pendingToolName,
                    disabled: busy,
                    onChange: function (event) { setPendingToolName(event.target.value) },
                  }),
                  h('input', {
                    className: 'mc-input', style: { flex: '1' },
                    placeholder: '工具参数（JSON，可留空）',
                    value: pendingToolInput,
                    disabled: busy,
                    onChange: function (event) { setPendingToolInput(event.target.value) },
                  }),
                )
                  : null,
                h('div', { className: 'mc-note' },
                  item.kind === 'assistant' || item.kind === 'tool-call'
                    ? '思维链 / 正文 / 工具调用会合并进同一条模型输出消息，和历史里的形状一致。'
                    : '用户输入 / 工具返回本身就是单块消息，只有正文。'),
              )
              : h(React.Fragment, null,
                reasoning !== ''
                  ? h('div', { className: 'mc-reason' },
                    h('div', { className: 'mc-reason-head' }, '思维链（reasoning 块）'),
                    h('pre', { className: 'mc-reason-body' }, reasoning))
                  : null,
                h('div', { className: 'mc-pending-text' }, body !== '' ? body : '（空）'),
                toolName !== ''
                  ? h('div', { className: 'mc-note' }, '工具调用：' + toolName + (toolInput !== '' ? ' · ' + toolInput : ''))
                  : null,
              ),
          ))
        }
        return rows
      })()

      const messageDetail = function (message) {
        const parts = Array.isArray(message.parts) ? message.parts : []
        const focus = focusPart === null ? null : partOf(message, focusPart)
        const isEditing = editing === message.seq
        const editingThisPart = isEditing && editingPart !== null ? partOf(message, editingPart) : null
        const isPart = focus !== null
        const detailBadge = isPart ? { kind: focus.kind, label: focus.label } : badgeOf(message)
        return h(React.Fragment, null,
          h('div', { className: 'mc-row' },
            h('span', { className: 'mc-kind', 'data-k': detailBadge.kind }, detailBadge.label),
            h('span', { className: 'mc-meta' }, 'seq ' + String(message.seq) + ' · ' + String(message.role)
              + (isPart ? ' · 片段 ' + String(focus.index + 1) + '/' + String(parts.length) : '')),
            message.protected ? h('span', { className: 'mc-meta' }, '· 系统头，每轮由 Harness 重渲染') : null,
            message.edited ? h('span', { className: 'mc-badge' }, '已编辑') : null,
            message.pendingDelete === true
              ? h('span', { className: 'mc-badge', 'data-pending': 'delete', title: '已排上删除，下一次对话开始时生效' }, '将被删除')
              : null,
            h('span', { className: 'mc-spacer' }),
            isEditing
              ? h(React.Fragment, null,
                h('button', { className: 'mc-btn', 'data-primary': 'true', onClick: function () { void saveEdit(message) }, disabled: busy }, '保存'),
                h('button', { className: 'mc-btn', onClick: function () { setEditing(null); setEditingPart(null) }, disabled: busy }, '取消'),
              )
              : h(React.Fragment, null,
                message.protected
                  ? h('span', { className: 'mc-meta' }, '系统提示词每轮由 Harness 重新渲染，无法改写')
                  : h(React.Fragment, null,
                    isPart
                      ? h('button', { className: 'mc-btn', onClick: function () { startEditPart(message, focus) }, disabled: busy }, '编辑该片段')
                      : h('button', { className: 'mc-btn', onClick: function () { startEditMessage(message) }, disabled: busy }, '编辑整条'),
                    isPart && parts.length > 1
                      ? h('button', { className: 'mc-btn', onClick: function () { void removePart(message, focus.index) }, disabled: busy }, '删除该片段')
                      : null,
                  ),
                message.edited
                  ? h('button', { className: 'mc-btn', onClick: function () { void forgetEdit(message.seq) }, disabled: busy }, '清除标记')
                  : null,
              ),
          ),
          partStrip(message),
          isEditing
            ? h(React.Fragment, null,
              editingPart === null
                ? h('div', { className: 'mc-row' },
                  h('span', { className: 'mc-sub' }, '编辑方式'),
                  h('button', {
                    className: 'mc-btn', 'data-primary': String(editMode === 'text'),
                    onClick: function () { switchEditMode('text', message) },
                  }, '文本'),
                  h('button', {
                    className: 'mc-btn', 'data-primary': String(editMode === 'json'),
                    onClick: function () { switchEditMode('json', message) },
                  }, 'JSON'),
                  h('span', { className: 'mc-meta' }, editMode === 'json'
                    ? '直接编辑 content blocks（JSON 数组）'
                    : '编辑纯文本，工具调用等非文本块自动保留'),
                )
                : h('span', { className: 'mc-sub' }, editingThisPart === null
                  ? '编辑片段'
                  : (editingThisPart.kind === 'tool-call'
                    ? '编辑这个工具调用（JSON：type / id / name / arguments）'
                    : '编辑这个片段，同一条消息里的其他块不受影响')),
              h('textarea', {
                className: editMode === 'json' ? 'mc-ta mc-ta-code' : 'mc-ta',
                value: editDraft, spellCheck: false,
                onChange: function (event) { setEditDraft(event.target.value) },
              }),
              editMode === 'text' && editingPart === null
                ? h(React.Fragment, null,
                  h('span', { className: 'mc-sub' }, '思维链（留空则不写入 reasoning 块）'),
                  h('textarea', {
                    className: 'mc-ta mc-reason-ta', value: reasoningDraft, spellCheck: false,
                    placeholder: '模型的思维链内容',
                    onChange: function (event) { setReasoningDraft(event.target.value) },
                  }),
                )
                : null,
            )
            : h('pre', { className: 'mc-fulltext' }, isPart
              ? (focus.kind === 'tool-call'
                ? (focus.toolName || 'tool') + '\n' + String(focus.toolInput || '')
                : (focus.text === '' ? '（空）' : focus.text))
              : (message.text === '' ? '（无文本内容）' : message.text)),
          !isEditing && !isPart && message.hasReasoning === true
            ? h('div', { className: 'mc-reason' },
              h('div', { className: 'mc-reason-head' }, '思维链（reasoning 块）'),
              h('pre', { className: 'mc-reason-body' }, message.reasoning === '' ? '（空）' : message.reasoning),
            )
            : null,
          h('div', { className: 'mc-note' },
            '保存后以 surface 替换事件写回会话日志（与内置压缩同一机制），模型之后的请求即看到新内容。',
            h('br', null),
            '拖动左侧卡片可以改变模型看到的上下文顺序；一条消息里的思维链 / 正文 / 工具调用 / 工具返回各自独立，可单独编辑或删除。',
            h('br', null),
            '注意：主对话流渲染的是原始事件日志、不受 surface 遮蔽影响，所以那里仍显示改动前的内容 —— 模型看到什么，以本面板为准。',
          ),
        )
      }

      const historyTab = h('div', { className: 'mc-body' },
        h('div', { className: 'mc-list mc-hlist' },
          h('div', { className: 'mc-head-fixed' },
          h('div', { className: 'mc-row' },
            h('button', { className: 'mc-btn', onClick: loadHistory, disabled: busy }, '刷新'),
            h('button', {
              className: 'mc-btn', 'data-primary': String(showCompose),
              onClick: function () { setShowCompose(!showCompose); setSelectedSeq(null); setEditing(null) },
            }, showCompose ? '收起新增' : '＋ 新增'),
            h('button', {
              className: 'mc-btn', 'data-primary': String(multiSelect),
              onClick: function () { setMultiSelect(!multiSelect); setSelectedSeqs([]) },
            }, multiSelect ? '退出多选' : '多选'),
            h('span', { className: 'mc-spacer' }),
            h('button', {
              className: 'mc-btn', title: '把当前对话（含手动上下文）导出成 JSON',
              onClick: function () { void exportSessionFile() }, disabled: busy || sessionId === null,
            }, '导出'),
            h('button', {
              className: 'mc-btn', title: '从 JSON 导入对话，追加到当前会话末尾（按消息 id 去重）',
              onClick: pickImportFile, disabled: busy || sessionId === null,
            }, '导入'),
          ),
          multiSelect
            ? h('div', { className: 'mc-row', style: { paddingTop: '4px' } },
              h('span', { className: 'mc-sub' }, '已选 ' + String(selectedSeqs.length) + ' 条'),
              h('span', { className: 'mc-spacer' }),
              h('button', {
                className: 'mc-btn', onClick: function () { void removeMessages(selectedSeqs) },
                disabled: busy || selectedSeqs.length === 0,
              }, '删除选中'),
            )
            : null,
          h('div', { className: 'mc-sub', style: { padding: '2px 2px 4px' } },
            history === null
              ? ''
              : (String((history.messages || []).length) + ' 条 · 已编辑 ' + String((history.edits || []).length) + ' 条')),
          ),
          h('div', { className: 'mc-scroll' },
          history === null
            ? h('div', { className: 'mc-empty' }, busy ? '读取中…' : '还没有数据')
            : [].concat((history.messages || []).map(function (message) {
              const badge = badgeOf(message)
              const parts = Array.isArray(message.parts) ? message.parts : []
              const draggable = !message.protected
              const showParts = parts.length > 1 || (parts.length === 1 && parts[0].type !== 'text')
              return h('div', {
                key: message.seq,
                className: 'mc-item mc-hitem',
                'data-on': String(message.seq === selectedSeq),
                'data-drag': String(dragSeq === message.seq),
                'data-over': String(dragOverSeq === message.seq && dragSeq !== null && dragSeq !== message.seq),
                draggable: draggable,
                onDragStart: function (event) {
                  if (!draggable) return
                  setDragSeq(message.seq)
                  try {
                    event.dataTransfer.effectAllowed = 'move'
                    event.dataTransfer.setData('text/plain', String(message.seq))
                  } catch (caught) { /* 少数浏览器不给写 dataTransfer */ }
                },
                onDragOver: function (event) {
                  if (!draggable || dragSeq === null) return
                  event.preventDefault()
                  if (dragSeq !== message.seq) setDragOverSeq(message.seq)
                },
                onDragLeave: function () { if (dragOverSeq === message.seq) setDragOverSeq(null) },
                onDrop: function (event) {
                  if (dragSeq === null || !draggable) return
                  event.preventDefault()
                  const fromSeq = dragSeq
                  setDragSeq(null); setDragOverSeq(null)
                  void moveMessage(fromSeq, message.seq)
                },
                onDragEnd: function () { setDragSeq(null); setDragOverSeq(null) },
                onClick: function () { selectMessage(message.seq, null) },
              },
                h('span', { className: 'mc-row', style: { gap: '6px' } },
                  multiSelect
                    ? h('input', {
                      type: 'checkbox', checked: selectedSeqs.indexOf(message.seq) >= 0,
                      onClick: function (event) { event.stopPropagation() },
                      onChange: function () { toggleSeq(message.seq) },
                    })
                    : null,
                  draggable ? h('span', { className: 'mc-drag', title: '拖动这条消息改变模型看到的上下文顺序' }, '⠿') : null,
                  h('span', { className: 'mc-kind', 'data-k': badge.kind }, badge.label),
                  h('span', { className: 'mc-meta' }, '#' + String(message.seq) + (parts.length > 1 ? ' · ' + String(parts.length) + ' 片段' : '')),
                  message.edited ? h('span', { className: 'mc-badge' }, '已编辑') : null,
                  message.pendingDelete === true
                    ? h('span', { className: 'mc-badge', 'data-pending': 'delete', title: '已排上删除，下一次对话开始时生效' }, '将被删除')
                    : null,
                  h('span', { className: 'mc-spacer' }),
                  h('button', {
                    className: 'mc-x mc-x-sm', title: '从模型可见上下文中删除这条消息',
                    onClick: function (event) { event.stopPropagation(); void removeMessages([message.seq]) },
                  }, '✕'),
                ),
                h('span', { className: 'mc-hpreview' }, previewOf(message)),
                showParts
                  ? h('div', { className: 'mc-parts' }, parts.map(function (part) {
                    return h('div', {
                      key: String(part.index),
                      className: 'mc-part',
                      'data-on': String(editing === message.seq && editingPart === part.index),
                      onClick: function (event) { event.stopPropagation(); selectMessage(message.seq, part.index) },
                    },
                      h('span', { className: 'mc-part-kind', 'data-k': part.kind }, part.label),
                      h('span', { className: 'mc-part-text' }, partPreview(part)),
                      h('span', { className: 'mc-part-acts' },
                        h('button', {
                          className: 'mc-x mc-x-sm', title: '编辑这个片段',
                          onClick: function (event) { event.stopPropagation(); startEditPart(message, part) },
                        }, '✎'),
                        parts.length > 1
                          ? h('button', {
                            className: 'mc-x mc-x-sm', title: '只删除这个片段',
                            onClick: function (event) { event.stopPropagation(); void removePart(message, part.index) },
                          }, '✕')
                          : null,
                      ),
                    )
                  }))
                  : null,
              )
            }), pendingRows),
          ),
        ),
        h('div', { className: 'mc-main' },
          showCompose
            ? composePanel
            : selected === null
              ? h('div', { className: 'mc-empty' }, '从左侧选择一条消息查看或编辑')
              : messageDetail(selected),
        ),
      )

      if (!open) {
        return h('div', { className: 'mc-anchor' },
          h('button', { className: 'mc-trigger', onClick: openPanel, title: '手动上下文与历史编辑' }, triggerLabel),
        )
      }

      return h('div', { className: 'mc-anchor' },
        h('button', { className: 'mc-trigger', onClick: openPanel, title: '手动上下文与历史编辑' }, triggerLabel),
        h('div', { className: 'mc-overlay', onClick: closePanel },
          h('div', { className: 'mc-panel', onClick: function (event) { event.stopPropagation() } },
            h('div', { className: 'mc-head' },
              h('div', null,
                h('div', { className: 'mc-title' }, '上下文编辑器'),
                h('div', { className: 'mc-sub' }, status && status.cwd ? ('工作区 ' + status.cwd) : '当前会话'),
              ),
              h('span', { className: 'mc-spacer' }),
              sessionOptions.length > 0
                ? h('select', {
                  className: 'mc-select', title: '选择要编辑的会话',
                  value: sessionId === null ? '' : sessionId,
                  onChange: function (event) {
                    setSessionId(event.target.value)
                    setEditing(null); setEditingPart(null); setSelectedSeq(null); setShowCompose(false)
                  },
                }, sessionOptions.map(function (item) {
                  const where = item.cwd !== null && item.cwd !== undefined ? item.cwd + ' · ' : ''
                  const label = where + item.id.slice(0, 8) + (item.status === 'running' ? '（运行中）' : '')
                  return h('option', { key: item.id, value: item.id }, label)
                }))
                : null,
              h('button', { className: 'mc-x', onClick: closePanel, title: '关闭' }, '✕'),
            ),
            h('div', { className: 'mc-tabs' },
              h('button', { className: 'mc-tab', 'data-on': String(tab === 'context'), onClick: function () { setTab('context') } }, '手动上下文'),
              h('button', { className: 'mc-tab', 'data-on': String(tab === 'history'), onClick: function () { setTab('history') } }, '对话历史'),
            ),
            status && status.dirs && status.dirs.length > 0
              ? h('div', { className: 'mc-headline' }, '目录：' + status.dirs.join('   |   '))
              : null,
            error === null ? null : h('div', { className: 'mc-headline' }, h('span', { className: 'mc-err' }, error)),
            tab === 'context' ? contextTab : historyTab,
          ),
        ),
      )
    }

    exports.inject = ['slots']
    exports.apply = function (ctx) {
      ctx.effect(installStyles, 'manual-context: styles')
      ctx.slots.inject(ENTRY_POINT, function () {
        return ctx.slots.register({
          name: ENTRY_POINT,
          id: 'manual-context-editor',
          order: 90,
        }, Editor)
      })
      ctx.slots.inject(SIDEBAR_POINT, function () {
        return ctx.slots.register({
          name: SIDEBAR_POINT,
          id: 'manual-context-sidebar',
          order: 90,
        }, Editor)
      })
    }
    exports.ManualContextEditor = Editor

    return module.exports
  },
})
