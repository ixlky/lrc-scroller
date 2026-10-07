<script setup>
/**
 * 一行「没有时间标签的文本」。
 *
 * 【为什么不复用 LyricLine.vue】
 * 两者数据类型不同（实测）：
 *   lyricLine   { id, t, rawT, text, empty, beat, locked, sourceLine, duplicateOf }
 *   droppedLine { line, text, reason }        ← 没有 t / id / empty / beat
 * 而且 LyricLine 会写 `data-line-index`，那个属性是
 * useAutoScroll.measure() 采集行几何的依据（`track.querySelectorAll('[data-line-index]')`）。
 * 这些行不在轨道里，**不该带索引** —— 让"不该有索引的元素带上索引"是个隐患
 * （阶段 5 第 2 步选容器时就是为了避开这个）。
 *
 * 所以这里只做三件事：显示文字、挂 is-editing / is-tapped、不写任何 data-* 索引。
 *
 * 【与 LyricLine 的类名保持一致，便于共用样式语言】
 *   .is-editing → 左侧竖条（下一行要打哪）
 *   .is-tapped  → --lrc-color-tapped + 放大（刚打完的那行）
 * 但**不挂 .is-active** —— 这些行没有时间，不存在"正在播放"。
 */

const props = defineProps({
  /** @type {import('vue').PropType<{line:number,text:string,reason:string}>} */
  row: { type: Object, required: true },
  /** 在 droppedLines 里的下标（仅用于 key，不写进 DOM） */
  index: { type: Number, required: true },
  editing: { type: Boolean, default: false },
  tapped: { type: Boolean, default: false },
})
</script>

<template>
  <p
    class="stage__untimed-line"
    :class="{
      'is-editing': editing,
      'is-tapped': tapped,
    }"
  >
    {{ row.text }}
  </p>
</template>
