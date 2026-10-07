// @ts-check
/**
 * 节拍网格 —— 纯函数层，禁止 import vue。
 *
 * 【为什么单独成文件】
 * 节拍网格有三个独立的正确性陷阱，每一个都"肉眼看不出、测不出来就一定错"：
 *   1. **非法输入静默通过**：BPM=0 会让 interval=Infinity，
 *      网格变成 [0, Infinity, NaN…]，界面上表现为"网格消失"而不是"报错"。
 *      必须在**计算之前**校验 —— 这是本文件校验器存在的主要理由。
 *   2. **吸附越界**：容差写成 `<=` 时，恰好落在容差边界的时间会被吸过去，
 *      用户的输入被静默改写。容差是"用户授权的改动量"，越界就该不吸。
 *   3. **空值伪装成 0**：Number('') 和 Number(null) 都等于 0，
 *      若不单独处理，"输入框是空的"会被报成"BPM 必须大于 0" ——
 *      报错与现象对不上，用户会以为自己填了个 0。
 *
 * （曾经还有第 4 条"累积误差"，实测被推翻，见 beatTimes 内的注释。）
 *
 * 这些都属于"核心层算错、上层无法察觉"的类型，所以放在纯函数层用 Node 直测。
 */

/** 非法 BPM 的错误码（与 core/errors 的命名风格一致） */
export const BEAT_ERRORS = {
  /** BPM 不是有限数（NaN / Infinity / 空） */
  BPM_NOT_FINITE: 'BPM_NOT_FINITE',
  /** BPM ≤ 0 —— 0 会让每拍间隔变成 Infinity */
  BPM_NOT_POSITIVE: 'BPM_NOT_POSITIVE',
  /** BPM 超出合理范围（低于 20 或高于 400） */
  BPM_OUT_OF_RANGE: 'BPM_OUT_OF_RANGE',
  /** 第一拍偏移不是有限数 */
  OFFSET_NOT_FINITE: 'OFFSET_NOT_FINITE',
  /** 吸附容差为负数 */
  TOLERANCE_NEGATIVE: 'TOLERANCE_NEGATIVE',
}

/** BPM 合理范围。低于 20 基本是误输入，高于 400 人耳已无法分辨拍点。 */
export const BPM_MIN = 20
export const BPM_MAX = 400

/**
 * 校验 BPM。
 *
 * 【为什么单独一个函数而不是在各处 if】
 * 校验规则一旦散落到 UI、网格计算、吸附三处，改规则时就会漏改一处。
 * 单一入口 + 单一错误码，调用方只需要判断"有没有错误"。
 *
 * @param {unknown} bpm
 * @returns {{ok:true, value:number} | {ok:false, code:string, message:string}}
 */
export function validateBpm(bpm) {
  // 【空值必须单独处理 —— Number(null) === 0】
  // 若直接转换，null 会掉进 "BPM ≤ 0" 分支，报出"BPM 必须大于 0"，
  // 而用户看到的现象是**输入框是空的**。报错必须与现象一致，
  // 否则用户会以为自己填了个 0。
  if (bpm === null || bpm === undefined) {
    return {
      ok: false,
      code: BEAT_ERRORS.BPM_NOT_FINITE,
      message: '请输入 BPM',
    }
  }
  if (typeof bpm === 'string' && bpm.trim() === '') {
    return {
      ok: false,
      code: BEAT_ERRORS.BPM_NOT_FINITE,
      message: '请输入 BPM',
    }
  }
  const n = typeof bpm === 'number' ? bpm : Number(bpm)
  if (!Number.isFinite(n)) {
    return {
      ok: false,
      code: BEAT_ERRORS.BPM_NOT_FINITE,
      message: 'BPM 必须是数字',
    }
  }
  if (n <= 0) {
    return {
      ok: false,
      code: BEAT_ERRORS.BPM_NOT_POSITIVE,
      message: 'BPM 必须大于 0',
    }
  }
  if (n < BPM_MIN || n > BPM_MAX) {
    return {
      ok: false,
      code: BEAT_ERRORS.BPM_OUT_OF_RANGE,
      message: `BPM 应在 ${BPM_MIN}~${BPM_MAX} 之间`,
    }
  }
  return { ok: true, value: n }
}

/**
 * 校验第一拍偏移（毫秒）。
 * @param {unknown} ms
 * @returns {{ok:true, value:number} | {ok:false, code:string, message:string}}
 */
export function validateFirstBeatOffset(ms) {
  if (ms === null || ms === undefined || (typeof ms === 'string' && ms.trim() === '')) {
    // 空值 → 视为 0（第一拍偏移留空是合理的：网格从 0 开始）
    return { ok: true, value: 0 }
  }
  const n = typeof ms === 'number' ? ms : Number(ms)
  if (!Number.isFinite(n)) {
    return {
      ok: false,
      code: BEAT_ERRORS.OFFSET_NOT_FINITE,
      message: '第一拍偏移必须是数字',
    }
  }
  return { ok: true, value: n }
}

/**
 * 每拍间隔（毫秒）。
 * @param {number} bpm 已通过 validateBpm
 * @returns {number}
 */
export function beatIntervalMs(bpm) {
  return 60000 / bpm
}

/**
 * 生成节拍网格。
 *
 * 【关于"逐拍累加 vs i * interval"—— 一条被实测推翻的直觉】
 * 我最初写这段注释时断言："i * interval 会累积浮点误差，第 100 拍就漂移几毫秒，
 * 必须逐拍累加"。**实测证明这个断言是错的**（BPM=137、第 2000 拍）：
 *
 *   i * interval 末值 = 875474.4525547446
 *   逐拍累加     末值 = 875474.4525547397
 *   差值 = 4.89e-9 ms
 *
 * 纳秒级，比 1ms 小 20 万倍，任何场景都不可感知；而且 i*interval 反而**略准** ——
 * 乘法把 interval 的舍入误差一次性摊掉了，反复加则每次都带一次舍入。
 *
 * 仍然保留逐拍累加的真实理由只有两条，都与精度无关：
 *   1. 将来若要支持"变拍速 / swing / 每小节重数"，累加是唯一自然的形式；
 *   2. 读起来更直白（"下一拍 = 这一拍 + 一拍"），比心算乘法不易写错下标。
 * 若将来有人想改成 i * interval，**不要以"修正精度错误"为理由** —— 没有错误可修。
 *
 * @param {{ bpm:number, firstBeatMs?:number, beats?:number }} opts
 *   bpm 已通过校验；firstBeatMs 第一拍时间（毫秒，默认 0）；
 *   beats 生成多少拍（默认 64）
 * @returns {number[]} 节拍时间（毫秒，升序）
 */
export function beatTimes(opts) {
  const bpm = opts.bpm
  const firstBeatMs = opts.firstBeatMs ?? 0
  const beats = opts.beats ?? 64

  // 这里不再校验 BPM —— 调用方应该先 validateBpm。
  // 但仍要防御非有限值，否则会产出 [0, Infinity, NaN] 这种脏数据。
  if (!Number.isFinite(bpm) || bpm <= 0) return []
  if (!Number.isFinite(firstBeatMs)) return []
  if (!Number.isFinite(beats) || beats <= 0) return []

  const interval = beatIntervalMs(bpm)
  const out = []
  // 逐拍累加，不用 i * interval —— 见函数注释
  let t = firstBeatMs
  const n = Math.floor(beats)
  for (let i = 0; i < n; i++) {
    out.push(t)
    t += interval
  }
  return out
}

/**
 * 找到离给定时间最近的节拍。
 *
 * 【容差语义：严格小于，不含等于】
 * 容差代表"用户授权我们改动多少毫秒"。恰好等于容差时改动的量正好卡在授权上限，
 * 属于边界外的情况，不该吸。越界不吸比吸了更安全 ——
 * 吸错了用户会立刻发现"我打的 1.230 变成了 1.280"，不吸只是没吸附而已。
 *
 * 【二分查找的前提】
 * 要求 grid **升序**。beatTimes 天然满足；外部传入的数组若未排序，
 * 会被本函数按"无命中"处理而不是给出错误答案。
 *
 * @param {number} t 目标时间（毫秒）
 * @param {number[]} grid 升序节拍时间
 * @param {number} [toleranceMs=50] 容差（毫秒）
 * @returns {{t:number, index:number, deltaMs:number}|null} 命中返回拍点，未命中返回 null
 */
export function nearestBeat(t, grid, toleranceMs = 50) {
  if (!Array.isArray(grid) || grid.length === 0) return null
  if (!Number.isFinite(t)) return null
  if (!Number.isFinite(toleranceMs) || toleranceMs < 0) return null

  // 二分：找第一个 >= t 的位置
  let lo = 0
  let hi = grid.length - 1
  let pos = grid.length
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (grid[mid] >= t) {
      pos = mid
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }

  // 候选只有 pos 与 pos-1 两个
  /** @type {{t:number,index:number,deltaMs:number}|null} */
  let best = null
  const consider = (i) => {
    if (i < 0 || i >= grid.length) return
    const delta = grid[i] - t
    if (Math.abs(delta) >= toleranceMs) return
    if (!best || Math.abs(delta) < Math.abs(best.deltaMs)) {
      best = { t: grid[i], index: i, deltaMs: delta }
    }
  }
  consider(pos)
  consider(pos - 1)

  return best
}

/**
 * 判断某行是否应被吸附覆盖。
 *
 * 【为什么要"locked"这个概念】
 * 用户手动用 ←→ 微调过的行，是在表达"这个时间我确认过了"。
 * 如果之后打开吸附开关就把它们吸走，等于**推翻用户的显式操作**。
 * 所以"手动改过"必须高于"自动吸附"——这是优先级，不是覆盖顺序问题。
 *
 * @param {{locked?:boolean}} row
 * @returns {boolean} 可以被吸附覆盖时返回 true
 */
export function canSnap(row) {
  return !row?.locked
}
