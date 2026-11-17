import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { encodeFullVideo } from "../import-staff-media.mjs";

function countVideoFrames(path) {
  const output = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-count_frames",
    "-show_entries", "stream=nb_read_frames", "-of", "json", path,
  ], { encoding: "utf8" });
  return Number(JSON.parse(output).streams[0].nb_read_frames);
}

test("高清转码保留可变帧率视频的所有帧", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "staff-media-vfr-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "source.mp4");
  const output = join(directory, "output.mp4");

  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-f", "lavfi", "-i",
    "testsrc2=size=160x120:rate=60:duration=10",
    "-vf", "settb=1/60000,setpts=PTS-floor(N/60)*600",
    "-fps_mode", "passthrough", "-enc_time_base", "1/60000",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", source,
  ]);

  const sourceFrames = countVideoFrames(source);
  assert.equal(sourceFrames, 600);
  encodeFullVideo(source, output, 21, null);
  assert.equal(countVideoFrames(output), sourceFrames);
});
