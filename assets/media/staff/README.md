# 用户素材目录

这里仅存放导入脚本生成的网页成品。每个用户使用一个小写 ASCII 稳定目录键，
再由 `assets/data/data.json` 的 `mediaFolder` 字段显式关联；不要根据姓名或 X
账号自动猜测目录。

将原始目录中的 1～4 个 JPG、PNG、WebP、MOV 或 MP4 导入：

本机需要可直接执行 `ffmpeg`、`ffprobe`、ImageMagick 的 `magick` 和
WebP 工具 `cwebp`。

```sh
node scripts/import-staff-media.mjs \
  --source "/绝对路径/用户素材" \
  --folder user-stable-key
```

脚本会删除元数据并生成列表图、灯箱图、视频封面、低码率列表视频和最高 720p
高清 MP4。需要有意替换现有目录时追加 `--replace`。提交前执行：

```sh
node scripts/import-staff-media.mjs --check
```

不要手工改动子目录内的 `media.json` 或派生文件；原始下载目录不复制进仓库。
