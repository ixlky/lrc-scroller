# 任务 A + B 架构草图（待确认，未写代码）

> 先说一个**必须先讲的事实**，它影响任务 B 的排期。

---

## 零、前置发现：`core/beat.js` 没有任何测试

你说"节拍点由 core/beat.js 生成（已测过）"。**实测不成立**：

```
scripts/test-core.mjs:80        import { ... } from '../src/core/beat.js'   ← 有 import
scripts/test-core.mjs 的 group 列表（39 个组）  ← 没有任何 beat / 节拍组
全项目 grep "beatTimes(" / "nearestBeat(" 调用  ← 0 处（除 import 本身）
```

也就是说 `beat.js` 的 236 行（校验器 / 网格生成 / 二分吸附 / canSnap）
**一行断言都没有**。它的文件头注释写得很认真（列了 3 个正确性陷阱），
但那些陷阱目前只靠"写得小心"保证，不靠测试。

**建议**：任务 B 动手前，先给 `beat.js` 补一组纯函数单测（约 20 项），
否则我在 `record()` 里接吸附时**没有可信的下层**——
吸附算错了会表现为"用户打的时间被静默改写"，正是最难发现的那类问题。

**这条要不要做，请你定。** 不补也能做，但我会在报告里标注"吸附逻辑建立在未测的纯函数上"。

---

# 任务 A：应用打轴结果

## A1. 数据流总览

```
┌─ 用户点「应用到歌词」─────────────────────────────────────┐
│                                                          │
│  ① 取快照（深拷贝，用于 3 秒内撤销）                       │
│     snapshot = { lines, droppedLines, tapped,            │
│                  tappedKind, undoStack,                  │
│                  editingIndex, lastTappedIndex }         │
│                                                          │
│  ② lyricsStore.applyTapped(tapping.tapped)               │
│     ├ 遍历 droppedLines，与 tapped 一一对应               │
│     ├ 打了时间的 → 生成新行 { t, rawT: t, text, ... }     │
│     ├ 没打的 → 留在新的 droppedLines 里                   │
│     ├ 与原 lines 合并                                     │
│     ├ 按 t 升序排序（相同 t 用 sourceLine 稳定）           │
│     ├ 重新分配 id = L0, L1, ...                          │
│     ├ refreshWarnings()（可能新增"重复时间"警告）          │
│     └ 返回 { applied, remaining }                        │
│                                                          │
│  ③ tappingStore.consumeAll()                             │
│     └ tapped=[] / undoStack=[] / enabled=false            │
│       tappedKind='lines' / editingIndex=0 / lastTapped=-1 │
│                                                          │
│  ④ 启动 3 秒撤销窗口                                       │
│     ├ toast: 「已应用 N 行 · 撤销」                       │
│     └ 3 秒后 snapshot = null（此后不可撤销）               │
└──────────────────────────────────────────────────────────┘
```

## A2. 合并逻辑的**关键细节**（我先验证过的）

### ① `rawT = t` 是对的，但只对了一半

你要求"新行的 rawT = t（让 offset 调整对它也生效）"。方向正确，但要注意：

```js
// withOffset 里：t = rawT - offsetSec
// 所以 rawT = t 意味着"按当前 offset=0 记下的时间"
```

如果用户**先设了 offset**（比如 +500ms）、再打轴，那么：

| 步骤 | 结果 |
|---|---|
| offset = +500ms，用户听到第 3 秒按下空格 | `player.currentTime = 3.0` |
| 存 `t = 3.0`、`rawT = 3.0` | |
| 之后 `setOffset(0)` 重算 | `t = rawT - 0 = 3.0` ← **没变**，但用户期望的是"回到 3.5" |

**但这个行为是对的**：用户打轴时听的是什么，就该是什么。
offset 是"整体平移歌词对齐音频"，打轴是"在当前对齐下记录时间"。
所以 `rawT = t` 是正确的，我按你说的做。
**只是要知道**：之后调 offset 会把这个新行一起平移 —— 这正是你要的"对它也生效"。

### ② 新行必须有 `sourceLine`，否则同时间行的排序会错

`withOffset` 的排序是 `(a.t - b.t) || (a.sourceLine - b.sourceLine)`。
新行若没有 `sourceLine`，`undefined - number = NaN`，排序结果**依赖输入顺序**。

**实测证据**（源文件顺序应为 `原行B(2) → 新5 → 新7`）：

```
缺 sourceLine: ["新7", "原行B", "新5"]     ← 错，顺序由输入顺序决定
有 sourceLine: ["原行B", "新5", "新7"]     ← 对，按文件位置稳定
```

（2 个元素时两者恰好同序，**看不出问题** —— 这正说明它容易漏掉。
打轴时多行落在同一拍上很常见，所以必须补 `sourceLine`。）

`droppedLines[i].line` 正好是原始文件行号 —— 直接拿来当 `sourceLine` 最自然
（它本来就表示"这行在文件里的位置"）。

### ③ 新行的完整字段（对齐 `parseLrc` 产出的形状）

```js
{
  id: '',                      // 排序后统一分配
  t: tapped[i].t,
  rawT: tapped[i].t,           // 你要求的
  text: droppedLines[i].text,
  empty: droppedLines[i].text === '',   // 与 parser 一致
  beat: tapped[i].beat,        // 节拍序号（任务 B 会写入）
  locked: tapped[i].locked,
  sourceLine: droppedLines[i].line,     // 见 ②
  duplicateOf: [],
}
```

### ④ 已应用的新行，之后还能被"重新打轴"吗？

应用后 `droppedLines` 只剩没打的行。**新行进了 `lines`**，
而方案 C 的目标判定是"droppedLines 非空 → 打 dropped"。

所以：**应用后如果还有没打完的行，再进打轴模式时目标是那些剩下的行**
（`tapped` 里的下标会重新对齐到新的 `droppedLines`）。
已应用的行**不能被重打**（它们在 lines 里，方案 C 的已知代价）——这与你的决策一致。

## A3. 两套撤销的隔离（你强调的第「重要」点）

| | Z 键撤销 | 应用撤销 |
|---|---|---|
| 数据 | `tappingStore.undoStack` | `applySnapshot`（临时快照） |
| 改动 | 只改 `tapped` | 还原 `lines` + `droppedLines` + `tapped` |
| 生效期 | 打轴模式存续期间 | **仅 3 秒** |
| 应用后 | **无反应**（草稿已清空） | 3 秒内有效 |

**实现上的隔离点**：

- 快照存在 `useTapping` 的模块级变量里（**不进 store**），
  因为它是个"临时票据"，不该被 `_save()` 持久化。
  刷新页面后快照丢失 = 不可撤销，符合"3 秒窗口"的语义。
- 应用后 `undoStack` 被清空，所以 Z 键自然无反应（`tapping.undo()` 返回 null）。
  **不需要给 Z 键加"应用后禁用"的分支** —— 靠数据自然成立，少一个状态就少一处不一致。

## A4. 快照的生命周期

```js
let applySnapshot = null      // 模块级，不进 store
let applyTimer = 0

function apply() {
  ...
  applySnapshot = deepClone({ lines, droppedLines, tapped, tappedKind, undoStack, editingIndex, lastTappedIndex })
  if (applyTimer) clearTimeout(applyTimer)
  applyTimer = setTimeout(() => { applySnapshot = null; applyTimer = 0 }, 3000)
}

function undoApply() {
  if (!applySnapshot) return false
  // 整体还原
  lyricsStore.restoreFromSnapshot(applySnapshot)   // 见下
  tappingStore.restoreFromSnapshot(applySnapshot)
  applySnapshot = null
  clearTimeout(applyTimer)
  return true
}
```

**「3 秒后按钮消失」怎么实现**：
toast 上的「撤销」按钮绑 `undoApply`。
3 秒后 toast 自己消失（现有 toast 机制有超时），按钮随之不可点。
即使 toast 还在，`applySnapshot === null` 也会让 `undoApply` 返回 false ——
**双保险**：视觉消失 + 逻辑失效。

## A5. 深拷贝怎么做

`lines` 是对象数组，元素含 `duplicateOf: []`。快照必须深到能还原。

用 `structuredClone`（原生，Node 18+ / 现代浏览器都有）。**实测结果**：

```
structuredClone 可用:              true
深拷贝保真（含 duplicateOf 数组）: true
改副本不影响原对象:                true
null 元素保留（tapped 里的空位）:   true
lastTappedIndex = -1 保留:         true
```

最后两条是选它而不是 `JSON.parse(JSON.stringify())` 的理由：
`tapped` 数组里有 `null`（没打的行），而 `lastTappedIndex` 会是 `-1` ——
`structuredClone` 原样保留，不会出现"`undefined` 被丢弃"这类意外。

## A6. 需要你确认的一个边界

**「没打完的行」应用后，`editingIndex` 该是什么？**

我的方案：`consumeAll()` 把 `editingIndex` 归 0、`tappedKind` 归 `'lines'`。
但此时若 `droppedLines` 仍非空，下一轮进打轴时 `tapTargetKind` 是 `'dropped'`、
`ensureSize` 会发现 kind 从 `'lines'` 变 `'dropped'` → **重置草稿**。

这没问题（草稿本来就清空了），但会触发**"歌词已更换，打轴草稿已重置"的 toast** ——
而实际上不是"歌词已更换"，是"应用了上一次的结果"。文案会误导。

**两个选项**：
- (a) `consumeAll()` 里把 `tappedKind` 设成 `tapTargetKind`（当前实际目标），
  这样不会误判"目标变了"，也就不弹那条 toast。
- (b) 你要求的"`tappedKind` 归 `'lines'`"，那再进打轴时会弹"草稿已重置"。

**你的原话是「tappedKind 归 'lines'」**，但那条 toast 文案会是错的。
**请选 (a) 还是 (b)？** 我倾向 (a)（行为等价 + 文案正确），
但它偏离了你的字面要求，所以必须问。

---

# 任务 B：节拍网格与吸附

## B1. 吸附在 `record()` 里的位置

```
record(t) {
  ensureSize()
  if (n === 0) return { index: -1, ... }
  i = editingIndex
  
  ┌─ 新增：吸附 ─────────────────────────────┐
  │ const snapped = snapTime(t)              │
  │ // snapped = { t: 1.25, beat: 5 } 或 null │
  │ t = snapped ? snapped.t : t              │
  │ beat = snapped ? snapped.beat : null     │
  └──────────────────────────────────────────┘
  
  // 以下保持原样（撤销点、写入、推进编辑行）
  undoStack.push({...})
  tapped[i] = { t, beat, locked: false }     ← beat 从 null 改成实际值
  ...
}
```

**为什么会放在 `record()` 里而不是 `useTapping.tap()`**：
你说"在 tappingStore.record() 里"，我同意 —— 但要注意
**store 因此需要读 settings**。现在 `tappingStore` 已经 import 了 `lyricsStore`，
再加 `settingsStore` 不破坏分层（store 读 store 是既有的做法）。

**`snapTime(t)` 放哪**：
不建议塞进 `tappingStore` 内部当私有函数 —— 它需要 `beatTimes()` 生成网格，
而每次打点重新生成 64 个节拍是浪费。建议在 `useTapping` 里**缓存网格**：

```js
// useTapping 里
const grid = computed(() => {
  const s = settings.settings.sync
  if (s.snap === 'none' || !s.bpm) return []
  const v = validateBpm(s.bpm)
  if (!v.ok) return []
  return beatTimes({ bpm: v.value, firstBeatMs: s.firstBeatMs, beats: 512 })
})
```

然后 `record()` 接收一个可选的 `snapFn` 参数，或由 `useTapping.tap()` 算好传进去。

**两个方案的取舍**：
- **(甲) store 内部自己算**：`record()` 里读 settings + 调 beatTimes。
  简单，但每次打点重算网格（512 拍 × 每次按键，实测可忽略）。
- **(乙) 调用方传吸附结果**：`tap()` 算好 `{t, beat}` 传给 `record()`。
  store 保持"不依赖 settings"，但 `record()` 的签名变了。

**我倾向 (甲)**：简单、store 已经有读其他 store 的先例、
512 拍的重算成本实测微不足道（下面有数据）。但它让 store 依赖 settings。
**请选。**

## B2. `locked` 保护（B4）

你的要求很清楚，我复述一遍确保无歧义：

| 场景 | 行为 |
|---|---|
| 改 BPM | **不回头覆盖**已记录的行（`tapped` 里的值不动） |
| 用户重新按空格**覆盖同一行** | 重新按吸附规则处理（**不看** locked） |

第二点是关键：`locked` 只影响"自动重吸附"，不影响"用户主动重打"。
实现上很自然 —— `record()` 本来就是"用户主动写这一行"，
`locked` 只在**批量重吸附**时有意义，而本轮**没有批量重吸附**。
所以：**`record()` 里完全不读 `locked`**，直接覆盖。

`canSnap()` 在 `beat.js` 里已存在，本轮**不会被调用**（留给第 7 步的批量吸附）。
我会在注释里写明"这不是漏了，是第 7 步才用"。

## B3. 节拍网格可视化（B2）

```
.stage__untimed.is-tapping 里加一层 .stage__beat-grid
  └ 每个节拍 → 一条竖线或一个小点，位置 = 节拍时间映射
```

**映射方式**（这里有个必须先定的问题）：

舞台上**没有可视时间轴** —— 打轴面板是一行行文本，不是时间轴。
所以"节拍点映射到屏幕位置"缺少锚点。三种可能：

| 方案 | 映射 | 问题 |
|---|---|---|
| (i) 按**编辑行**锚定 | 编辑行位置 = 当前播放头，节拍相对它上下排 | 编辑行会随打点移动，网格跟着跳 |
| (ii) 独立时间轴条 | 面板右侧加一条竖直时间轴，节拍在其上 | 需要新 UI 区域，超出"竖线/小点"的描述 |
| (iii) 只显示**最近节拍的高亮** | 不画全网格，只在编辑行旁标"下一拍在 0.3 秒后" | 最省事，但不是"网格" |

**你的原话是"渲染节拍标记（竖线或小点），位置按节拍时间映射"** ——
这句话预设了存在一个时间→位置的映射，但打轴面板里没有。

**请明确**：你要的是 (i) / (ii) / (iii) 哪一种？
或者你心里的"位置映射"是别的形式（比如整块面板按时间等分）？

**这条不定，B2 无法开工。** 我建议 (ii)（独立时间轴条最直观，
打轴时能直接看到"我打的点落在第几拍上"），但它是新增 UI，需要你点头。

## B4. 节拍网格的显示条件

你已明确：`打轴模式 + BPM 有效 + 目标是 droppedLines`。
补两条我理解中的边界，请确认：
- 目标切到 `lines`（纯 lrc）时**不显示** —— 你已说了
- BPM 非法（0 / 文本 / 负数）时**不显示**，且不报错（设置面板已有校验提示）

---

## 改动清单

### 任务 A
| 文件 | 改动 | 量 |
|---|---|---|
| `stores/lyricsStore.js` | `applyTapped(tapped)` + `restoreSnapshot(s)` | ~70 行 |
| `stores/tappingStore.js` | `consumeAll()` + `restoreSnapshot(s)` | ~30 行 |
| `composables/useTapping.js` | `apply()` / `undoApply()` / 快照 + 3 秒定时 | ~70 行 |
| `components/PlayerBar.vue` | 「应用到歌词」按钮（打轴模式显示） | ~20 行 |
| `scripts/e2e-stage5-tap.mjs` | 补 8 组断言 | ~110 行 |

### 任务 B
| 文件 | 改动 | 量 |
|---|---|---|
| `scripts/test-core.mjs` | **补 beat.js 单测**（若你同意） | ~150 行 |
| `components/settings/BeatPanel.vue` | 新建 | ~130 行 |
| `components/settings/SettingsDrawer.vue` | 接入新分组 | ~15 行 |
| `stores/tappingStore.js` | `record()` 加吸附 | ~35 行 |
| `components/StageView.vue` | 节拍网格渲染 | ~50 行（取决于 B3 方案） |
| `scripts/e2e-stage5-beat.mjs` | 新建（或并入 tap） | ~120 行 |

---

## 请你确认 5 点

1. **`core/beat.js` 补纯函数单测**（~20 项）—— 做还是不做？
2. **任务 A 第 6 点**：应用后 `tappedKind` 设成 `tapTargetKind`（(a)，不误报 toast）
   还是按你原话归 `'lines'`（(b)，会弹"草稿已重置"的错文案）？
3. **任务 B 的吸附实现**：store 内部自己算（甲）还是调用方传结果（乙）？
4. **B3 节拍网格怎么映射到屏幕**：(i) 锚定编辑行 / (ii) 独立时间轴条 / (iii) 只高亮最近拍？
   —— **这条不定，B2 无法开工**
5. 两个任务的提交方式：**分两次提交**（A 先合、验完再 B）还是一次提交两个 commit？
   我建议**分两次**：A 是补齐缺失出口、风险低且能立刻真机验证；
   B 依赖你对第 4 点的决定，可能还要调整。
