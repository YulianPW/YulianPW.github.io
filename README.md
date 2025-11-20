# 雨恋女陪殿

这是一个静态网站项目，使用纯 HTML/CSS/JavaScript 构建。

## 本地运行

### 方法一：Python（推荐）

如果你安装了 Python（通常已预装），可以使用内置的 HTTP 服务器：

```bash
# Python 3
python -m http.server 8000

# 或者 Python 2
python -m SimpleHTTPServer 8000
```

然后在浏览器中访问：`http://localhost:8000`

### 方法二：Node.js

如果你安装了 Node.js，可以使用 `serve` 工具：

```bash
# 安装 serve（全局安装，只需安装一次）
npm install -g serve

# 运行服务器
serve .

# 或者指定端口
serve . -p 5000
```

访问：`http://localhost:3000`（或你指定的端口）

### 方法三：VS Code / Cursor Live Server

如果你使用 VS Code 或 Cursor：

1. 安装 **Live Server** 扩展
2. 右键点击 `index.html` 文件
3. 选择 "Open with Live Server"

会自动打开浏览器并支持热重载。

### 方法四：PHP

如果你安装了 PHP：

```bash
php -S localhost:8000
```

访问：`http://localhost:8000`

## 注意事项

⚠️ **重要**：必须通过本地服务器访问，不能直接双击 HTML 文件打开！

因为网站使用了 `fetch()` API 加载 `data.json` 和 `info-content.html`，直接打开文件会因为 CORS 策略而无法正常工作。

## 项目结构

```
YulianPW.github.io/
├── index.html          # 主页面
├── data.json           # 陪陪数据
├── info-content.html   # 项目介绍内容
├── info-content.css    # 样式文件
├── quan.png            # 二维码图片
├── kapan1.jpg          # 封面图片
└── .github/
    └── workflows/
        └── build.yml   # GitHub Actions 自动部署配置
```

## 功能特性

- ✅ 本地缓存：使用 localStorage 缓存数据，5 分钟内快速加载
- ✅ 版本控制：通过 `version.json` 自动检测数据更新
- ✅ 响应式设计：支持桌面和移动端
- ✅ 分类筛选：支持按标签和关键字搜索

## 部署

网站已配置 GitHub Actions，推送到 `main` 分支后会自动部署到 GitHub Pages。

访问地址：https://yulianpw.github.io/

