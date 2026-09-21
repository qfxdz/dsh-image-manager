# 安全策略

## 报告漏洞

请**不要**通过公开 Issue 报告安全问题。使用 GitHub 的
[私密漏洞报告](https://docs.github.com/zh/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
（仓库 → Security → Report a vulnerability），或直接联系仓库维护者。

请在报告里说明：影响范围、复现步骤、可能的后果。**不要**附带真实的 token、密码、
私钥、cookie 或个人身份信息；需要演示时请用你自己环境里的占位符。

## 支持范围

只维护最新发布版本（见 [CHANGELOG.md](./CHANGELOG.md)）。

## 设计上的安全边界

- 插件**不采集、不上传**任何数据；没有遥测、没有外部网络请求，也不读取会话之外的本地文件
  （除 `$DSH_HOME/image-manager.json` 这一个配置文件和 dsh 自身的附件目录）。
- 浏览器与 Host 之间只走 dsh 自带的同源 HTTP 前缀 `/dsh-image-manager/api/*`；
  写接口（`POST /api/settings`、`POST /api/policy`）只接受同源请求。
  注意：该前缀**不经过** dsh 根路径那层 token 保护，因此不要把它暴露到不可信网络，
  也不要通过反向代理把它开放给第三方。
- 图片数据只以 dsh 附件（内容寻址、只读）形式读取；"排除"是逻辑操作，不删除磁盘对象。
- 任何出现在 Issue / PR / 截图里的本地路径、会话 id、附件 id，请先打码或替换为占位符。
