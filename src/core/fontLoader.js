// @ts-check
/**
 * 自定义字体加载 —— 纯逻辑层，不 import vue。
 *
 * 【只做会话内，不持久化】
 * 中文字体 10~25MB，localStorage 配额实测只有 4.75MB，装不下；
 * IndexedDB 虽然能装，但浏览器在存储压力下可能清除，
 * 会给用户"存住了却丢了"的错误预期。用户工作流里不需要刷新页面，
 * 会话内可用就够了 —— 刷新后重新上传。
 *
 * 【不做格式白名单、不解析字体】
 * 交给浏览器自己的 FontFace.load() 判断。
 * .ttf/.otf/.woff/.woff2 全平台可用；.ttc（如微软雅黑 msyh.ttc）
 * Chrome 支持、Safari/Firefox 可能拒绝 —— 失败时统一的 catch 提示已覆盖。
 */

/**
 * 已注册的自定义字体名。
 * 用 Set 记录是为了 cleanupAllCustomFonts 能整体清理，
 * 也避免同一会话里重复 add 同一个 FontFace。
 * @type {Set<string>}
 */
const registered = new Set()

/** 字体名前缀：避免与系统字体撞名（撞名时浏览器可能直接用系统的） */
const NAME_PREFIX = 'LrcCustomFont'

/**
 * 从文件注册一个自定义字体，返回可用的字体名。
 *
 * 【为什么名字带时间戳】
 * 同一个字体文件可能被上传两次（用户想换回来），
 * 名字唯一才能让两次注册互不干扰、也方便单独移除。
 *
 * @param {File} file
 * @returns {Promise<string>} 字体名（供 CSS font-family 与 canvas 使用）
 * @throws 浏览器无法识别该字体时抛错，由调用方 catch 并提示
 */
export async function registerCustomFont(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new Error('无效的字体文件')
  }

  const buffer = await file.arrayBuffer()
  const name = `${NAME_PREFIX}-${Date.now()}`

  const fontFace = new FontFace(name, buffer)
  // load() 失败会 reject（不支持的格式、损坏文件等），交给调用方处理
  await fontFace.load()
  document.fonts.add(fontFace)
  registered.add(name)

  return name
}

/**
 * 移除一个已注册的自定义字体。
 *
 * 【为什么比对前缀而不是直接 delete】
 * document.fonts.delete 需要同一个 FontFace 实例；这里用 family 名逐个匹配，
 * 兼容"同一名字被注册过多次"的情况。
 *
 * @param {string} familyName
 * @returns {boolean} 是否真的删掉了
 */
export function unregisterCustomFont(familyName) {
  if (!familyName || typeof document === 'undefined' || !document.fonts) return false

  let removed = false
  /** @type {FontFace[]} */
  const toDelete = []
  document.fonts.forEach((face) => {
    if (face.family === familyName) toDelete.push(face)
  })
  for (const face of toDelete) {
    try {
      document.fonts.delete(face)
      removed = true
    } catch {
      /* 某些实现不允许删除，忽略 */
    }
  }

  registered.delete(familyName)
  return removed
}

/**
 * 清空本会话注册过的所有自定义字体。
 * 供需要"彻底重置"的场景使用（页面卸载时**不要**调 —— 用户可能还在用）。
 * @returns {number} 清理掉的字体数
 */
export function cleanupAllCustomFonts() {
  let n = 0
  for (const name of [...registered]) {
    if (unregisterCustomFont(name)) n++
  }
  registered.clear()
  return n
}

/** 当前已注册的字体名（供诊断/验收使用） */
export function listCustomFonts() {
  return [...registered]
}
