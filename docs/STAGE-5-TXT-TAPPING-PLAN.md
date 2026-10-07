# 方案 C：让 txt（无时间标签的行）也能打轴 —— 设计说明（待确认，未写代码）

> 本轮**没有改动任何代码**。以下是设计 + 需要你拍板的点。

---

## 零、根因确认

你的定位准确。我核对了代码路径：

```
tappingStore.ensureSize()  →  按 useLyricsStore().lines.length 对齐
tappingStore.record(t)     →  const n = this.tapped.length; if (n === 0) return { index: -1, ... }
useTapping.tap()           →  if (r.index < 0) return null   ← 什么都没发生
PlayerBar                  →  totalCount = lyrics.lines.length = 0
                              → 显示「打轴中 {editingIndex+1}/{0}」=「打轴中 1/0」
```

**"打轴中 1/0" 这个显示本身就是线索**：它说明 `editingIndex` 是 0 而 `totalCount` 是 0 —— 两个数字来自同一套错误假设。

---

## 一、目标行数组的判定（第 1 点，**需要你三选一**）

### 三种数据形态

| 形态 | `lines` | `droppedLines` | 现状 |
|---|---|---|---|
| (a) 纯 lrc | N 行 | 0 | ✅ 打 `lines`，正常 |
| (b) 纯 txt | 0 | M 行 | ❌ **打不了轴**（本轮要修的主路径） |
| (c) 混合 | N 行 | M 行 | ❓ 歧义 |

### 混合文件的真实来源（实测）

我跑了真实解析器，混合文件的形态是：

| 输入 | lines | droppedLines |
|---|---|---|
| `[00:12.00]第一句` / `第二句` / `[00:30.00]第三句` / `第四句` | 2 行（`第一句` t=12、`第三句` t=30） | 2 行（`第二句` line=2、`第四句` line=4） |

即「有时间标签的行」+「忘了打时间标签的行」，且**两段各自内部保持文件顺序**，
但**行号信息**保留在 `droppedLines[].line` 里（`line: 2` 和 `line: 4`）。

**更正我之前的一个说法**：我第一次推演时说"顺序会变成先全部有时间的、再全部没时间的"，
那是对**选项 C** 的描述。实际选项 B 只打 `droppedLines`，顺序就是文件里
`第二句 → 第四句`，**是自然顺序，不会跳**。这点在下面 B/C 对比里已修正。

### 三个选项

#### 选项 A：只打 `lines`（现状）

| 形态 | 目标数组 |
|---|---|
| (a) | `lines` |
| (b) | **空 → 仍然打不了轴** |
| (c) | `lines`（"第二句"永远打不上） |

**否决。** 等于没修 (b)。

#### 选项 B：打「还没时间的行」，没有则打 `lines` 【推荐】

规则一句话：**打轴永远作用于"没有时间的行"；如果所有行都有时间，才作用于 `lines`。**

| 形态 | 目标数组 | 理由 |
|---|---|---|
| (a) | `lines` | 没有 dropped → 落到 lines |
| (b) | `droppedLines` | ✅ 主路径修好 |
| (c) | `droppedLines` | 缺时间的行才是需要打轴的 |

**为什么推荐它** —— 直接引用你自己的判断："**有 lrc 的人时间已经定了，不需要打轴**"。
(c) 里的 `lines` 已经有时间了，按这个判断它们不需要打轴；真正需要补的是 dropped 那几行。

**已知局限（必须写清楚）**：在混合文件里，用户**无法重打已经有时间的那几行**。想改只能手改文件。我认为这符合"有 lrc 的人不需要打轴"的前提，但**这是你的判断，得你确认**。

#### 选项 C：两段都打（先 lines 后 droppedLines，一次空格走一行）

| 形态 | 目标数组 |
|---|---|
| (a) | `lines` |
| (b) | `droppedLines` |
| (c) | `lines` + `droppedLines`（共 N+M 行，顺序是"先全部有时间的，再全部没时间的"） |

覆盖最全，但有两个真实代价：

1. **会覆盖已有时间**：空格打在"第一句"上会把它 12 秒的既有时间覆盖掉。用户本来只是想补第二句，却顺手改掉了第一句 —— 除非再引入"跳过本行"的概念，那是第 5 步 `SyncPanel` 的范围。
2. **顺序是"两段拼接"而不是文件顺序**：C 会给出
   `第一句(12s) → 第三句(30s) → 第二句 → 第四句` ——
   用户按空格时会在补完 `第四句` 后**跳回文件中间**去补 `第二句`，位置感断裂。

**不推荐**（本轮），但如果"能重打任何一行"对你比"操作直觉"更重要，它是对的选法。

### 请你拍板

**选 B 还是 C？**（A 已被否决）

---

## 二、StageView 的视觉呈现（第 2 点）

### 现状与问题

| 项 | 现状 | 打轴时的问题 |
|---|---|---|
| 字号 | `0.72 × --lrc-font-size` | 盯着看太小 |
| 颜色 | `--lrc-color-normal` 的 78% 透明 | 太淡 |
| 位置 | 有轨道时占**底部 45%** | 混合文件下打轴区域局促 |
| 滚动 | `overflow-y: auto` | **编辑行移出可视区后看不见**（100 行 txt 打到第 30 行就找不到光标了） |

最后一条是最严重的：现在没有任何"把编辑行滚进视野"的逻辑。

### 提议

**① 打轴模式下，`.stage__untimed` 切成"打轴面板"形态**

```
.is-tapping（新的容器类，由 tapping.enabled && 目标是 droppedLines 时挂上）
  ├─ 撑满整个舞台（不再只占底部 45%）
  ├─ 字号切到正常歌词大小（1.0 × --lrc-font-size）
  ├─ 颜色恢复不透明
  └─ 标题行改成「打轴中 · 第 3/24 行」而不是现在的「N 行文本没有时间标签」
```

理由：纯 txt 场景下舞台本来就只有这块内容，撑满是自然的；混合场景下打轴时用户也不该同时盯着滚动歌词。

**② `.stage__untimed-line` 支持两个类**

| 类 | 效果 | 说明 |
|---|---|---|
| `.is-editing` | 左侧 3px 竖条（复用 `.lyric-line.is-editing` 的样式语言） | 下一行打哪里 |
| `.is-tapped` | `--lrc-color-tapped` + 放大 | 刚打完的行 |

**不挂 `.is-active`** —— droppedLines 没有时间，不存在"正在播放"，这是对的。

**③ 编辑行自动滚进视野**

`editingIndex` 变化时对该行调 `scrollIntoView({ block: 'nearest' })`。
用 `nearest` 而不是 `center`：已经在视野内时就不动，避免"每打一行整块跳一下"。

**④ 渲染方式：新建 `UntimedLine.vue`（不复用 `LyricLine.vue`）**

实测两种数据的**形状不同**：

```
lines[].        { id, t, rawT, text, empty, beat, locked, sourceLine, duplicateOf }
droppedLines[]. { line, text, reason }        ← 没有 t / id / empty / beat
```

所以 `LyricLine.vue` 不能直接复用：它读 `line.empty`（dropped 没有）、
写 `data-line-index`（dropped 不该有，见下）。

`LyricLine` 会写 `data-line-index`，而 `useAutoScroll.measure()` 用
`track.querySelectorAll('[data-line-index]')` 收集行几何。
虽然 `.stage__untimed` 在轨道**之外**、现在不会被查到，但让"不该有索引的元素带上索引"是个隐患
（第 2 步讨论容器选择时就是为了避开这个）。

新建一个 ~40 行的小组件，只负责显示 + 两个类，**不写任何 data-* 索引**。

---

## 三、退出打轴模式后 tapped 与 droppedLines 的关系（第 3 点）

**结论：保持"界面不变"是对的，但要给一句提示。**

理由：
- `tapped` 是**草稿**，`droppedLines` 是**事实**。草稿没被应用前，事实不该变 —— 这个分层是对的。
- 但如果用户打了 20 行、退出后什么提示都没有，他会以为白打了。

**提议**：退出打轴模式时，若 `tappedCount > 0`，弹一条 toast：

> 已打 20/24 行（草稿已保存）
> 应用到歌词是第 5 步的功能，当前尚未实现

**遵守你的范围约束**：本轮**不做**"应用"动作，只做提示。
如果连提示也不想加，我就只改 `PlayerBar` 的进度显示 —— 请你定。

---

## 四、`ensureSize()` 怎么对齐（第 4 点）

### 提议：加两个 getter + 一个 state 字段

```js
getters: {
  /** 目标行数组：有"没时间的行"就打它们，否则打有时间标签的行 */
  targetRows() {
    const lyrics = useLyricsStore()
    return lyrics.droppedLines.length > 0 ? lyrics.droppedLines : lyrics.lines
  },
  /** 当前目标是谁，用于 ensureSize 判断"切换了目标" */
  targetKind() {
    return useLyricsStore().droppedLines.length > 0 ? 'dropped' : 'lines'
  },
  totalCount() { return this.targetRows.length },
}

state: {
  /** 当前 tapped 数组对应的是哪个目标（'lines' | 'dropped'） */
  tappedKind: 'lines',
}
```

### 【重要】`ensureSize()` 有个现存隐患，方案 C 会让它变成真 bug

现在的实现**只比较长度**：

```js
ensureSize() {
  const n = useLyricsStore().lines.length
  if (this.tapped.length === n) return      // ← 只比长度
  ...
}
```

**这个隐患我实测复现了**：

```
文件1（纯 lrc）: lines=2  dropped=0   → 目标 = lines，草稿长度 2
文件2（纯 txt）: lines=0  dropped=2   → 目标 = droppedLines，长度也是 2
→ 旧的 ensureSize 只比长度：2 === 2 → **不会重新对齐**
→ 结果：文件2 的 droppedLines[0] 拿到的是文件1 的 lines[0] 的草稿时间
```

用户表现为：导入新文件后，某些行"莫名其妙已经有时间了"。

所以 `ensureSize` 必须**同时比较 kind 与长度**：

```js
ensureSize() {
  const n = this.targetRows.length
  const kind = this.targetKind
  if (this.tapped.length === n && this.tappedKind === kind) return
  // 目标变了 → 重新开一份草稿（不保留旧目标的记录，因为下标含义完全不同）
  this.tapped = new Array(n).fill(null)
  this.tappedKind = kind
  this.editingIndex = 0
  this.lastTappedIndex = -1
  this.undoStack = []
}
```

**这里是"重新开草稿"而不是"截断保留"**，与现在的行为**不同**，需要你确认：
现在换歌词时是"保留前 min(n, old) 项"，但那在方案 C 下是错的 ——
`lines[0]` 和 `droppedLines[0]` 是**完全不同的行**，保留等于张冠李戴。

### 其余要跟着改的地方

| 位置 | 改动 |
|---|---|
| `useTapping.tap()` | 越界判断用 `targetRows.length`；`scrollToIndexProgrammatically` 在 dropped 目标下不能用（那是轨道内的行），改成 `scrollIntoView` |
| `useTapping.undo()` | 同上 |
| `nudge()` | 只改 `tapped[i].t`，与目标数组无关，基本不用改 |
| `restore()` | 恢复 `tappedKind`；`targetKind` 与恢复的不一致时丢弃草稿 |

---

## 五、两个顺手修（第 4 点之外的"三、四"）

### 1. `totalCount === 0` 时不再显示 "1/0"

**提议**：`PlayerBar` 里

```
totalCount > 0  →  「打轴中 3/24」
totalCount === 0 →  「打轴中 · 无行可打」
```

并且此时按空格不产生任何动作（现有 `record()` 已经会返回 `index:-1`，行为已经是对的，只是显示要改）。

### 2. `SettingsDrawer` 的「快速打轴」死按钮

你给了两个选项。**我建议改成"打开打轴模式"（进入打轴 + 自动关闭抽屉）**，而不是删掉：

- 对**主用户（txt 用户）**来说，导入 txt 后最显眼的入口就是设置面板里的这一项。
- 播放条上的「打轴」按钮很小、在左下角，txt 用户不一定注意到。
- 点它 → 进打轴 + 关抽屉 → 用户直接看到撑满舞台的打轴面板（配合第 2 点的视觉改动），路径最短。

**删掉更简单**（一行），功能入口就只剩播放条上的按钮。**请你选**：改成功能按钮 / 直接删。

> 同一个 section 里的「节拍网格」按钮**不动** —— 节拍网格是第 6 步，还没做，它的提示仍然准确。按你的范围约束不顺手改。

---

## 六、测试要补（本轮）

| # | 用例 | 断言 |
|---|---|---|
| 1 | 导入纯 txt → 进打轴 → 按空格 | `tapped[0] !== null`、`editingIndex === 1` |
| 2 | 连按 N 次 | N 行时间**严格递增**、无重复 |
| 3 | 退出打轴 → 再进入 | `tapped` 保留（长度与内容一致） |
| 4 | 混合文件 | **按第 1 点的最终决策**断言目标数组与行数 |
| 5 | `totalCount === 0` | 不出现 "1/0" 字样 |
| 6 | 目标切换（先导入 lrc 打几个点，再导入 txt） | 草稿被重置、不会张冠李戴（对应第四点的隐患） |

第 6 条是我加的保护 —— 它专门锁住 `ensureSize` 那个"只比长度"的隐患。

---

## 七、改动清单

| 文件 | 改动 | 量 |
|---|---|---|
| `stores/tappingStore.js` | 加 `targetRows` / `targetKind` getter、`tappedKind` state、`ensureSize` 重写 | ~50 行 |
| `composables/useTapping.js` | 越界判断按目标数组；dropped 目标下改用 `scrollIntoView` | ~40 行 |
| `components/UntimedLine.vue` | **新建**，~40 行 | +40 行 |
| `components/StageView.vue` | 用 UntimedLine + 挂 `.is-tapping` / `.is-editing` / `.is-tapped` + 滚进视野 | ~50 行 |
| `components/PlayerBar.vue` | `totalCount === 0` 的显示 | ~5 行 |
| `components/settings/SettingsDrawer.vue` | 「快速打轴」按钮 | ~5 行 |
| `scripts/e2e-stage5-tap.mjs` | 补上表 6 组用例 | ~120 行 |

**不动**：`useKeyboard` 的空格分派（上轮刚修好）、`.is-active` 的语义。

---

## 八、请你确认 4 点

1. **第 1 点三选一：B（打"没时间的行"，没有则打 lines）还是 C（两段都打）？** —— 这是最关键的
2. **`ensureSize` 改成"目标变了就重新开草稿、不保留旧记录"**（与现在"截断保留"的行为不同，但方案 C 下必须如此）—— 同意吗？
3. **第二点的视觉改动**：打轴时把 `.stage__untimed` 撑满舞台 + 字号切正常 + 编辑行自动滚进视野 —— 同意吗？还是保持小字区只加两个类？
4. **「快速打轴」按钮**：改成功能按钮（进打轴 + 关抽屉）还是直接删？**退出打轴的 toast 提示**要不要加？
