<!-- Shared-source development policy and the pinned translation-engine baseline. -->
# 开发规范

## 跨平台兼容性

+ 本项目需要适配Linux/Windwos/MacOS；在某一平台进行开发，改动/增加功能时，不得退化其他平台的兼容性

## 翻译引擎基线

+ 当前功能以 BabelDOC 0.6.4 为基线，优先确保该版本下翻译、保护区域、字体、缓存及阅读功能可用。
+ BabelDOC 新版迁移明确为低优先级，不列为 TODO 或当前开发优先事项；不得为了新增功能顺带升级引擎或用迁移替代当前版本的问题修复。
+ macOS 专属源码尚未取得时，不推进其合流或覆盖现有发布包；共享实现仍须保持跨平台兼容，避免平台专属写法或依赖。

## GitHub 发布规范

+ Release 仅上传供安装的 XPI 和必要的 corresponding-sources ZIP，保留 GitHub 自动生成的 Source code；不上传独立 `.sha256`、`.inventory.json` 或源码 ZIP 的外置 `.manifest.json`。禁止用通配符把整个产物目录上传，本地校验文件及清单继续生成并保留。
+ 发布完整性使用实际本地哈希、更新清单 `update_hash`、本地 inventory、源码 ZIP 内的 `bundle-manifest.json` 及 GitHub asset digest 验证，不依赖公开校验文件或外置清单下载。
+ 发布时同步 GitHub TODO issue，区分已交付、限定验收和未完成；不把 PDF 已生成、结构 complete 或脚本通过当作全文语义接受。
+ Linux/Windows 共享版本与独立 macOS 版本分开说明；不跨平台比较版本号，不以仓库 Latest 替代各平台更新通道。
