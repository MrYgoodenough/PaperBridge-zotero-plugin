<!-- Shared-source development policy and the pinned translation-engine baseline. -->
# 开发规范

## 跨平台兼容性

+ 本项目需要适配Linux/Windwos/MacOS；在某一平台进行开发，改动/增加功能时，不得退化其他平台的兼容性

## 翻译引擎基线

+ 当前功能以 BabelDOC 0.6.4 为基线，优先确保该版本下翻译、保护区域、字体、缓存及阅读功能可用。
+ BabelDOC 新版迁移明确为低优先级，不列为 TODO 或当前开发优先事项；不得为了新增功能顺带升级引擎或用迁移替代当前版本的问题修复。
+ macOS 专属源码尚未取得时，不推进其合流或覆盖现有发布包；共享实现仍须保持跨平台兼容，避免平台专属写法或依赖。
