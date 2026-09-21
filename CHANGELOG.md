# Changelog

本文件记录对外可见的变化。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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

[Unreleased]: https://github.com/OWNER/dsh-image-manager/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/OWNER/dsh-image-manager/releases/tag/v0.1.0
