# BookDex 改动地图

本文档用于后续修改 `bookdex-plugin` 时快速定位代码，避免在单文件里误改命令分发、会话缓存或 Git 结构。

## Git 结构

- `plugins/bookdex-plugin` 是独立 Git 仓库
- 宿主仓库 `/opt/Yunzai` 当前不跟踪 `plugins/bookdex-plugin` 目录
- 后续提交应在 `plugins/bookdex-plugin` 仓库内完成
- 不要删除或重建 `plugins/bookdex-plugin/.git`
- 不要把插件目录移动、改名、转成子模块

## 入口关系

- 插件入口: `index.js`
- 入口导出: `apps = { bookdex: BookDex }`
- 主逻辑文件: `apps/bookdex.js`
- 当前业务、抓取、搜索、渲染、命令规则几乎都集中在 `apps/bookdex.js`

## 宿主如何加载

- Yunzai 会扫描 `plugins/*`
- 如果插件目录存在 `index.js`，就按入口文件加载
- `bookdex-plugin/index.js` 再导出 `apps/bookdex.js`
- `BookDex` 通过 `extends plugin` 挂到 Yunzai 插件系统

## 文件职责

### `apps/bookdex.js`

可按以下块理解：

- 顶部常量区
  - 插件目录
  - 数据目录
  - 临时目录
  - 字体/背景资源路径

- 基础工具区
  - 目录创建
  - 标题清洗
  - 文本切页
  - HTML 转义
  - 长消息回复

- 书籍导入区
  - `inferTitleFromTxt`
  - `splitDocxBooks`
  - `rebuildBooksFromInbox`
  - `loadIndex`
  - `saveIndex`

- 图片渲染区
  - `renderHelpImage`
  - `textPageHtml`
  - `renderTextAsImages`
  - `pickBgDataUri`
  - `pickFontDataUri`

- 各类数据加载/格式化区
  - 角色故事
  - 语音
  - 剧情
  - 圣遗物
  - 武器

- 抓取区
  - `fetchBooksFromWiki`
  - `fetchRoleStoryAll`
  - `fetchVoiceAll`
  - `fetchPlotAll`
  - `fetchRelicAll`
  - `fetchWeaponAll`

- 插件类区
  - `constructor`: 命令规则总表
  - `init`: 定时任务注册
  - `update*`: 更新命令
  - `*Help`: 帮助命令
  - `*Read`: 按名称读取
  - `search*`: 搜索命令
  - `pickByIndex`: 序号分发
  - `pickByTitle`: 书籍标题兜底读取

## 命令分发表

`BookDex.constructor()` 内的 `rule` 是唯一命令入口。

主要分组：

- 帮助入口
  - `#书角图鉴帮助`
  - `#书籍图鉴帮助`
  - `#bookdex帮助`

- 更新入口
  - `#统一更新`
  - `#书籍更新`
  - `#角色故事更新`
  - `#语音更新`
  - `#剧情更新`
  - `#圣遗物更新`
  - `#武器更新`

- 分类帮助
  - `#书籍帮助`
  - `#角色故事帮助`
  - `#语音帮助`
  - `#剧情帮助`
  - `#圣遗物帮助`
  - `#武器帮助`

- 分类读取
  - `#角色名故事`
  - `#角色名语音`
  - `#任务名剧情`
  - `#套装名圣遗物`
  - `#武器名武器故事`

- 搜索
  - `#书籍搜索`
  - `#角色故事搜索`
  - `#语音搜索`
  - `#剧情搜索`
  - `#圣遗物搜索`
  - `#武器搜索`
  - `#搜索`

- 序号读取
  - `123`
  - `123文本`
  - `123语音`

- 书籍标题兜底
  - `#书名`
  - `#书名文本`

## 会话缓存

内存缓存：`helpSessionCache`

用途：

- 记录最近一次帮助列表
- 记录最近一次搜索结果
- 记录语音列表展开后的条目
- 支持“引用消息后发序号”读取

缓存类型：

- `book`
- `role`
- `relic`
- `weapon`
- `voice-role`
- `voice-entry`
- `plot`
- `search`

风险：

- 帮助列表格式变化后，常常需要同步检查 `pickByIndex`
- 搜索结果结构变化后，常常需要同步检查 `replySearch` 和 `pickByIndex`
- 语音有两级序号，最容易改坏

序号触发条件：

- 现在 `pickByIndex()` 只接受两类来源
- 当前用户最近一次 `bookdex` 帮助/搜索会话
- 或者引用了该会话对应的 `bookdex` 自己发出的消息
- 不再因为“引用了任意别人的消息”就误触发书籍序号

## 关键改动落点

### 改命令名或新增命令

- 先改 `constructor().rule`
- 再补对应方法
- 最后检查是否会被 `pickByTitle` 误吞

### 改帮助列表展示

- 改对应 `*Help()` 方法
- 同时检查 `helpSessionCache.set(...)`
- 再检查 `pickByIndex()` 是否还能按序号正确取值

### 改搜索

- 通用搜索入口：`runTextSearch()` + `replySearch()`
- 书籍搜索单独走 `searchBooks()`
- 如果统一搜索结果字段变了，必须同步调整 `pickByIndex()`

### 改阅读输出

- 各分类读取分别在 `roleStoryRead` / `voiceRead` / `plotRead` / `relicRead` / `weaponRead`
- 图片输出统一依赖 `renderTextAsImages`
- 纯文本输出统一依赖 `replyLong`

### 改自动更新

- `init()` 注册 cron
- `autoUpdateWindowTick()` 控制定时执行
- `shouldRunAutoUpdateWindow()` 控制窗口周期
- `updateAllTexts()` 是统一更新总流程

## 目前最容易出错的地方

- `updateAllTexts()` 的进度文案序号不一致，实际写的是 `1/5`、`4/6`、`7/7`
- `plotHelp()` 写入了 `type: 'plot'`，但 `pickByIndex()` 当前没有专门处理 `plot` 帮助会话
- `searchBooks()` 把会话类型写成 `book`，引用搜索结果后发序号会按原书库序号而不是搜索结果序号读取
- `pickByIndex()` 逻辑过长，任何新分类都容易漏加
- 书籍读取有标题兜底规则，新增命令时容易被 `pickByTitle()` 抢匹配

## 建议的后续拆分顺序

如果后面要重构，但又想控制回归面，建议按下面顺序：

1. 先抽 `commands` 常量，不改行为
2. 再抽 `session` 相关工具，不改行为
3. 再抽 `render` 相关函数，不改行为
4. 再抽 `search` 相关函数，不改行为
5. 最后再考虑拆 `fetch` 相关函数

这样做的原因：

- 命令和会话边界最清楚
- 渲染函数副作用较少，适合先拆
- 抓取逻辑最长，也最容易引入数据回归，放最后更稳

## 后续提交建议

建议在插件仓库内执行：

```bash
cd /opt/Yunzai/plugins/bookdex-plugin
git status
git add docs/ARCHITECTURE.md
git commit -m "docs: add bookdex architecture map"
```

如果后续开始改功能，建议始终在插件仓库里看状态：

```bash
git -C /opt/Yunzai/plugins/bookdex-plugin status
```
