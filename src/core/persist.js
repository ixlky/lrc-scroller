// @ts-check
/**
 * 设置持久化 —— 纯逻辑层（只依赖传入的 storage，便于 Node 单测）。
 *
 * 设计要点：
 *  1. **带版本号**：将来改结构可以按版本迁移，而不是让老用户白屏。
 *  2. **逐字段兜底**：读取时用 sanitizeSettings 把任何脏数据替换成默认值。
 *  3. **写入防抖**：拖动滑杆会每秒产生几十次变更，直接写 localStorage 会卡。
 *  4. **失败不抛**：隐私模式/配额满时 localStorage 会抛异常，必须被吞掉并提示。
 */

/** localStorage 键名（含版本，便于将来并存迁移） */
export const STORAGE_KEY = 'lrc-scroller:settings:v1'

/**
 * 包装 localStorage，提供安全读写。
 * @param {Storage|null} storage
 */
export function createSettingsStorage(storage) {
  const available = isStorageAvailable(storage)

  return {
    available,

    /**
     * 读取原始对象。任何异常/损坏都返回 null，由调用方回落默认值。
     * @returns {{ok:true, value:any} | {ok:false, reason:string}}
     */
    read() {
      if (!available) return { ok: false, reason: 'unavailable' }
      try {
        const raw = storage.getItem(STORAGE_KEY)
        if (raw === null) return { ok: false, reason: 'empty' }
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'invalid' }
        return { ok: true, value: parsed }
      } catch {
        // JSON 损坏：明确告知，让 UI 提示用户"设置已恢复默认"
        return { ok: false, reason: 'corrupt' }
      }
    },

    /**
     * 写入。
     * @param {any} value
     * @returns {{ok:boolean, reason?:string}}
     */
    write(value) {
      if (!available) return { ok: false, reason: 'unavailable' }
      try {
        storage.setItem(STORAGE_KEY, JSON.stringify(value))
        return { ok: true }
      } catch (err) {
        // 配额满（QuotaExceededError）或隐私模式
        const name = err instanceof Error ? err.name : ''
        return { ok: false, reason: name === 'QuotaExceededError' ? 'quota' : 'failed' }
      }
    },

    remove() {
      if (!available) return { ok: false, reason: 'unavailable' }
      try {
        storage.removeItem(STORAGE_KEY)
        return { ok: true }
      } catch {
        return { ok: false, reason: 'failed' }
      }
    },
  }
}

/**
 * 探测 storage 是否真的可用。
 * 注意：不能只判断 `!!storage` —— Safari 隐私模式下 localStorage 存在但写入会抛异常，
 * 必须实际写一次再删掉才能确认。
 * @param {Storage|null} storage
 * @returns {boolean}
 */
export function isStorageAvailable(storage) {
  if (!storage) return false
  try {
    const probe = '__lrc_probe__'
    storage.setItem(probe, '1')
    storage.removeItem(probe)
    return true
  } catch {
    return false
  }
}

/**
 * 创建设置写入器（带防抖）。
 *
 * 拖滑杆时每帧都会触发保存请求，直接写会明显卡顿；
 * 这里只在用户"停下来"之后写一次。
 *
 * @param {{write:(v:any)=>{ok:boolean,reason?:string}}} store
 * @param {Object} [options]
 * @param {number} [options.debounceMs=300]
 * @param {(result:{ok:boolean,reason?:string})=>void} [options.onResult] 写入结果回调（用于提示失败）
 * @param {number} [options.quotaWarnMs=30000] 同一类失败最多多久提示一次（避免刷屏）
 */
export function createSettingsWriter(store, options = {}) {
  const { debounceMs = 300, onResult, quotaWarnMs = 30000 } = options

  let timer = 0
  let pending = null
  /** @type {Map<string, number>} 上次提示时间 */
  const lastWarn = new Map()

  function flush() {
    if (pending === null) return
    const value = pending
    pending = null
    const result = store.write(value)
    if (!result.ok && onResult) {
      const key = result.reason ?? 'unknown'
      const last = lastWarn.get(key) ?? 0
      const now = Date.now()
      if (now - last > quotaWarnMs) {
        lastWarn.set(key, now)
        onResult(result)
      }
    }
  }

  return {
    /** 请求保存（防抖） */
    save(value) {
      pending = value
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = 0
        flush()
      }, debounceMs)
    },

    /** 立即落盘（例如页面即将关闭） */
    flushNow() {
      if (timer) {
        clearTimeout(timer)
        timer = 0
      }
      flush()
    },

    /** 取消未落盘的写入 */
    cancel() {
      if (timer) clearTimeout(timer)
      timer = 0
      pending = null
    },
  }
}
