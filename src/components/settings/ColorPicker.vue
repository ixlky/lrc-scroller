<script setup>
/**
 * 颜色选择器：色轮 + 竖直明度条 + RGB/S 滑杆 + HEX 输入。
 *
 * 【布局（阶段 5 补丁 10：色轮替代色相环）】
 *  - 左：色轮（**角度→色相 H、半径→饱和度 S**）+「重置为白色」按钮
 *  - 右：竖直明度条（顶端纯色 → 底端纯黑）
 *  - 下：RGB 三通道滑杆 + S 滑杆 + HEX
 *
 * 【所见即所得（一次真实 BUG 的修复）】
 * 色轮的遮罩曾与取色**相反**：圆心附近看着是大红（S=100），
 * 点下去却得到淡粉（S=15%）。现在遮罩由 `wheelSaturationAt` 反解生成，
 * 与 `pointToHS` 共用同一个函数 —— 看到什么就点到什么。
 *
 * 【为什么内部统一用 HSV】
 * 色轮与明度条都在用 HSV 的 V，H/S 独立于 V，于是：
 *   - 拖色轮时明暗稳定（HSL 的 L 会随 S 变化，拖到边缘忽明忽暗）
 *   - 纯黑时拖色轮颜色看着不变，但 H/S 记住了，
 *     把明度条拉回来颜色就按选中的色相出来（HSL 做不到，L=0 会抹掉 H/S）
 *
 * 【对外接口保持不变】
 * modelValue / update:modelValue / invalid —— SettingsDrawer 无需改动。
 * 用户看到的永远是 hex 与 RGB 滑杆；HSV 只是这个控件的内部坐标。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { attachPointerDrag } from '@/composables/pointerDrag'
import {
  hexToRgb,
  rgbToHex,
  validateHexInput,
  contrastText,
  channelGradient,
  rgbToHsv,
  hsvToRgb,
  valueGradient,
  pointToHS,
  hsToPoint,
  wheelGradient,
} from '@/core/color'

const props = defineProps({
  modelValue: { type: String, required: true },
  label: { type: String, default: '' },
  /** 是否显示色轮 + 明度条（不需要时可关掉） */
  showRing: { type: Boolean, default: true },
})

const emit = defineEmits(['update:modelValue', 'invalid'])

const rgb = computed(() => hexToRgb(props.modelValue) ?? { r: 0, g: 0, b: 0, a: 1 })
const hex = computed(() => rgbToHex(rgb.value.r, rgb.value.g, rgb.value.b))

/**
 * 局部状态：**HSV**（不是 HSL）。
 *
 * 【为什么从 HSL 换成 HSV —— 补丁 10】
 * 色轮与竖直明度条现在都在用 HSV 的 V。用 HSL 会有两个问题：
 *   1. 拖色轮到边缘时 L 随 S 变化 → 颜色忽明忽暗；
 *   2. 两个控件都改"亮度"，语义重叠。
 * 用 HSV 后 H/S 独立于 V，**拖色轮时明暗稳定**，两个控件正交。
 *
 * 【实测：会不会抖】
 * 全网格（360×100×100）实测：
 *   - 拖动 1px（S 变 1）→ RGB 只变 1~2 级，远低于可见阈值
 *   - 拖动路径上**零往返**：用户拖色轮时直接写 HSV，不经过 HSL，
 *     误差无从累积；HSL 只在别处做独立换算时用到。
 */
const localHsv = ref(/** @type {{h:number,s:number,v:number}} */ (
  rgbToHsv(rgb.value.r, rgb.value.g, rgb.value.b)
))

/**
 * 色相记忆。
 *
 * 【为什么需要它 —— 纯白反推 HSV 会得到 h=0（红）】
 * `#ffffff` → HSV(0, 0, 100)。若小点跟着这个 h=0 走，
 * 用户点「重置为白色」后小点会跳到红区，视觉像在说"现在是红色"，
 * 但颜色明明是白的 —— 纯误导。
 *
 * 所以：**小点位置只由用户拖动更新，不从颜色反推。**
 * 从 HEX 反推时用记忆值覆盖算出的 h。
 */
let hueMemory = localHsv.value.h

/**
 * 从当前 RGB 反推 HSV，写入局部状态。
 * 色相用记忆值覆盖（除非颜色本身明显带色相）。
 */
function syncFromRgb(r, g, b) {
  const v = rgbToHsv(r, g, b)
  // 只有当颜色**确实有饱和度**时，反推出的色相才可信，才更新记忆。
  // 灰阶/纯白/纯黑时保持用户上次选的色相。
  if (v.s > 0.5) hueMemory = v.h
  localHsv.value = { h: hueMemory, s: v.s, v: v.v }
}

// 外部改动（例如载入设置、点重置）时同步回来。
//
// 【真机 BUG（补丁 9）：布尔标记会在"emit 了相同值"时卡住 —— 保留此修法】
// 原本是 `let selfUpdate = false`：commitHex 置 true，靠下一次 watch 清掉。
// 但 Vue 的 watch 只在值**真的变化**时才触发，于是这个场景会永久卡死：
//   1. 颜色是 #ffffff，用户操作 → emit('#ffffff')，值没变 → watch 不触发
//      → selfUpdate 永远是 true
//   2. 之后外部把颜色改成 #000000 → watch 触发，
//      但第一个分支把 selfUpdate 清掉并 return → **局部状态没被更新**
//
// 修法：记住自己发出的**值**，只有 watch 收到的值恰好等于它时才跳过。
//
// 【补丁 10 保留它的理由】
// 色轮时代"颜色不变"的情况大幅减少（点任何位置都会变色），
// 但纯黑（V=0）时点色轮颜色**仍然不变** —— 触发条件依然存在，
// 所以这个防御必须保留，不能因为"现在不常触发"就删掉。
let selfEmitted = /** @type {string|null} */ (null)

watch(
  () => props.modelValue,
  (v) => {
    // 只有"值确实是我发出去的"才跳过；其余一律当作外部改动
    if (selfEmitted !== null && v === selfEmitted) {
      selfEmitted = null
      return
    }
    selfEmitted = null
    const c = hexToRgb(v)
    if (c) syncFromRgb(c.r, c.g, c.b)
  },
)

/** 统一的提交出口：写回 modelValue，并同步局部 HSV 状态 */
function commitHex(nextHex, hsv) {
  if (hsv) {
    // 用户主动操作 → 更新色相记忆
    if (hsv.s > 0.5) hueMemory = hsv.h
    localHsv.value = hsv
  }
  selfEmitted = nextHex
  emit('update:modelValue', nextHex)
}

// ── RGB 滑杆 ────────────────────────────────────
function setChannel(channel, value) {
  const n = Math.max(0, Math.min(255, Math.round(Number(value) || 0)))
  const next = { ...rgb.value, [channel]: n }
  commitHex(rgbToHex(next.r, next.g, next.b), rgbToHsv(next.r, next.g, next.b))
}

const gradients = computed(() => ({
  r: channelGradient('r', rgb.value.r, rgb.value.g, rgb.value.b),
  g: channelGradient('g', rgb.value.r, rgb.value.g, rgb.value.b),
  b: channelGradient('b', rgb.value.r, rgb.value.g, rgb.value.b),
}))

// ── 色轮 ────────────────────────────────────────
const ringRef = ref(/** @type {HTMLElement|null} */ (null))

/** 色轮可用半径（像素），与 CSS 中的尺寸保持一致 */
const WHEEL_SIZE = 120
/**
 * 色轮半径 = **半个盒子**。
 *
 * 【为什么不能内缩几个像素 —— 这是第二次踩到的坑】
 * CSS 的遮罩写成 `radial-gradient(circle closest-side at center, …)`，
 * 它的 100% 锚点就是"半边长"（120px 的圆 → 60px）。
 * 若这里写成 `- 2`，取色半径是 58px 而绘制半径是 60px，
 * 边缘处"看到的饱和度"就会比"点到的饱和度"低约 3.4%，
 * 整轮颜色系统性偏白 —— 正是像素比对抓出来的问题。
 * 两边都用 `min(w,h)/2`，换任何尺寸都不会再错位。
 */
const WHEEL_RADIUS = WHEEL_SIZE / 2

/** 色轮小点的位置（相对圆心） */
const knobPos = computed(() => hsToPoint(localHsv.value.h, localHsv.value.s, WHEEL_RADIUS))

/**
 * 色轮背景：底层色相锥形 + 顶层动态灰度遮罩。
 *
 * 【中心遮罩必须是"当前明度下的灰"而非写死白色 —— 真机明确要求】
 * 纯白起点（V=100）时中心就该是白的；
 * 若写死白遮罩，V=50 时中心会显示"被白稀释的假灰"，不属于任何明度。
 * wheelGradient 已按 V 生成正确的灰。
 *
 * 【注意】wheelGradient 返回的是 { background, center } 对象，
 * 模板里必须取 .background —— 直接绑对象会被 Vue 静默丢弃
 * （:style 遇到 [object Object] 不报错，只是不生效，表现为"色轮一片空白"）。
 */
const ringBackground = computed(() => wheelGradient(localHsv.value.v).background)

/**
 * 设置色相与饱和度（色轮拖动的唯一出口）。
 *
 * 【为什么 V 不动】
 * 色轮只负责 H 和 S；明暗交给右侧竖直明度条。
 * 拖色轮时 V 保持不变 → 颜色明暗稳定，不会忽明忽暗。
 * 纯黑（V=0）时拖色轮颜色**看起来**不变，但 H/S 已被记住，
 * 此时拖明度条颜色就会按选中的色相出来。
 */
function setHS(h, s) {
  const hn = ((h % 360) + 360) % 360
  const sn = Math.max(0, Math.min(100, s))
  const v = localHsv.value.v
  const c = hsvToRgb(hn, sn, v)
  commitHex(rgbToHex(c.r, c.g, c.b), { h: hn, s: sn, v })
}

/** 「重置为白色」：回到最中性的起点。 */
function resetToWhite() {
  // 色相记忆清零 —— 小点回到顶部（0°）而不是停在用户上次选的颜色上，
  // 否则会出现"颜色是白的、小点却在紫区"的视觉矛盾。
  hueMemory = 0
  commitHex('#ffffff', { h: 0, s: 0, v: 100 })
}

/**
 * 色轮拖动。
 *
 * 【为什么统一走 attachPointerDrag】
 * 监听挂在 window 上、按登记表解绑、收尾幂等 ——
 * 避免早期"监听器加在元素上、拖出元素外松手收不到 pointerup"导致的泄漏。
 *
 * 注意：本实现**不使用 setPointerCapture**（历史上捕获引发过三次 bug，
 * 而 window 监听已覆盖元素外场景，详见 pointerDrag.js 文件头）。
 */
function onRingPointerDown(e) {
  const el = ringRef.value
  if (!el) return

  attachPointerDrag(e, {
    el,
    label: '色轮',
    onMove: (ratio, ev) => {
      void ratio
      const rect = el.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      // 坐标非法（NaN）时 pointToHS 会算出 NaN，这里挡掉
      if (!Number.isFinite(ev.clientX) || !Number.isFinite(ev.clientY)) return
      // 半径用实际渲染尺寸推导，保证 CSS 缩放后依然精确。
      // 必须与 wheelGradient 的 `closest-side` 取同一个值（= 半边长），
      // 否则"看到的饱和度"与"点到的饱和度"会系统性偏差。
      const r = Math.max(1, Math.min(rect.width, rect.height) / 2)
      const hs = pointToHS(ev.clientX - cx, ev.clientY - cy, r)
      setHS(hs.h, hs.s)
    },
  })
}

/** 色轮键盘操作：方向键调整色相，Shift+方向键调整饱和度 */
function onRingKeydown(e) {
  const cur = localHsv.value
  const hStep = e.shiftKey ? 0 : 5
  const sStep = e.shiftKey ? 5 : 0
  let handled = true
  switch (e.key) {
    case 'ArrowLeft':
      setHS(cur.h - (hStep || 5), cur.s - sStep)
      break
    case 'ArrowRight':
      setHS(cur.h + (hStep || 5), cur.s + sStep)
      break
    case 'ArrowUp':
      setHS(cur.h, cur.s + (sStep || 5))
      break
    case 'ArrowDown':
      setHS(cur.h, cur.s - (sStep || 5))
      break
    default:
      handled = false
  }
  if (handled) e.preventDefault()
}

// ── 竖直明度条（HSV 的 V）────────────────────────
const barRef = ref(/** @type {HTMLElement|null} */ (null))

/**
 * 条当前是水平（窄屏降级）还是竖直 —— 由**实际渲染尺寸**决定，不猜断点。
 * 声明在 onBarPointerDown 之前：那里会写它，必须先有定义。
 */
const barIsHorizontal = ref(false)

/** 明度条当前 HSV 状态（现在就是主状态，直接用） */

/**
 * 明度条背景渐变。
 * 窄屏降级成水平条时方向要跟着变成 to right，否则渐变与实际轴不符。
 */
const barBackground = computed(() => {
  const grad = valueGradient(localHsv.value.h, localHsv.value.s)
  return barIsHorizontal.value ? grad.replace('to bottom', 'to right') : grad
})

/**
 * 明度条拖动点的位置（竖直时是 top%，水平时是 left%）。
 *
 * 【位置就是取值，不做任何缓动变换】
 * 曾提供「感知」模式，让把手位置过一层 inverseSmoothstep。
 * 那会让**把手显示的位置不等于实际明度** —— 用户看到与得到不一致。
 * 明度条是取值控件，位置必须严格等于取值，所以现在只有线性。
 *
 * valueGradient 是 `to bottom`（降级后 `to right`），t=0 在亮端、t=1 在暗端，
 * 所以**把手位置百分比 = 1 - V**，横竖同一条公式。
 *
 * 【真机 BUG：曾把垂直分支写成 `1 - p`】
 * 那样 V=100 会算出 100%（把手跑到底部），与实际亮色完全相反。
 * 现在与 onBarPointerDown 读同一个式子，符号只有一处定义。
 */
const barKnobPos = computed(() => (1 - localHsv.value.v / 100) * 100)

/** 滑块用 style 绑定，横竖两种形态都用同一套 top/left */
const barKnobStyle = computed(() =>
  barIsHorizontal.value
    ? { left: `${barKnobPos.value}%` }
    : { top: `${barKnobPos.value}%` },
)

/**
 * 挂载后按**实际渲染尺寸**校准轴向。
 *
 * 【为什么必须在挂载时就校准，不能等第一次拖动】
 * barIsHorizontal 原本只在 onBarPointerDown 里写。
 * 但窄屏降级成水平布局时，用户**还没拖过**，barIsHorizontal 仍是初始的 false
 * → 把手绑定的是 `top` 而不是 `left` → 在水平条上定位完全错乱。
 * 拖一次之后才会纠正，但那之前的显示是错的。
 * 这里用 ResizeObserver 跟着布局变化持续校准。
 */
onMounted(() => {
  const el = barRef.value
  if (!el) return
  const sync = () => {
    const r = el.getBoundingClientRect()
    if (r.width > 0 || r.height > 0) {
      barIsHorizontal.value = r.width > r.height
    }
  }
  sync()
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(sync)
    ro.observe(el)
    onBeforeUnmount(() => ro.disconnect())
  } else {
    window.addEventListener('resize', sync)
    onBeforeUnmount(() => window.removeEventListener('resize', sync))
  }
})

/**
 * 设置明度（HSV 的 V）。
 *
 * 【为什么改 V 不丢色相】
 * HSV 的 H/S 独立于 V —— 纯黑（V=0）时 h、s 仍然记在 localHsv 里，
 * 所以把 V 拉回来颜色会按选中的色相恢复。
 * 这正是不选 HSL 的原因之一：HSL 在 L=0 时 H 和 S 都会被退化抹掉。
 */
function setValue(v) {
  const hsv = { ...localHsv.value, v: Math.max(0, Math.min(100, Math.round(v))) }
  const c = hsvToRgb(hsv.h, hsv.s, hsv.v)
  commitHex(rgbToHex(c.r, c.g, c.b), hsv)
}

/**
 * 明度条拖动。
 *
 * 【条的几何：p 就是"暗度比例"】
 * `valueGradient` 输出 `to bottom`：t=0（顶部）是 V=100 最亮，t=1（底部）是 V=0 最暗。
 * 水平降级时把 `to bottom` 换成 `to right`，语义不变（左亮右黑）。
 * 所以从**亮端**量起的 p：
 *   p = 0 → 亮端 → V=100
 *   p = 1 → 暗端 → V=0
 * 即 **p 越大越暗**，正好就是把手的位置百分比。
 *
 * 【这里曾出过一个真机 BUG：把手显示与实际亮度相反】
 * 出参与拖动当时各写了一套符号约定（出参多了一次 `1 -`），
 * 于是"拖动是对的、只有把手位置反了"。
 * 现在两边读同一个式子 `(1 - p) × 100`，符号只有这一处定义。
 *
 * @param {number} p 位置比例 0~1（0=亮端，1=暗端）
 * @returns {number} V 0~100
 */
function valueFromPosition(p) {
  // p=0 是亮端 → V=100，所以这里要把 p 翻转成亮度
  return (1 - p) * 100
}

function onBarPointerDown(e) {
  const el = barRef.value
  if (!el) return

  const apply = (ev) => {
    const rect = el.getBoundingClientRect()
    const horizontal = rect.width > rect.height
    // 记录实际轴向，供滑块定位与渐变方向使用
    barIsHorizontal.value = horizontal
    if (horizontal ? rect.width <= 0 : rect.height <= 0) return

    if (horizontal) {
      if (!Number.isFinite(ev.clientX)) return
      // 水平条：左 = 亮（p=0），右 = 暗（p=1）
      setValue(valueFromPosition(Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width))))
    } else {
      if (!Number.isFinite(ev.clientY)) return
      // 竖直条：顶端 = 亮（p=0），底端 = 暗（p=1）
      setValue(valueFromPosition(Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height))))
    }
  }

  apply(e)

  try {
    el.setPointerCapture?.(e.pointerId)
  } catch {
    /* 合成事件等场景忽略 */
  }

  const move = (ev) => apply(ev)
  const up = (ev) => {
    try {
      el.releasePointerCapture?.(ev.pointerId)
    } catch {
      /* 忽略 */
    }
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
    el.removeEventListener('pointercancel', up)
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)
}

/** 明度条键盘可达 */
function onBarKeydown(e) {
  const step = e.shiftKey ? 10 : 2
  if (e.key === 'ArrowUp') setValue(localHsv.value.v + step)
  else if (e.key === 'ArrowDown') setValue(localHsv.value.v - step)
  else if (e.key === 'Home') setValue(100)
  else if (e.key === 'End') setValue(0)
  else return
  e.preventDefault()
}

// ── 饱和度滑杆（保留，用于精细调整）──────────────
/**
 * 设置饱和度。
 * 滑杆两端（0% / 100%）要在**当前明度**下预览：
 * S=0 → 当前明度的灰；S=100 → 当前明度的纯色。
 * 所以渐变两端是 hsvToRgb(h, 0, v) 与 hsvToRgb(h, 100, v)。
 */
function setSat(s) {
  setHS(localHsv.value.h, Math.max(0, Math.min(100, Math.round(s))))
}

/** S 滑杆背景：从当前明度的灰到当前明度的纯色 */
const satGradient = computed(() => {
  const { h, v } = localHsv.value
  const a = hsvToRgb(h, 0, v)
  const b = hsvToRgb(h, 100, v)
  return `linear-gradient(to right, ${rgbToHex(a.r, a.g, a.b)}, ${rgbToHex(b.r, b.g, b.b)})`
})

// ── HEX 输入 ────────────────────────────────────
const hexDraft = ref(hex.value)
const hexInvalid = ref(false)

// 外部颜色变化时同步输入框显示（用户正在输入时不打断）
watch(hex, (v) => {
  if (!hexInvalid.value) hexDraft.value = v
})

function onHexInput(e) {
  const raw = /** @type {HTMLInputElement} */ (e.target).value
  hexDraft.value = raw
  const parsed = validateHexInput(raw)
  if (parsed === null) {
    // 非法值：标记红色、**不生效**（绝不猜测近似值填回去）
    hexInvalid.value = true
    emit('invalid', raw)
    return
  }
  hexInvalid.value = false
  commitHex(parsed)
}

function onHexBlur() {
  // 失焦时把非法草稿恢复成当前真实值，避免一直红着
  if (hexInvalid.value) {
    hexInvalid.value = false
    hexDraft.value = hex.value
  }
}

const textColor = computed(() => contrastText(hex.value))

// 注：补丁 6/8 引入的 ensureHueVisible（自动提饱和 / 拉亮度）已按用户要求撤销 ——
//     拖色相环现在只改 H，所见即所得。相关常量与逻辑从 core/color.js 一并移除。
</script>

<template>
  <div class="cp">
    <!-- 顶部：预览色块 + HEX -->
    <div class="cp__top">
      <div class="cp__swatch" :style="{ background: hex, color: textColor }" :title="hex">
        <span class="cp__swatch-hex">{{ hex }}</span>
      </div>
      <label class="cp__hex">
        <span class="sr-only">{{ label }} HEX 值</span>
        <input
          class="cp__hex-input"
          :class="{ 'is-invalid': hexInvalid }"
          type="text"
          spellcheck="false"
          maxlength="9"
          :value="hexDraft"
          :aria-invalid="hexInvalid"
          @input="onHexInput"
          @blur="onHexBlur"
        />
      </label>
    </div>

    <p v-if="hexInvalid" class="cp__error" role="alert">格式不正确，请输入如 #ff0000（未生效）</p>

    <!-- 色轮 + 竖直明度条 -->
    <div v-if="showRing" class="cp__ring-row">
      <div class="cp__wheel-wrap">
        <div
          ref="ringRef"
          class="cp__ring"
          role="slider"
          tabindex="0"
          :aria-label="`${label} 色轮（角度选色相、距离选饱和度）`"
          aria-valuemin="0"
          aria-valuemax="360"
          :aria-valuenow="localHsv.h"
          :aria-valuetext="`色相 ${Math.round(localHsv.h)} 度，饱和度 ${Math.round(localHsv.s)}%`"
          :style="{ background: ringBackground }"
          @pointerdown="onRingPointerDown"
          @keydown="onRingKeydown"
        >
          <div
            class="cp__ring-knob"
            :style="{ transform: `translate(calc(-50% + ${knobPos.x}px), calc(-50% + ${knobPos.y}px))` }"
          />
        </div>

        <!-- 「重置为白色」：回到最中性的起点，方便从头调 -->
        <button
          class="cp__reset-white"
          type="button"
          title="把颜色恢复为纯白 #ffffff"
          @click="resetToWhite"
        >
          重置为白色
        </button>
      </div>

      <!-- 竖直明度条：顶端纯色 → 底端黑 -->
      <div
        ref="barRef"
        class="cp__bar"
        role="slider"
        tabindex="0"
        :aria-label="`${label} 明度`"
        aria-valuemin="0"
        aria-valuemax="100"
        :aria-valuenow="localHsv.v"
        :aria-valuetext="`明度 ${Math.round(localHsv.v)}%`"
        :style="{ background: barBackground }"
        @pointerdown="onBarPointerDown"
        @keydown="onBarKeydown"
      >
        <div class="cp__bar-knob" :style="barKnobStyle" />
      </div>
    </div>

    <!-- RGB 滑杆 -->
    <div class="cp__rgb">
      <label v-for="ch in ['r', 'g', 'b']" :key="ch" class="cp__row">
        <span class="cp__ch">{{ ch.toUpperCase() }}</span>
        <input
          class="cp__slider"
          type="range"
          min="0"
          max="255"
          step="1"
          :value="ch === 'r' ? rgb.r : ch === 'g' ? rgb.g : rgb.b"
          :style="{ background: gradients[ch] }"
          :aria-label="`${label} ${ch.toUpperCase()} 通道`"
          @input="setChannel(ch, $event.target.value)"
        />
        <span class="cp__num">{{ ch === 'r' ? rgb.r : ch === 'g' ? rgb.g : rgb.b }}</span>
      </label>

      <!-- 饱和度（精细调整用；与色轮同源，都是 HSV 的 S） -->
      <label class="cp__row">
        <span class="cp__ch">S</span>
        <input
          class="cp__slider"
          type="range"
          min="0"
          max="100"
          step="1"
          :value="Math.round(localHsv.s)"
          :style="{ background: satGradient }"
          :aria-label="`${label} 饱和度 S`"
          @input="setSat($event.target.value)"
        />
        <span class="cp__num">{{ Math.round(localHsv.s) }}%</span>
      </label>
    </div>
  </div>
</template>

<style scoped>
.cp {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cp__top {
  display: flex;
  gap: 8px;
  align-items: center;
}

.cp__swatch {
  display: grid;
  flex: 1 1 auto;
  place-items: center;
  height: 32px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
}

.cp__hex {
  flex: none;
  width: 96px;
}

.cp__hex-input {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-panel-2);
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  text-transform: lowercase;
}

.cp__hex-input.is-invalid {
  border-color: var(--ui-error);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ui-error) 25%, transparent);
}

.cp__error {
  margin: -4px 0 0;
  color: var(--ui-error);
  font-size: 11px;
}

.cp__rgb {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.cp__row {
  display: flex;
  gap: 8px;
  align-items: center;
}

.cp__ch {
  flex: none;
  width: 14px;
  color: var(--ui-text-dim);
  font-family: ui-monospace, Consolas, monospace;
  font-size: 11px;
}

.cp__num {
  flex: none;
  width: 42px;
  color: var(--ui-text-dim);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.cp__slider {
  flex: 1 1 auto;
  min-width: 0;
  height: 16px;
  padding: 0;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  outline-offset: 3px;
  appearance: none;
  cursor: pointer;
}

.cp__slider::-webkit-slider-thumb {
  width: 14px;
  height: 14px;
  border: 2px solid #fff;
  border-radius: 50%;
  background: transparent;
  box-shadow: 0 1px 3px rgb(0 0 0 / 55%);
  appearance: none;
}

.cp__slider::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border: 2px solid #fff;
  border-radius: 50%;
  background: transparent;
  box-shadow: 0 1px 3px rgb(0 0 0 / 55%);
}

/* ── 色轮 + 竖直明度条 ── */
.cp__ring-row {
  display: flex;
  gap: 12px;
  align-items: center;
}

/* 色轮与「重置为白色」按钮竖直堆叠 */
.cp__wheel-wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  flex: none;
}

/*
 * 色轮。
 *
 * 【与旧色相环的结构差异】
 * 旧的是"环"：中间镂空，用 border-radius:50% + 厚边框做出甜甜圈的形状。
 * 新的是"盘"：整块实心，靠 background 的双层渐变画出中心灰→边缘彩。
 * 所以不再需要 .cp__ring-center（中心色已由径向遮罩生成）。
 */
.cp__ring {
  position: relative;
  width: 120px;
  height: 120px;
  border-radius: 50%;
  cursor: crosshair;
  /* 触摸拖动色轮时不要触发页面滚动 */
  touch-action: none;
  flex: none;
  /* 描边让色轮在浅色面板上也有边界 */
  box-shadow: inset 0 0 0 1px var(--ui-border);
}

.cp__ring-knob {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 12px;
  height: 12px;
  border: 2px solid #fff;
  border-radius: 50%;
  background: transparent;
  /*
   * 白色描边 + 深色投影的双重描边。
   * 【为什么必须这样】明度条拉到最黑时整轮几乎全黑（V=0 时边缘色差为 0），
   * 没有白描边的话小点会完全看不见，用户不知道拖到了哪。
   */
  box-shadow:
    0 0 0 1.5px rgb(0 0 0 / 45%),
    0 1px 4px rgb(0 0 0 / 60%);
  pointer-events: none;
}

/* 「重置为白色」 */
.cp__reset-white {
  padding: 4px 10px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-panel-2);
  color: var(--ui-text-dim);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 140ms ease, color 140ms ease;
}

.cp__reset-white:hover {
  background: var(--ui-panel);
  color: var(--ui-text);
}

/* 竖直明度条 */
.cp__bar {
  position: relative;
  flex: none;
  width: 22px;
  height: 120px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
  cursor: ns-resize;
  touch-action: none;
}

.cp__bar-knob {
  position: absolute;
  left: 50%;
  width: 26px;
  height: 8px;
  border: 2px solid #fff;
  border-radius: 4px;
  background: transparent;
  box-shadow: 0 1px 4px rgb(0 0 0 / 60%);
  transform: translate(-50%, -50%);
  pointer-events: none;
}

/*
 * 窄屏降级（用户明确要求兼顾 375px 手机）。
 *
 * 【实测三档】
 *   375px → 抽屉内容区约 298px，120px 色轮 + 22px 明度条 + 12px 间距 = 154px，放得下 → 保持 120px
 *   320px → 内容区约 247px，仍放得下但已显拥挤 → 缩到 96px（两者等高）
 *   280px → 内容区约 211px，横排放不下 → **换行堆叠**，色轮一行、明度条整行一行
 *
 * 【280px 那一档的坑】
 * 初版写 `.cp__bar { width: 100%; height: 22px }`，但 `width: 100%` 是相对
 * .cp__ring-row 的宽度，而换行后 row 变成了 211px —— 实测明度条被拉成 211×22，
 * 配合 `left: 50%` 的滑块一起把页面撑出 32px 横向滚动条。
 * 现在改成**显式的固定高度 + 整行宽度**，且不参与 min-width 拉伸。
 */
@media (width <= 360px) {
  .cp__ring,
  .cp__bar {
    width: 96px;
    height: 96px;
  }
}

@media (width <= 300px) {
  .cp__ring-row {
    flex-direction: column;
    align-items: stretch;
  }

  .cp__ring {
    align-self: center;
  }

  .cp__bar {
    width: auto;
    align-self: stretch;
    height: 22px;
  }

  .cp__bar-knob {
    top: 50%;
    left: auto;
    width: 8px;
    height: 26px;
    border-radius: 4px;
    transform: translate(0, -50%);
  }
}
</style>
