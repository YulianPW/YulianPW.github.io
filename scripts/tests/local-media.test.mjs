import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const LOCAL_MEDIA_MODULE_SOURCE = await readFile(
  new URL(
    "../../assets/x-embed-preview/scripts/media/local.js",
    import.meta.url,
  ),
  "utf8",
);
const MEDIA_VERSION = "a".repeat(40);
const MEDIA_MANIFEST = Object.freeze({
  version: 1,
  items: [
    {
      type: "photo",
      url: "01-full.webp",
      preview: "01-inline.webp",
      poster: "",
      variants: [],
      width: 800,
      height: 1200,
      alt: "",
    },
    {
      type: "video",
      url: "02-full.mp4",
      preview: "",
      poster: "02-poster.webp",
      variants: [{ url: "02-inline.mp4", bitrate: 128000 }],
      width: 1280,
      height: 720,
      alt: "",
    },
  ],
});

/**
 * 为每个用例加载具有独立模块状态的媒体适配器。
 *
 * @param {string} label - 用于避免 ESM 缓存复用的用例标识。
 * @returns {Promise<typeof import("../../assets/x-embed-preview/scripts/media/local.js")>}
 * 独立的媒体适配器模块。
 */
function importLocalMediaModule(label) {
  const encodedSource = Buffer.from(LOCAL_MEDIA_MODULE_SOURCE).toString(
    "base64",
  );
  return import(`data:text/javascript;base64,${encodedSource}#${label}`);
}

/**
 * 创建媒体清单 fetch 响应替身。
 *
 * @param {number} [status=200] - HTTP 状态码。
 * @returns {{ok: boolean, status: number, json: () => Promise<object>}}
 * 适配器所需的最小 Response 接口。
 */
function createManifestResponse(status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return structuredClone(MEDIA_MANIFEST);
    },
  };
}

/**
 * 安装媒体适配器运行所需的最小浏览器环境，并返回恢复函数。
 *
 * @param {(input: URL, init: RequestInit) => Promise<object>} fetchImpl -
 * 当前用例的网络替身。
 * @param {{saveData?: boolean, effectiveType?: string}} [connection={}] -
 * Network Information API 状态。
 * @returns {() => void} 恢复 Node 全局对象的方法。
 */
function installBrowserEnvironment(fetchImpl, connection = {}) {
  const names = ["window", "document", "navigator", "fetch"];
  const originals = new Map(
    names.map((name) => [
      name,
      Object.getOwnPropertyDescriptor(globalThis, name),
    ]),
  );
  const pageUrl = new URL("https://yulianpw.github.io/");

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: pageUrl,
      setTimeout,
      clearTimeout,
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { baseURI: pageUrl.href },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { connection },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: fetchImpl,
  });

  return () => {
    names.forEach((name) => {
      const descriptor = originals.get(name);
      if (descriptor) {
        Object.defineProperty(globalThis, name, descriptor);
      } else {
        delete globalThis[name];
      }
    });
  };
}

test("本地媒体来源选择", async (context) => {
  await context.test("CDN 在 500ms 内成功时不启动 Pages", async (t) => {
    const calls = [];
    const restore = installBrowserEnvironment(async (input, init) => {
      calls.push({ url: String(input), init });
      return createManifestResponse();
    });
    t.after(restore);
    const { fetchLocalMedia } = await importLocalMediaModule("cdn-fast");

    const media = await fetchLocalMedia(
      "sample",
      "测试用户",
      MEDIA_VERSION,
    );

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^https:\/\/cdn\.jsdelivr\.net\/gh\//);
    assert.equal(calls[0].init.credentials, "omit");
    assert.match(media.items[0].url, /^https:\/\/cdn\.jsdelivr\.net\//);
    assert.equal(
      new URL(media.items[0].fallbackUrl).origin,
      "https://yulianpw.github.io",
    );
    assert.equal(
      new URL(media.items[1].variants[0].fallbackUrl).searchParams.get("v"),
      MEDIA_VERSION,
    );
  });

  await context.test("CDN 返回 404 时立即改用 Pages", async (t) => {
    const calls = [];
    const restore = installBrowserEnvironment(async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      return url.startsWith("https://cdn.jsdelivr.net/")
        ? createManifestResponse(404)
        : createManifestResponse();
    });
    t.after(restore);
    const { fetchLocalMedia } = await importLocalMediaModule("cdn-missing");

    const media = await fetchLocalMedia(
      "sample",
      "测试用户",
      MEDIA_VERSION,
    );

    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /^https:\/\/cdn\.jsdelivr\.net\//);
    assert.match(calls[1].url, /^https:\/\/yulianpw\.github\.io\//);
    assert.equal(calls[1].init.credentials, "same-origin");
    assert.equal(media.items[0].fallbackUrl, "");
  });

  await context.test(
    "CDN 超过 500ms 时由 Pages 胜出并在本页复用",
    async (t) => {
      const calls = [];
      let cdnWasAborted = false;
      const restore = installBrowserEnvironment((input, init) => {
        const url = String(input);
        calls.push({ url, init });
        if (!url.startsWith("https://cdn.jsdelivr.net/")) {
          return Promise.resolve(createManifestResponse());
        }

        return new Promise((resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => {
              cdnWasAborted = true;
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
      });
      t.after(restore);
      const { fetchLocalMedia } = await importLocalMediaModule("pages-wins");

      const firstMedia = await fetchLocalMedia(
        "first",
        "测试用户",
        MEDIA_VERSION,
      );
      const secondMedia = await fetchLocalMedia(
        "second",
        "测试用户",
        MEDIA_VERSION,
      );

      assert.equal(cdnWasAborted, true);
      assert.equal(calls.length, 3);
      assert.match(calls[0].url, /^https:\/\/cdn\.jsdelivr\.net\//);
      assert.match(calls[1].url, /^https:\/\/yulianpw\.github\.io\//);
      assert.match(calls[2].url, /^https:\/\/yulianpw\.github\.io\//);
      assert.match(firstMedia.items[0].url, /^https:\/\/yulianpw\.github\.io\//);
      assert.match(secondMedia.items[0].url, /^https:\/\/yulianpw\.github\.io\//);
    },
  );

  await context.test("省流量或 2G/3G 只请求同源 Pages", async (t) => {
    const calls = [];
    const restore = installBrowserEnvironment(
      async (input, init) => {
        calls.push({ url: String(input), init });
        return createManifestResponse();
      },
      { effectiveType: "3g" },
    );
    t.after(restore);
    const { fetchLocalMedia } = await importLocalMediaModule("constrained");

    const media = await fetchLocalMedia(
      "sample",
      "测试用户",
      MEDIA_VERSION,
    );

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^https:\/\/yulianpw\.github\.io\//);
    assert.equal(calls[0].init.credentials, "same-origin");
    assert.equal(media.items[0].fallbackUrl, "");
  });

  await context.test("缺少完整媒体 commit 时兼容本地 Pages", async (t) => {
    const calls = [];
    const restore = installBrowserEnvironment(async (input, init) => {
      calls.push({ url: String(input), init });
      return createManifestResponse();
    });
    t.after(restore);
    const { fetchLocalMedia } = await importLocalMediaModule("no-commit");

    await fetchLocalMedia("sample", "测试用户", "20251114");

    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^https:\/\/yulianpw\.github\.io\//);
    assert.equal(calls[0].init.credentials, "same-origin");
  });

  await context.test("调用方取消时不会继续启动 Pages", async (t) => {
    const calls = [];
    const restore = installBrowserEnvironment((input, init) => {
      calls.push({ url: String(input), init });
      return new Promise((resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    });
    t.after(restore);
    const { fetchLocalMedia } = await importLocalMediaModule("aborted");
    const requestController = new AbortController();

    const request = fetchLocalMedia(
      "sample",
      "测试用户",
      MEDIA_VERSION,
      requestController.signal,
    );
    requestController.abort();

    await assert.rejects(request, { name: "AbortError" });
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /^https:\/\/cdn\.jsdelivr\.net\//);
  });

  await context.test("两个来源都拒绝越界文件名", async (t) => {
    const invalidManifest = structuredClone(MEDIA_MANIFEST);
    invalidManifest.items[0].url = "../outside.webp";
    const restore = installBrowserEnvironment(async () => ({
      ok: true,
      status: 200,
      async json() {
        return structuredClone(invalidManifest);
      },
    }));
    t.after(restore);
    const { fetchLocalMedia } = await importLocalMediaModule("invalid-path");

    await assert.rejects(
      fetchLocalMedia("sample", "测试用户", MEDIA_VERSION),
      /本地素材文件名无效/,
    );
  });
});
