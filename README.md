# 同步云端人员价格与展示素材

在仓库根目录运行统一入口：

```sh
node scripts/sync-staff.mjs --check --json
node scripts/sync-staff.mjs --apply --json
```

省略 `--check` / `--apply` 时默认预演。预演报告价格变化、展示素材变化、
本地缺失原件及单边人员 ID；`--apply` 更新本地店网页文件，不提交、推送或发布。
Agent 日常同步使用这个统一入口；仅同步价格的旧入口继续保留。

首次使用时，将 `scripts/staff-sync.example.json` 复制为仓库根目录的
`.staff-sync.local.json`，填写云节点地址和本机已同步的素材根目录。
该文件已加入 Git 忽略，不放凭据；两个清单接口不需要登录。
真实云节点地址和本机素材路径只填写在这个本地文件中，示例配置保留占位值。
`mediaRoots` 中的相对路径以店网页仓库根目录为基准。
也可用 `--config <文件>`、`--source <云节点地址>`、重复的
`--media-root <目录>` 覆盖配置。

同步按固定 `staffId` 更新已有人员的介绍、价格与展示关联，保持姓名、分类、
社交链接和人员顺序。媒体只读取云端已选清单，在本地按扩展名、大小和
SHA-256 找到相同原件，再按云端选择顺序复用既有转码流程生成网站成品。
已有 `mediaFolder` 继续使用；首次展示自动按固定人员 ID 生成目录键并写入关联。
原件不复制进网站、不改写，不下载云端视频或图片。

未配置展示者继续使用店网页原素材；明确清空会解除展示关联、移除对应网页成品，
素材库原件保留。云端独有人员只报告，不自动加入店网页。
`.staff-showcase-sync.local.json` 保存已应用的选择与成品摘要，仅保存在本机并由 Git 忽略。
选择和成品均未变化时跳过转码。缺原件时等待既有文件同步完成后重跑同一命令。

通用同步脚本与占位示例可以纳入版本管理，真实配置、本地同步记录和暂存目录不得提交。
GitHub Pages 只打包页面、站点验证文件及 `assets/` 中的运行资源，脚本、说明文档和本地配置不进入发布目录。

应用前会拒绝覆盖受影响文件的未提交改动。所有原件就绪、转码和整库校验通过后，
才一起安装数据与成品；准备失败时保留原网站文件。
本机转码依赖与输出规范见 [网站素材说明](assets/media/staff/README.md)。

```sh
node --test scripts/tests/*.test.mjs
node scripts/validate-staff-data.mjs
node scripts/import-staff-media.mjs --check
```

# Twitter Card 缓存刷新

如果站点分享图已经更新，但 Twitter 仍然显示旧缓存，可以使用 Twitter Card Validator 强制重新抓取页面：

1. 打开 [Twitter Card Validator](https://cards-dev.twitter.com/validator)。
2. 在输入框里填入你的页面链接。
3. 点击 `Preview card`。

这样会让 Twitter 重新抓取网页并更新缓存。
