# 阶段 3 补丁 2 报告：修复拖动监听器泄漏

> 状态：**已完成，等待确认后进入阶段 4**
> 你报告的 bug 已修复，并用"注入原 bug 反向验证"证明测试确实能抓住它。

---

## 一、你的定位完全正确，我确认了根因

你指出的位置一字不差。原始代码（`PlayerBar.vue` 的 `attachDrag`）：

```js
// 绑定：挂在 window 上
window.addEventListener('pointermove', move)
window.addEventListener('pointerup', onUp)
window.addEventListener('pointercancel', onCancel)

// 收尾：却从元素 el 上移除  ← 目标不一致，永远清不掉
const finish = (ev, commit) => {
  el.removeEventListener('pointermove', move)
  el.removeEventListener('pointerup', onUp)
  el.removeEventListener('pointercancel', onCancel)
  ...
}
```

**`addEventListener` / `removeEventListener` 必须作用在同一个 `EventTarget` 上**，`window` ≠ `el`，所以解绑静默失败。每次拖动都在 `window` 上永久残留一份 `pointermove`，松手后鼠标一移动就继续调 `scrubTo` → 进度条跟着鼠标走、无法取消。

修复前我用探针实测到的泄漏曲线（每拖一次 +1，从不释放）：

```
第 1 次拖动后: {pointermove: 1}
第 2 次拖动后: {pointermove: 2}
...
20 次拖动后:   {pointermove: 20}   add=20, remove=0
```

---

## 二、我采用了你建议的第一种方案，并做了防复发改造

### 2.1 直接修复
解绑目标改为 `window`，与绑定一致。

### 2.2 但我不想只改这一行 —— 改为"结构上不可能写错"

因为这个同类 bug 在本项目里**已经出现两次**（见下），所以我把"按住拖动"收敛成**唯一实现**：
新增 [`src/composables/pointerDrag.js`](lrc-scroller/src/composables/pointerDrag.js)，`attachPointerDrag()`：

1. **监听目标统一为一个常量** `const target = window` —— 绑与解都基于它，不可能不一致
2. **用登记表记录 `[type, handler]`**，收尾时**遍历登记表**解绑，绝不手写第二份清单
   （手写两次清单，正是"漏掉一个"的根源）
3. **收尾幂等**：`pointerup` 与 `pointercancel` 可能先后都到达，第二次直接 return，
   否则会把已确定的落点覆盖掉
4. **坐标非法返回 `null`（"未知"）而不是 `0`** —— `0` 是"拖到最左端"这个合法落点，
   两者语义不同，混用正是上一次"进度莫名跳回开头"的根源

PlayBar 的**进度条与音量滑杆**都改用这个 helper（它们共用同一份逻辑，所以一起修好）。

---

## 三、你让我检查的其他三处，我逐一查了

| 位置 | 检查结果 | 处理 |
|---|---|---|
| **ColorPicker 色相环** | add / remove **都在元素上，目标一致** → 不会残留监听器。**但有另一个隐患**：`setPointerCapture` 失败时（合成事件、或指针被系统提前释放），拖到元素外松手 → 元素收不到 `pointerup` → `pointermove` **永远留在元素上**，之后不按键、只要鼠标划过色相环颜色就会被改掉 | **已一并改用 `attachPointerDrag`**（同一类病，一起根治） |
| **音量滑杆** | 与进度条共用 `attachDrag` | 自动一起修好，且已单独测试 |
| **StageView 的 touchstart/touchmove** | 用的是 Vue 模板绑定（`@touchstart.passive` / `@touchmove`），由 Vue 统一管理注册与销毁，**不存在配对问题** | 无需改动 |
| **额外发现：SettingsDrawer 的 `pagehide`** | `window.addEventListener('pagehide', settings.flush)` 传的是 Pinia action 引用，每次访问可能得到不同包装函数 → **同样无法移除**（同一类"加了删不掉"） | 已改为具名函数 `onPageHide`，并在 `onBeforeUnmount` 中正确移除 |

**全项目配对审查结果**（脚本自动核对 add/remove 的目标）：

```
SettingsDrawer.vue        window.pagehide            window ✓
SettingsDrawer.vue        document.visibilitychange  document ✓
useKeyboard.js            window.keydown             window ✓
useAudioEngine.js         el.loadedmetadata/error/ended  （见下方说明）
```

`useAudioEngine` 的三个监听器挂在**每次加载音频时新建的 `<audio>` 元素**上，而该元素在换歌时会被丢弃（`audio = null` + `removeAttribute('src')` + `load()`），元素与其监听器一起被垃圾回收 —— **不是泄漏**，无需显式解绑。

---

## 四、你要求的 7 条验收，逐条实测

新增专项套件 `scripts/e2e-drag-leak.mjs`（**28 项通过**）。**关键是：不只测"时间没变"，还直接统计监听器数量** —— 因为"时间没变"有可能因为残留监听器恰好把值设回同一个而假通过。

| 你的验收项 | 实测 |
|---|---|
| **拖动 → 松手 → 继续移动 5 秒，进度条不再跟随，停在松手位置** | 60% 处松手 → 持续划过 5 秒（移动 42 次）→ 时间 **完全不变** ✓ |
| **连续拖动 5 次，每次松手后验证监听器已清理** | 5 次落点全对（18s/36s/9s/51s/27s），**每次 `{pointermove:0, pointerup:0, pointercancel:0}`** ✓ |
| **拖出窗口外 → 松手 → 回窗口内移动，不跟随** | 垂直移出窗口（y=2000）松手 → 落点正确保留 45s；监听器清零；回窗口移动时间不变 ✓ |
| **音量滑杆同样测试** | 拖到 30% 正确；监听器清零；松手后划过音量条**音量不变** ✓ |
| **色相环同样测试** | 拖动改变颜色；监听器清零；**松手后不按键划过色相环，颜色不再变化** ✓ |
| **压力测试：连续 20 次后移动鼠标无反应 + 控制台 0 异常** | 20 次后计数 **归零**；`add=20, remove=0`→ 修复后 **`add=20, remove=20` 完全配对**；移动鼠标时间不变；**0 异常** ✓ |
| **原有 25 项拖动验收全部仍通过** | **25 项全部通过** ✓ |

另外补了几条：
- 触摸设备：触摸拖动松手后监听器清零、指针移动不跟随 ✓
- 拖到进度条左边界之外 → 夹取为 0（回到开头，符合预期）✓
- 基线检查：未拖动时无任何残留监听器 ✓

---

## 五、我做了"注入原 bug 反向验证"

为了确认这套测试**真的能抓住**这个 bug（而不是恰好通过），我把修复临时改回错误版本（`remove` 目标改回 `el`），重新跑测试：

```
✗ 基线：无残留指针监听器            → {"pointermove":1,...}
✗ 一次拖动后监听器全部解绑          → {"pointermove":2,...}
✗ 第二次拖动后仍无泄漏（不累积）    → {"pointermove":3,...}
✗ 拖出窗口外松手后监听器已清理      → {"pointermove":9,...}
✗ 音量拖动后监听器已清理            → {"pointermove":11,...}
✗ 色相环拖动后监听器已清理          → {"pointermove":12,...}
✗ pointermove 的 add 与 remove 次数完全配对 → add=20, remove=0
通过 18 项，失败 10 项
```

计数**逐次累积到 33**、`remove=0` —— 精确复现了你描述的现象。验证完毕后已恢复修复版本（并确认 `BUG 重现` 标记数为 0、`target.removeEventListener` 存在）。

---

## 六、我的测试有 1 处写错（已修正）

"拖出窗口外松手"这条我最初把松手坐标设成 `(-50, -50)`，期望落点是 75%。但实际得到 0s。

排查后确认：**这是正确的夹取行为，不是 bug**。进度条几何是 `left=114, width=981`，而 `clientX=-50` 被浏览器夹到 0：

```
clientX= -50 → raw=-0.167 → ratio=0.000 → 0.0s
clientX=   0 → raw=-0.116 → ratio=0.000 → 0.0s
clientX= 114 → raw= 0.000 → ratio=0.000 → 0.0s   ← 进度条左边界
clientX= 500 → raw= 0.393 → ratio=0.393 → 23.6s
```

`-50` 在进度条**左边界之外**，夹取为 0 等同"拖到最左端＝回到开头"，与其他播放器一致。**是我的断言写错了**（既要"移出窗口"又期望"水平坐标落在 75%"，自相矛盾）。
已改为：**只把垂直坐标移出窗口**（y=2000）验证"元素外/窗口外的松手能被 window 监听到"，并**额外补一条**断言"拖到左边界外确实回到 0"，把这个夹取语义也钉住。

---

## 七、全量回归（9 个套件，共 573 项）

| 套件 | 结果 |
|---|---|
| `test-core.mjs` | **277 项通过** |
| `verify-samples.mjs` | **7/7 通过** |
| `e2e-drag.mjs`（原 25 项） | **25 项通过** |
| `e2e-drag-leak.mjs`（本次新增） | **28 项通过** |
| `e2e-fade.mjs` | **49 项通过** |
| `e2e-stage0.mjs` | **31 项通过** |
| `e2e-stage1.mjs` | **41 项通过** |
| `e2e-stage2.mjs` | **63 项通过** |
| `e2e-stage3.mjs` | **52 项通过** |

`dist/index.html` 182.43 kB（gzip 64.09 kB），构建无报错。

---

## 八、请你复验

```bash
pnpm dev     # 打开 http://localhost:5173/
```

1. **拖动进度条 → 松开左键 → 继续随便移动鼠标** → 进度条应停在松手位置，不再跟随。
2. **连续快速拖 10 次以上**，然后松手乱移 → 不应有任何反应。
3. 音量滑杆、色相环同样试一遍。
4. 触摸屏上试一遍。

---

## 九、下一步

这条修完即可进入**阶段 4：展示/全屏模式**（`F` / `Esc`、隐藏 UI、鼠标静止 2 秒控制条淡出、iOS 降级为伪全屏）。虚化按你说的不动。
