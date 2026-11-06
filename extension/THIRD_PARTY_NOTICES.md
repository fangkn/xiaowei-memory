# 参考项目说明

本项目 v0.2 的实验历史模式参考用户提供的 **Speechless** 项目源码，了解微博网页端点 `/ajax/statuses/searchProfile`、`/ajax/statuses/longtext`、`/ajax/profile/mbloghistory` 的参数与响应字段。该参考不能证明端点当前可用或覆盖全部历史。

实现代码、界面、年月任务状态机、页级持久检查点、失败不跳页、Markdown/本地图片归档和覆盖报告均独立编写；没有运行原项目，也没有复制其界面或 PDF 打印流程。没有包含参考项目的 Git 数据或签名密钥。

为保留清晰来源记录，以下附参考项目 MIT 许可原文。

MIT License

Copyright (c) 2022 meterscao

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


# PDF 导出依赖

所有运行时依赖随扩展本地分发，生成 PDF 时不加载远程脚本或字体。

具体文件校验值与来源记录见同目录 `DEPENDENCIES.json`。字体的原始上游提交及转换工具版本尚未记录，当前以仓库内静态字体作为锁定的构建输入，不宣称可以从上游逐字节复现字体。

- pdf-lib 1.17.1：MIT，https://github.com/Hopding/pdf-lib 。官方 ESM 压缩构建未修改；许可见 `vendor/pdf-lib-LICENSE.md`。
- @pdf-lib/fontkit 1.1.1：MIT，https://github.com/Hopding/fontkit 。使用官方 UMD 内的完整工厂函数，仅将外层全局注册替换为本地 ESM 导出；许可见 `vendor/fontkit-LICENSE.txt`。原始 npm tarball SHA-1：`f18473892b65e3253eb73f4569785abd2c03b1e0`。
- Noto Sans SC Regular：SIL Open Font License 1.1，https://github.com/notofonts/noto-cjk/tree/main/Sans/Variable/TTF/Subset 。来源 `NotoSansSC-VF.ttf`，使用 fontTools varLib.instancer 固定 `wght=400 --static --update-name-table --no-recalc-timestamp` 生成静态 Regular TrueType 字体；为避免 fontkit 子集漏字，在每份 PDF 内完整嵌入 TrueType 字体，许可见 `fonts/OFL.txt`。
- pako（嵌入上述发行构建）：MIT / Zlib，许可见 `vendor/pako-LICENSE.txt`。

缺少的 Unicode 字形会以 `[U+编码]` 保留，避免不可见字符；PDF 内附提示。GIF/WebP/AVIF 在浏览器中转换为第一帧静态图，PDF 不含动画。
