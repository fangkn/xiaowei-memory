<p align="center">
  <img src="extension/icons/icon-128.png" width="72" height="72" alt="小微记忆图标">
</p>

# 小微记忆 · xiaowei-memory

**备份自己的公开微博，按月整理成 PDF，留在自己的电脑里。**

一款 Chrome / Edge 桌面扩展，自动过滤转发，保存正文、时间、原文链接及可选图片、表情，支持 PDF 和 Markdown 导出。数据在本机处理，无需部署服务器。当前版本：**v0.7.7 试用版**。

<p align="center">
  <img src="docs/images/account.png" width="340" alt="确认微博账号">
  <img src="docs/images/export.png" width="340" alt="按月导出 PDF">
</p>

截图使用离线合成账号与模拟数据。

## 安装

1. 在仓库选择 **Code → Download ZIP**，解压到固定目录。
2. Chrome 打开 `chrome://extensions`，Edge 打开 `edge://extensions`，开启「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择项目内的 **`extension`** 文件夹，再固定扩展图标。

直接安装不需要 npm。升级时更新原加载目录，点击「重新加载」并刷新微博；保留原目录和扩展数据。

## 使用

1. 打开自己的数字 UID 主页，例如 `https://weibo.com/u/数字UID`。
2. 点击「小微记忆」，核对昵称和 UID，选择 **「当前页面」** 开始采集。
3. 选择导出月份、格式及是否包含图片，按提示授予图片读取权限。
4. 下载后核对内容，点击「已核对下载，完成」。

采集和生成期间保留微博标签页，可以最小化面板。相同内容与设置下，重试会复用完整月份；文件可在浏览器下载记录中找到。

## 导出方式

| 格式 | 下载结果 |
| --- | --- |
| **每月一份 PDF** | 单月一个 PDF，多月统一打包 ZIP |
| **合并 PDF** | 所选月份合成一份 PDF，按月分节 |
| **Markdown + 图片** | 一个 ZIP，每月一个目录，可放入 Obsidian |

在「更多导出选项 → 文件格式」中切换。

## 使用范围

- 需要登录自己的微博账号；游客模式尚未专门适配，不保证免登录可用或取得全部历史。
- 使用「当前页面」采集后可按月导出；「指定月份」查询目前是实验功能。
- 图片可随文件保存；不备份视频文件、评论或私信。遇到登录、验证或访问限制时会暂停。

## 文档与开发

[使用说明](小微记忆-使用说明.md) · [工作原理](docs/WORKFLOW.md) · [隐私与权限](PRIVACY.md) · [测试报告](TEST-REPORT.md) · [更新记录](CHANGELOG.md)

开发需要 Node.js 20+。运行 `npm ci`、`npm run build`，可在 `dist/` 生成 Chrome / Edge 安装包。开发与测试流程见 [贡献指南](CONTRIBUTING.md)。

问题与建议请提交到 [Issues](https://github.com/fangkn/xiaowei-memory/issues)，安全问题见 [SECURITY.md](SECURITY.md)。项目采用 [MIT License](LICENSE)，第三方许可见 [相关声明](extension/THIRD_PARTY_NOTICES.md)。

## 关注公众号

扫码关注我的微信公众号，了解后续更新，交流使用体验。

<p align="center">
  <img src="docs/images/wechat-qrcode.jpg" width="258" height="258" alt="微信公众号二维码">
</p>
