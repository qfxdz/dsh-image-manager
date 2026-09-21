## 改了什么

<!-- 一句话说明；一个 PR 只做一件事 -->

## 为什么

<!-- 解决的问题 / 关联 Issue：Fixes #123 -->

## 怎么验证的

- [ ] `npm test` 通过
- [ ] `npm pack --dry-run` 的包内容符合预期（仅 lib/、cordis.patch.yml、README*、LICENSE）
- [ ] 真机验证（说明验证的入口与步骤；界面改动请附截图）

## 自查

- [ ] 没有新增运行时依赖、构建步骤或对 `@deepseek-ai/*` 的 import
- [ ] 兼容历史写入的 `{ targets: [...] }` 事件
- [ ] 没有提交个人信息或凭据（绝对路径里的用户名、邮箱、token、密码、私钥、真实会话 id）
- [ ] 行为变化已同步 `README.md`、`README.en.md` 与 `CHANGELOG.md`
- [ ] 用户可见文案中英双语（或至少中文可读），错误提示不写死本机路径
