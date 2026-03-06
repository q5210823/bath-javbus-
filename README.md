# Jav Magnet Batch Fetcher (Chrome Extension)

根据番号列表，批量从 `sukebei.nyaa.si` 搜索并提取磁力链接（`magnet:?`）。

## 核心功能

- 大小筛选：默认 `>= 4GB`，可用滑动条调整（0.5GB ~ 20GB）。
- 中文字幕优先：默认勾选。优先匹配 `XXX-XXX-C` / `XXX-XXXch` / 标题包含“中文字幕/中字/SUB/CHS/CHT”。
- 历史记录：每次抓取结果自动保存到浏览器本地缓存（`chrome.storage.local`），并按时间倒序展示。
- 历史导出：支持导出历史记录 JSON 文件。

## 使用方式

1. 打开 `chrome://extensions/`。
2. 开启「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择目录 `d:\VScodeWorkSpace\javbus`。
4. 点击插件图标，设置筛选条件并输入番号（每行一个）。
5. 点击「开始抓取」。

## 结果状态

- `ok`: 找到并选中了符合筛选条件的磁力。
- `filtered_out`: 找到候选结果，但都被筛选条件过滤。
- `not_found`: 搜索结果中没有匹配番号的条目。
- `error`: 抓取过程发生异常。
