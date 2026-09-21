# 贡献指南

感谢你愿意改进 `dsh-image-manager`。这个插件刻意保持**零依赖、零构建**：Host 半边只用 cordis `ctx`，浏览器半边是手写的 `__ModuleLoader__` 工厂，改完刷新页面即可生效。请在提交前保持这个约束。

## 开发环境

- Node.js >= 20（仓库在 20 / 22 / 24 上跑 CI）
- 一个可用的 dsh 安装（用于真机验证；只想跑单测则不需要）

```bash
git clone https://github.com/OWNER/dsh-image-manager.git
cd dsh-image-manager
npm test          # 离线单测：Host 逻辑 + 浏览器半边冒烟
```

单测不需要安装任何依赖，也不需要 dsh 进程。真机调试：

```bash
DSH_DIR=/path/to/dsh ./install.sh    # 安装 + 重启 + HTTP 自检
```

## 提交前自检

1. `npm test` 全绿。
2. `npm pack --dry-run` 的包内容只包含 `lib/`、`cordis.patch.yml`、`README*.md`、`LICENSE`。
3. 没有引入新的运行时依赖、构建步骤或对 `@deepseek-ai/*` 的 `import`
   （浏览器半边只允许 `require('react')`）。
4. 没有提交任何**个人信息或凭据**：绝对路径里的用户名、邮箱、token、密码、私钥、
   真实会话 id / 附件 id 都不应出现在代码、注释、测试与截图里。
5. 用户可见文案保持中英双语或至少中文可读；`lib/client.js` 里的错误提示不要写死本机路径。

## 约定

- **事件类型**：只能复用 dsh 已登记的可持久化事件类型（当前为 `image/offload`），
  不要尝试新增可落盘的事件类型，否则会话日志重启后会解析失败。详见 README「实现要点」。
- **代码风格**：与现有文件一致（Tab 缩进、单引号、分号）；注释用中文说明"为什么"，
  不要只复述代码在做什么。
- **提交信息**：`<type>: <subject>`，type 取 `feat` / `fix` / `docs` / `refactor` / `test` / `chore`。
- **兼容性**：改动投影策略时必须继续兼容历史写入的 `{ targets: [...] }` 事件（见 `test/logic.test.mjs`）。

## 提 PR

1. 从 `main` 切出分支：`feat/xxx`、`fix/xxx`。
2. 一个 PR 只做一件事；行为变化请同步更新 `README.md`、`README.en.md` 与 `CHANGELOG.md` 的
   `Unreleased` 段。
3. 说明「改了什么 / 为什么 / 怎么验证的」；涉及界面改动的请附截图（注意先打码个人信息）。
4. 提交前确认 `npm test` 与 `npm pack --dry-run` 通过——CI 会再跑一遍。

## 报告问题

- Bug / 功能建议：开 Issue，附上 dsh 版本、Node 版本、复现步骤与相关日志（**请先删掉路径里的
  用户名、token、会话 id 等敏感信息**）。
- 安全问题：不要开公开 Issue，见 [SECURITY.md](./SECURITY.md)。
