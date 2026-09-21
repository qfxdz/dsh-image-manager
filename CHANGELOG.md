# Changelog

本文件记录对外可见的变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 修复

- **`/compact` 与自动压缩报 `Cannot read properties of undefined (reading 'map')`**：
  `@deepseek-ai/dsh-token-meter` 自己也会折叠 `image/offload` 事件，并且**无条件**执行
  `event.data.targets.map(...)`；本插件此前写入的策略快照没有 `targets` 字段，导致该会话的
  上下文计费折叠抛错 → 自动压缩失效、`/compact` 直接报 TypeError。
  现在每条策略事件都会附带与「本次不发送」一致的 `targets`（incremental 语义兼容），
  投影判断也改为 `v === 2` 优先，不会被 targets 降级成追加式。
  已写入的历史事件另用 `patch-token-meter.sh` 给 token meter 加兜底。

- **会话列表混入不该出现的条目**：按 dsh 自己会话栏的口径（`dsh-client-ui-workspace` 的
  `sessionVisible`）过滤——子代理会话、**归档会话**、以及除「当前」以外的空会话(blank)都不再出现；
  空会话此前会退化成以项目文件夹名命名的一行，看起来就像"文件夹也算会话"。
  另外同名会话（未命名会话的标题会退化成文件夹名）自动补 6 位短 id，不再看起来像重复项。
- **管理面板的会话列表不全**：下拉此前只列出 Host 进程里已加载（live）的会话，磁盘上有 13 个会话时只显示 3 个。现在改用客户端会话目录（`ctx.sessions.list`，即左侧会话栏那份完整列表）与 Host live 信息合并展示；未加载的会话标注「未加载」，并提供「打开该会话」按钮把它加载进来。

### 计划中

- 面板内的"按当前选择一并清理"批量操作
- 英文文档补全截图

## [0.1.0] - 2026-09-20

首个可用版本。

### 修复

- **图片预览全部裂图**：`/api/image` 读字节需要 `ctx.attachments`，而插件没有在 `inject` 里
  声明该服务，cordis 取属性时直接抛 `cannot get property "attachments" without inject`，
  接口返回 500，界面里所有缩略图与大图都变成裂图。现已声明 `attachments`，并补了
  `/api/image` 的接口级单测（字节、Content-Type、404/503/500 分支）。
- 缩略图加载失败时不再显示浏览器裂图图标，改为「图片加载失败 + 重试」。

### 新增

- **会话级图片上限**：区分全局默认（`$DSH_HOME/image-manager.json`）与会话覆盖；会话设过值用会话的，否则跟随全局。
- **模型工具**：`images_list`、`images_select`（可给每张图带 `labels` 标识）、`images_limit`、`images_exclude`、`images_include`。
- **三个界面入口**：会话标题右侧的「图片 N/M」按钮、设置 →「图片管理」、侧边栏「图片」全局管理页。
- **可逆策略**：接管 `image/offload` 事件类型并解释为完整策略快照 `{v:2, inherit, maxImages, pinned, dropped, labels}`，被移出请求的图片仍留在会话中，可随时恢复；兼容内置插件历史写入的追加式 `{targets}` 事件。
- **HTTP 接口**：`/dsh-image-manager/api/{settings,sessions,state,policy,image}`，写接口仅接受同源 POST。
- **零依赖实现**：Host 半边只使用 `ctx`（`sessions` / `tools` / `webServer` / `attachments`），浏览器半边手写 `__ModuleLoader__` 工厂，不需要构建工具。
- 离线测试：Host 逻辑单测（17 条）+ HTTP 接口单测（11 条，含 `/api/image` 字节流）+ 浏览器半边冒烟测试，`npm test` 一把跑完。
- 安装脚本 `install.sh`：安装 → 重启 dsh → HTTP 自检，幂等可重复执行。

[Unreleased]: https://github.com/qfxdz/dsh-image-manager/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/qfxdz/dsh-image-manager/releases/tag/v0.1.0
