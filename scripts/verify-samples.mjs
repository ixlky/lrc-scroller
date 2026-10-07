// @ts-check
/**
 * 样例文件自检：确认 samples/ 下每个文件的实际解析结果与预期一致。
 * 这些预期值写死在脚本里，任何一项不符就是样例或解析器出了问题。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { decodeLrcBuffer } from '../src/core/encoding.js'
import { parseLrc } from '../src/core/lrcParser.js'

let pass = 0
let fail = 0

/**
 * @param {string} name
 * @param {object} expect
 */
function verify(file, expect) {
  const buf = readFileSync(`samples/${file}`)
  const dec = decodeLrcBuffer(buf)
  const doc = parseLrc(dec.text, { encoding: dec.encoding })

  const actual = {
    encoding: dec.encoding,
    fellBack: dec.fellBack,
    lines: doc.lines.length,
    empties: doc.lines.filter((l) => l.empty).length,
    dropped: doc.droppedLines.length,
    title: doc.meta.title,
    offsetMs: doc.meta.offsetMs,
    translations: doc.lines.filter((l) => l.isTranslation).length,
    warnCodes: doc.warnings.map((w) => w.code),
  }

  const problems = []
  for (const [k, v] of Object.entries(expect)) {
    if (k === 'hasWarn') {
      if (!actual.warnCodes.includes(v)) problems.push(`期望含警告 ${v}，实际 ${actual.warnCodes.join(',')}`)
      continue
    }
    if (k === 'notWarn') {
      if (actual.warnCodes.includes(v)) problems.push(`不应含警告 ${v}，但出现了`)
      continue
    }
    if (actual[k] !== v) problems.push(`${k}: 期望 ${JSON.stringify(v)}，实际 ${JSON.stringify(actual[k])}`)
  }

  if (problems.length === 0) {
    pass++
    console.log(`  \u2713 ${file}`)
    console.log(`      ${actual.lines} 行 / ${actual.encoding} / title="${actual.title}" / offset=${actual.offsetMs}`)
  } else {
    fail++
    console.log(`  \u2717 ${file}`)
    for (const p of problems) console.log(`      ${p}`)
  }
}

console.log('\n样例文件自检\n')

verify('01-基础.lrc', {
  encoding: 'utf-8',
  fellBack: false,
  lines: 11,
  empties: 1,
  dropped: 0,
  title: '基础示例',
  offsetMs: 0,
})

verify('02-多标签与乱序.lrc', {
  encoding: 'utf-8',
  lines: 9, // 8 行 + 1 行多标签展开出的额外一行
  title: '多标签与乱序测试',
  hasWarn: 'LRC_DUPLICATE_TIME',
})

verify('03-offset偏移.lrc', {
  encoding: 'utf-8',
  offsetMs: 500,
  lines: 9,
  title: 'Offset 偏移测试',
})

verify('04-边界情况.lrc', {
  encoding: 'utf-8',
  offsetMs: 0,
  title: '边界情况测试',
  hasWarn: 'LRC_DUPLICATE_TIME',
})

verify('05-无时间标签.txt', {
  encoding: 'utf-8',
  lines: 0,
  dropped: 11,
  hasWarn: 'LRC_NO_TIME_TAGS',
})

verify('06-只有元数据无歌词.lrc', {
  encoding: 'utf-8',
  lines: 0,
  dropped: 0,
  title: '纯空白与空文件测试',
  hasWarn: 'LRC_EMPTY',
})

verify('07-GBK编码.lrc', {
  encoding: 'gb18030',
  fellBack: true,
  lines: 9,
  title: 'GBK 编码测试',
})

console.log(`\n通过 ${pass} 个样例，失败 ${fail} 个\n`)
process.exit(fail > 0 ? 1 : 0)
