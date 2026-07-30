# X 嵌入预览模块

x-embed-preview.html 只保留页面语义结构，样式与行为位于本目录。所有文件都是浏览器原生 CSS/ES Module，不需要构建工具，可直接部署到 GitHub Pages。

## 目录

    assets/x-embed-preview/
    ├── README.md
    ├── styles/
    │   ├── base.css            # 变量、重置、页头、表单
    │   ├── layout.css          # 加载轨道、对比面板与通用预览容器
    │   ├── media-gallery.css   # X 式拼图、播放器与全屏灯箱
    │   ├── cards.css           # 加载状态、本地卡片与页脚
    │   └── responsive.css      # 平板、移动端及减少动画适配
    └── scripts/
        ├── app.js              # 页面入口与五种预览编排
        ├── config.js           # 演示链接、站内封面和可信媒体主机
        ├── types.js            # 共享 JSDoc 数据结构
        ├── tweet-url.js        # X 链接校验与深链接解析
        ├── repository.js       # 站内 data.json 查询
        ├── ui-state.js         # 加载轨道和错误状态
        ├── x-widgets.js        # X Publish 组件适配
        ├── local-card.js       # 零组件卡片
        └── media/
            ├── api.js          # FxTwitter 请求与响应收敛
            ├── preview.js      # 动态画廊异步状态
            ├── gallery.js      # 拼图与站内视频播放
            └── lightbox.js     # 完整比例媒体轮播

## 依赖方向

app.js 负责组合各模块；业务模块不反向引用入口。媒体调用链为：

    app.js → media/preview.js → media/api.js
                             ↘ media/gallery.js → media/lightbox.js

新增功能时优先放入最接近职责的模块。只有跨模块共享的固定配置放入 config.js，共享数据形态放入 types.js，避免重新把页面入口变成大文件。

## 本地验证

1. 通过静态服务器打开 x-embed-preview.html，不能直接使用 file://（ES Module 会受浏览器跨域限制）。
2. 使用包含图片和视频的公开 X 推文链接生成预览。
3. 验证图片灯箱、拼图内视频播放、视频放大、前后切换和移动端无横向溢出。
