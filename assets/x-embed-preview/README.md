# X 嵌入预览模块

x-embed-preview.html 只保留页面语义结构，样式与行为位于本目录。所有文件都是浏览器原生 CSS/ES Module，不需要构建工具，可直接部署到 GitHub Pages。

## 目录

    assets/x-embed-preview/
    ├── README.md
    ├── styles/
    │   ├── base.css            # 变量、重置、页头、表单
    │   ├── layout.css          # 加载轨道、对比面板与通用预览容器
    │   ├── media-gallery.css   # X 式拼图、播放器与全屏灯箱
    │   ├── home-gallery.css    # 首页列表中的画廊边界与加载状态
    │   ├── cards.css           # 加载状态、本地卡片与页脚
    │   └── responsive.css      # 平板、移动端及减少动画适配
    └── scripts/
        ├── app.js              # 页面入口与五种预览编排
        ├── config.js           # 演示链接、媒体清单版本和可信媒体主机
        ├── types.js            # 共享 JSDoc 数据结构
        ├── tweet-url.js        # X 链接校验与深链接解析
        ├── repository.js       # 站内 data.json 查询
        ├── ui-state.js         # 加载轨道和错误状态
        ├── x-widgets.js        # X Publish 组件适配
        ├── home-gallery.js     # 首页分阶段预载、请求去重与失败重试
        ├── local-card.js       # 零组件卡片
        └── media/
            ├── api.js          # 静态清单、六小时缓存与 FxTwitter 回退
            ├── local.js        # 本站用户素材清单校验与同源 URL 解析
            ├── preview.js      # 动态画廊异步状态
            ├── gallery.js      # 拼图与站内视频播放
            └── lightbox.js     # 完整比例媒体轮播

## 依赖方向

app.js 负责组合各模块；业务模块不反向引用入口。媒体调用链为：

    app.js → media/preview.js → media/api.js
                             ↘ media/gallery.js → media/lightbox.js

新增功能时优先放入最接近职责的模块。只有跨模块共享的固定配置放入 config.js，共享数据形态放入 types.js，避免重新把页面入口变成大文件。

首页 `index.html` 复用 `media-gallery.css`、`home-gallery.css` 和 `home-gallery.js`。当前首页只把 `data.json` 中的 `mediaFolder` 输出为占位区，并复用同一套拼图、原生播放器与灯箱组件。

首页 X 推文来源目前已停用：`data.json` 不含 `tweet` 字段，`ENABLE_TWEET_MEDIA` 为 `false`，`tweet-media.json` 是空清单，首页也不预取 X 清单或 CDN。解析模块、实验页、刷新脚本和 CI 校验仍保留；首页适配器只有未来明确恢复该功能时才按需导入 X 解析模块。

恢复后，生产页会优先读取 `assets/data/tweet-media.json` 中的 X CDN 元数据。清单没有目标推文或读取失败时，才请求 FxTwitter；成功结果会在浏览器缓存六小时。图片、视频封面和视频文件始终由访问者浏览器直接请求 X 官方 CDN，并由浏览器按 HTTP 缓存规则复用；仓库和 GitHub Pages 不保存推文预览图。

首页的加载节奏按当前视口高度计算：提前约 1.5 屏读取本站清单并请求列表图片/封面，提前 0.75 屏连接全部视频并读取 metadata，提前 0.25 屏只把第一段视频提升为 `preload="auto"`。省流量、2G 和 3G 网络跳过最后一步；列表视频使用低码率档位，灯箱只在用户打开当前素材后读取高清文件。保留的 X 分支恢复后沿用同一加载节奏。

## 导入本站用户素材

原始素材不直接复制到仓库。使用 `scripts/import-staff-media.mjs` 从一个用户的
来源目录生成 WebP、H.264/AAC MP4、封面和 `media.json`，再把相同目录键写入
该用户的 `mediaFolder`。详细命令见 `assets/media/staff/README.md`；CI 会运行
`node scripts/import-staff-media.mjs --check`，拒绝未关联目录、错误编码、非
faststart 视频、单用户超过 30MB 或全站超过 850MB 的素材。

## 恢复或更新 X 媒体清单

只有明确决定恢复首页 X 功能后，才重新添加 `tweet` 字段、启用首页开关并执行：

    node scripts/refresh-tweet-media.mjs

脚本会串行读取当前全部推文并刷新静态元数据清单，不会下载或生成图片。提交前或 CI 中使用只读检查：

    node scripts/refresh-tweet-media.mjs --check

检查会确认推文 ID、X CDN 媒体 URL 和视频码率一一对应，拒绝任何站内预览字段，并要求每段视频保留移动端低码率档位。若媒体逻辑或清单内容有变化，同时递增 `config.js`、`index.html` 与模块导入中的媒体版本号。

## 本地验证

1. 通过静态服务器打开 x-embed-preview.html，不能直接使用 file://（ES Module 会受浏览器跨域限制）。
2. 使用包含图片和视频的公开 X 推文链接生成预览。
3. 验证图片灯箱、拼图内视频播放、视频放大、前后切换和移动端无横向溢出。
4. 在首页检查 Network：已入库推文不应请求 FxTwitter；图片和视频封面应来自 X CDN；移动端列表视频应选择最低码率，灯箱只在打开当前素材后请求高清地址。
