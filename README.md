# 多模态图片管理 · dsh-image-manager

[![CI](https://github.com/qfxdz/dsh-image-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/qfxdz/dsh-image-manager/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

多模态图片管理：会话级图片上限与挑选插件（DeepSeek Harness / dsh Web 插件）。
[English →](./README.en.md)

## 解决什么问题

会话里的图片只增不减：dsh 每一轮请求都会把历史里的图片重新放进请求体，所以一个会话里
同时"在场"的图片数会一直上涨，迟早撞上网关/vLLM 的硬上限：

```
400 {"message":"At most 8 image(s) may be provided in one prompt. (parameter=image)"}
```

内置的 `compaction-image-offload` 只能"按最旧的先丢"，用户和模型都没有选择权。
本插件把这件事变成可控的，并且区分**全局默认**与**会话覆盖**：

1. **全局默认**（设置页 →「图片管理」，或侧边栏「图片」页）：所有会话默认每个请求最多发几张图。
   全局默认存在 `$DSH_HOME/image-manager.json`。
2. **会话覆盖**：某个会话可以单独设上限；**会话设过值就用会话的，没设（跟随全局）就用全局的**。
   改全局默认时，所有"跟随全局"的会话立刻跟着变；设过值的会话不受影响，直到在会话里点
   「改回跟随全局」。
3. **模型先挑选要发送哪些图片**：先 `images_list` 看清有哪些图，再 `images_select` 指定发送清单，
   并可给每张图一个简短标识；未选中的图片在请求里降级为文字占位符。
4. **三个入口**：
   - 会话标题右侧的 **「图片 N/M」按钮** → 打开当前会话的图片管理弹窗；
   - **设置 →「图片管理」** → 全局默认 +「打开图片管理器」按钮（全局视图）；
   - **侧边栏「图片」** → 全局管理页（默认值 + 所有已加载会话的清单与覆盖状态）。

关键点：**选择是可逆的**。被移出请求的图片仍然留在会话里（历史消息中显示为占位符），
随时可以重新发送或彻底排除。

## 安装

```bash
# 1) 先拿到本插件源码，再把它作为 bundle 装进 web profile（幂等；已装则跳过）
git clone https://github.com/qfxdz/dsh-image-manager.git
/path/to/dsh/node_modules/.bin/dsh plugin --profile web add \
  "$PWD/dsh-image-manager"

# 2) 重启 dsh 让新 bundle 生效（新装的 bundle 不会热加载）
/path/to/dsh/stop.sh && /path/to/dsh/start.sh
```

或直接跑本目录下的 `install.sh`，它会依次完成安装、重启、以及 API 自检（日志写在
`/tmp/dsh-image-manager-install.log`）。dsh 不在 `$HOME/dsh` 时用
`DSH_DIR=/path/to/dsh ./install.sh` 指定。

卸载：`dsh plugin --profile web remove dsh-image-manager`，然后重启。
（`cordis.patch.yml` 里对内置 `image-offload` 的禁用会随 bundle 一起消失，
内置的"丢最旧图片"行为自动恢复。）

## 使用

### 模型工具

| 工具 | 作用 |
|---|---|
| `images_list` | 列出会话里全部图片：id、是否发送、文件名、尺寸、标识 |
| `images_select` | 指定发送哪些 id（可带 `labels` 给每张图一个标识）；传 `[]` 回到"只发最新的 N 张" |
| `images_limit` | 设置本会话上限（`maxImages`），或传 `inherit: true` 清掉覆盖、改回跟随全局 |
| `images_exclude` / `images_include` | 把图片彻底排除 / 恢复 |

典型对话：

> 用户：看我传的这几张图，哪张适合做封面？
> 模型：（调用 `images_list`）→（调用 `images_select`，只发相关的 3 张 + 给标识）→ 回答

因为发送清单是持久保存在该会话里的事件，后续轮次会继续按同一份清单发送。

### 界面

- **会话标题右侧的「图片 N/M」按钮**：N = 当前会话图片数，M = 生效上限。灰点 = 上限跟随全局；
  蓝点 = 本会话单独设过值。点开即当前会话的管理弹窗。
- **设置 →「图片管理」**：改全局默认、看配置文件的路径、看各会话是"跟随"还是"自定义"，
  以及一个「打开图片管理器」按钮（打开全局视图）。
- **侧边栏「图片」→ 全局管理页**：全局默认 + 会话下拉 + 该会话的图片网格。
- 管理界面里：预览大图、`发送`/`不发送`、`排除`/`恢复`、`回到「最新 N 张」`、
  上限的「跟随全局 / 自定义」二选一 + `保存本会话设置` / `改回跟随全局`。

### HTTP 接口（界面用的就是它）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-image-manager/api/settings` | 全局默认上限与配置文件路径 |
| POST | `/dsh-image-manager/api/settings` | `{maxImages}` → 改全局默认（会立即影响所有"跟随全局"的会话），仅接受同源请求 |
| GET | `/dsh-image-manager/api/sessions` | 当前进程里的会话列表（图片数、是否覆盖、生效上限）+ settings |
| GET | `/dsh-image-manager/api/state?sessionId=` | 该会话的生效上限、是否跟随全局、发送清单、图片列表 |
| POST | `/dsh-image-manager/api/policy` | `{sessionId, maxImages? \| inherit?, pinned?, dropped?, labels?}`，仅接受同源请求 |
| GET | `/dsh-image-manager/api/image?sessionId=&id=` | 图片原始字节（缩略图/预览） |

## 实现要点

- **落盘复用 `image/offload` 事件类型**。dsh 的会话日志有白名单
  （`KNOWN_SESSION_EVENT_TYPES`），下游插件**不能**新增可持久化的事件类型：
  `session.append` 无法写入 `ignorable: true`，日志会在重启后被持久化层拒绝解析。
  `image/offload` 是唯一"已登记 + 可持久化 + 能影响模型请求"的类型，所以本插件
  接管它：把 `data` 解释为**完整策略快照** `{v:2, inherit, maxImages, pinned, dropped, labels}`
  而不是内置的追加式 `{targets}`。同一份快照可以反复重算投影，因此选择可逆。
  内置插件历史写入的 `{targets}` 事件仍然兼容（只标注、不还原）。
- **全局默认 vs 会话覆盖，为什么要写进事件**：投影必须是会话日志的纯函数（重放要确定），
  不能让投影去读"当前全局设置"。所以策略事件里存的是**写入那一刻的生效值** + `inherit` 标记；
  全局默认改动时，本插件给所有仍 `inherit` 的会话补写一条新事件（`agent/pre-step` 也会按
  "生效值签名"对账），投影因此始终确定，覆盖会话则不受影响。
- **为什么要禁用内置 `@deepseek-ai/dsh-compaction-image-offload`**：投影按事件类型
  注册，`registerMessageProjection` 对同一类型只允许注册一次（重复会抛错）。
  本插件在 `cordis.patch.yml` 里把内置那一行 `disabled: true`，并自己实现它的全部职责：
  投影 + `IMAGE_OFFLOAD_REQUIRED` 失败恢复 + `compaction/summary-error` 恢复。
- **生效时机**：每次 `agent/pre-step`（请求派生之前）对账一次，只在"策略或图片集合
  发生变化"时写一条新事件；工具/接口改动会立刻写一条并缓存签名，不会重复写。
- **无依赖**：Host 半边只用 `ctx`（`sessions` / `tools` / `webServer` / `attachments`），
  不 import 任何 `@deepseek-ai/*`；浏览器半边是手写的
  `window.__ModuleLoader__.load({id, factory})`，只 `require('react')`。因此不需要
  构建工具，也不需要往 profile 里装依赖。

## 已知限制

- **"删除"是逻辑删除**：dsh 的附件是内容寻址、不可变、且没有任何删除 API
  （`ctx.attachments` 没有 `list`/`delete`）。所以这里的"排除"是把图片移出请求并
  在面板里标记为已排除，磁盘对象仍保留——这也正是"排除可恢复"的前提。
  真正删除需要直接删 `$DSH_HOME/attachments/v1/objects/**`，会让历史读取失败，本插件不做。
- **图片上限不是服务端硬上限**：网关/vLLM 自己的 `--limit-mm-per-prompt` 仍然生效。
  本插件默认上限 8，与该网关一致；若网关上限更小，请求仍可能被网关拒绝（此时插件会在
  收到 `IMAGE_OFFLOAD_REQUIRED` 时再收一轮，最多重试 3 次）。
- HTTP 接口按 dshmarket 的惯例挂在自定义前缀下，不受 `/` 那样的 token 保护；
  写接口只接受同源 POST（浏览器会带 `Origin`），因此跨站无法调用。
- 面板只能在"当前 dsh 进程里已加载"的会话上操作；很久没打开的会话需要先在侧边栏点开。
- **全局默认存在文件里**（`$DSH_HOME/image-manager.json`），不是 dsh 的原生 settings 命名空间：
  dsh 的 `ctx.settings` 只有全局 namespace、没有会话维度，而且注册 schema 需要
  `@deepseek-ai/schemastery`（本插件刻意零依赖）。文件按 mtime 热读，手工编辑同样生效。
- 会话曾"自定义"过上限后，即使值等于全局默认也仍算覆盖（界面上会显示为「自定义」）；
  点「改回跟随全局」即可恢复跟随。

## 文件

```
dsh-image-manager/
├── package.json            # dsh bundle 清单（dsh.bundle.patch + dsh.client）
├── cordis.patch.yml        # 禁用内置 image-offload + 插入本插件
├── lib/index.js            # Host：全局默认、会话策略、投影、工具、HTTP 接口
├── lib/client.js           # 浏览器：会话按钮 + 设置区 + 管理弹窗 + 全局管理页
├── test/logic.test.mjs     # Host 逻辑单测（17 条）
├── test/client.test.mjs    # 浏览器半边冒烟测试（模块契约 + 5 个入口）
├── install.sh              # 安装 + 重启 + 自检
├── .github/workflows/ci.yml# CI：Node 20/22/24 跑单测 + 打包与凭据扫描
├── CONTRIBUTING.md         # 开发环境与 PR 清单
├── SECURITY.md             # 安全策略与报告方式
├── CHANGELOG.md            # 变更记录
├── README.en.md            # 英文说明
└── LICENSE                 # MIT
```

## 开发与测试

本插件**零依赖、零构建**：不需要 `npm install`，也没有构建步骤。

```bash
npm test              # 跑离线单测（Host 逻辑 + 浏览器半边冒烟）
npm run check         # 单测 + npm pack --dry-run（看发布内容是否干净）
```

真机验证：`DSH_DIR=/path/to/dsh ./install.sh`，然后刷新页面看三个入口是否都在。
详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 参与贡献

欢迎 Issue / PR，请先读 [CONTRIBUTING.md](./CONTRIBUTING.md)；安全相关问题请看
[SECURITY.md](./SECURITY.md)，不要开公开 Issue。所有反馈里请**先删除路径中的用户名、
token、会话 id 等敏感信息**。

## 许可证

[MIT](./LICENSE)

