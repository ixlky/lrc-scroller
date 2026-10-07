// @ts-check
/**
 * 编码探测与解码 —— 纯函数层，禁止 import vue。
 *
 * 为什么需要它：中文 LRC 文件有大量是 GBK/GB18030 编码的（尤其老歌词站下载的）。
 * 浏览器按 UTF-8 读会得到一屏乱码，而普通用户不知道"编码"是什么。
 * 这里的目标是**自动判断、自动兜底**，让用户不需要理解编码概念。
 *
 * 判定策略（按顺序）：
 *  1. 有 BOM → 直接用 BOM 指定的编码，最可靠。
 *  2. 用 `TextDecoder('utf-8', { fatal: true })` 严格解码：
 *     合法 UTF-8 不会抛错；非法序列会抛错 → 说明不是 UTF-8。
 *  3. 严格 UTF-8 失败后，尝试 GB18030（GBK 的超集，能覆盖更多生僻字）。
 *  4. 都失败 → 用非严格 UTF-8 兜底（用 U+FFFD 替换坏字符），保证不崩。
 */

/**
 * @typedef {Object} DecodeResult
 * @property {string} text 解码后的文本
 * @property {string} encoding 实际使用的编码名
 * @property {boolean} fellBack 是否发生过编码回退（用于提示用户）
 * @property {string} reason 判定依据，便于排查
 */

/** BOM 表：字节前缀 → 编码 */
const BOMS = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8' },
  { bytes: [0xff, 0xfe], encoding: 'utf-16le' },
  { bytes: [0xfe, 0xff], encoding: 'utf-16be' },
]

/**
 * 读取 BOM。
 * @param {Uint8Array} bytes
 * @returns {{encoding:string, length:number}|null}
 */
function readBom(bytes) {
  for (const bom of BOMS) {
    if (bytes.length < bom.bytes.length) continue
    let ok = true
    for (let i = 0; i < bom.bytes.length; i++) {
      if (bytes[i] !== bom.bytes[i]) {
        ok = false
        break
      }
    }
    if (ok) return { encoding: bom.encoding, length: bom.bytes.length }
  }
  return null
}

/**
 * 该编码名在当前浏览器是否可用。
 * Safari 老版本不支持 gbk，所以要探测而不是假设。
 * @param {string} encoding
 * @returns {boolean}
 */
export function isEncodingSupported(encoding) {
  try {
    new TextDecoder(encoding)
    return true
  } catch {
    return false
  }
}

/**
 * 从一个编码标签字节流中探测并解码文本。
 *
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {Object} [options]
 * @param {string} [options.hint] 若调用方已知编码（如用户手动指定），优先使用
 * @returns {DecodeResult}
 */
export function decodeLrcBuffer(buffer, options = {}) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)

  if (bytes.length === 0) {
    return { text: '', encoding: 'utf-8', fellBack: false, reason: '空文件' }
  }

  // 0) 调用方显式指定（用户手动选择编码时走这里）
  const hint = options.hint
  if (hint && isEncodingSupported(hint)) {
    try {
      const text = new TextDecoder(hint, { fatal: false }).decode(bytes)
      return { text, encoding: hint, fellBack: false, reason: '使用指定编码' }
    } catch {
      // 指定编码失败则继续自动探测
    }
  }

  // 1) BOM 优先
  const bom = readBom(bytes)
  if (bom) {
    try {
      const body = bytes.subarray(bom.length)
      const text = new TextDecoder(bom.encoding, { fatal: false }).decode(body)
      return {
        text,
        encoding: bom.encoding,
        fellBack: bom.encoding !== 'utf-8',
        reason: `检测到 ${bom.encoding.toUpperCase()} BOM`,
      }
    } catch {
      // BOM 解析失败则继续
    }
  }

  // 2) 严格 UTF-8
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return { text, encoding: 'utf-8', fellBack: false, reason: '合法的 UTF-8 字节序列' }
  } catch {
    // 不是合法 UTF-8，继续尝试中文编码
  }

  // 3) GB18030（GBK 超集）
  if (isEncodingSupported('gb18030')) {
    try {
      const text = new TextDecoder('gb18030', { fatal: true }).decode(bytes)
      return {
        text,
        encoding: 'gb18030',
        fellBack: true,
        reason: '非 UTF-8，按 GB18030/GBK 解码成功',
      }
    } catch {
      // 继续
    }
  }

  // 4) 非严格 UTF-8 兜底：宁可显示个别乱码字符，也不能让用户拿不到内容
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  return {
    text,
    encoding: 'utf-8',
    fellBack: true,
    reason: '无法确定编码，已用 UTF-8 容错解码（可能有乱码）',
  }
}

/**
 * 粗略判断文本是否像"乱码"（UTF-8 被当 GBK 读，或反之）。
 * 用于在自动判定不确定时给出提示，而不是静默显示乱码。
 *
 * 判据：替换字符 U+FFFD 数量，或连续的生僻/私用区字符比例。
 * @param {string} text
 * @returns {{suspicious:boolean, replacementCount:number, reason:string}}
 */
export function looksGarbled(text) {
  if (typeof text !== 'string' || text === '') {
    return { suspicious: false, replacementCount: 0, reason: '空文本' }
  }

  let replacementCount = 0
  let suspiciousRanges = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0xfffd) replacementCount++
    // 私用区 / 生僻符号：UTF-8 误读成 GBK 时大量出现
    else if ((code >= 0xe000 && code <= 0xf8ff) || (code >= 0x3100 && code <= 0x312f)) suspiciousRanges++
  }

  const len = [...text].length
  const ratio = len > 0 ? (replacementCount + suspiciousRanges) / len : 0
  if (replacementCount > 0) {
    return { suspicious: true, replacementCount, reason: `含 ${replacementCount} 个无法解码的字符` }
  }
  if (ratio > 0.15 && len > 20) {
    return { suspicious: true, replacementCount: 0, reason: '疑似编码不匹配（生僻区字符偏多）' }
  }
  return { suspicious: false, replacementCount: 0, reason: '正常' }
}

/**
 * 把文件读成文本（浏览器环境）。这是唯一使用 FileReader 的地方。
 * @param {File} file
 * @param {Object} [options]
 * @returns {Promise<DecodeResult>}
 */
export async function readLyricFile(file, options = {}) {
  const buffer = await file.arrayBuffer()
  return decodeLrcBuffer(buffer, options)
}
