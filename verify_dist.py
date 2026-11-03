#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""产物校验（零第三方依赖）—— 发布前的最后一道闸。

用法：
    python verify_dist.py            # 用 build.py 里的默认版本
    python verify_dist.py 1.0.2      # 校验指定版本

检查项：
  1. dist/chrome、dist/firefox 两个目录存在且结构完整
  2. 两个 manifest.json 的 version 与期望版本一致
  3. Chrome 是 MV3、Firefox 是 MV2（装错版本会导致「点翻译没反应」）
  4. 必需脚本、弹窗、四个尺寸图标齐全
  5. 两个压缩包存在，且包内首层就有 manifest.json
  6. 压缩包内的文件清单与目录一致（防止漏打包）

任何一项不通过，退出码为 1。
"""
import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(ROOT, "dist")

REQUIRED = ["manifest.json", "shared.js", "background.js", "content.js",
            "popup.html", "popup.css", "popup.js"]
ICONS = ["icons/icon16.png", "icons/icon32.png", "icons/icon48.png", "icons/icon128.png"]

errors = []
warnings = []


def check(cond, msg):
    print(("  [OK]   " if cond else "  [FAIL] ") + msg)
    if not cond:
        errors.append(msg)


def resolve_version():
    """期望版本：命令行 > 环境变量 > manifest（唯一真相源）> build.py 默认值。"""
    if len(sys.argv) > 1:
        return sys.argv[1].strip().lstrip("vV")
    if os.environ.get("PT_VERSION"):
        return os.environ["PT_VERSION"].strip().lstrip("vV")
    try:
        with open(os.path.join(ROOT, "src", "manifest.chrome.json"), encoding="utf-8") as fh:
            return json.load(fh)["version"]
    except Exception:
        return "1.0.1"


def main():
    expected = resolve_version()
    print("校验版本：%s\n" % expected)

    # ---------- 目录 ----------
    for target, want_mv in (("chrome", 3), ("firefox", 2)):
        d = os.path.join(DIST, target)
        print("[%s]" % target)
        if not os.path.isdir(d):
            check(False, "目录不存在 %s（先跑 python build.py）" % d)
            continue

        for f in REQUIRED:
            check(os.path.isfile(os.path.join(d, f)), "存在 %s" % f)
        for f in ICONS:
            check(os.path.isfile(os.path.join(d, f)), "存在 %s" % f)

        mf_path = os.path.join(d, "manifest.json")
        if os.path.isfile(mf_path):
            with open(mf_path, encoding="utf-8") as fh:
                mf = json.load(fh)
            check(mf.get("version") == expected,
                  "版本号 %r == %r" % (mf.get("version"), expected))
            check(mf.get("manifest_version") == want_mv,
                  "manifest_version == %d（实际 %r）" % (want_mv, mf.get("manifest_version")))

            # 清单里引用的图标文件必须真实存在，否则浏览器会拒绝加载
            for size, rel in (mf.get("icons") or {}).items():
                check(os.path.isfile(os.path.join(d, rel)),
                      "清单图标 icons.%s -> %s" % (size, rel))
        print()

    # ---------- 压缩包 ----------
    for name, target in (("page-translator-chrome-v%s.zip" % expected, "chrome"),
                         ("page-translator-firefox-v%s.xpi" % expected, "firefox")):
        print("[%s]" % name)
        p = os.path.join(DIST, name)
        if not os.path.isfile(p):
            check(False, "文件不存在")
            print()
            continue
        check(True, "存在，%.1f KB" % (os.path.getsize(p) / 1024))
        if zipfile.is_zipfile(p):
            with zipfile.ZipFile(p) as z:
                names = set(z.namelist())
                check("manifest.json" in names, "首层含 manifest.json（可直接加载）")
                # 包内版本必须与目标版本一致
                if "manifest.json" in names:
                    inner = json.loads(z.read("manifest.json").decode("utf-8"))
                    check(inner.get("version") == expected,
                          "包内版本号 == %s" % expected)
                d = os.path.join(DIST, target)
                if os.path.isdir(d):
                    on_disk = set()
                    for base, _dirs, files in os.walk(d):
                        for f in files:
                            full = os.path.join(base, f)
                            on_disk.add(os.path.relpath(full, d).replace("\\", "/"))
                    missing = on_disk - names
                    extra = names - on_disk
                    check(not missing, "包内无遗漏（缺 %d 个）" % len(missing))
                    check(not extra, "包内无多余（多 %d 个）" % len(extra))
                    if missing:
                        warnings.append("%s 缺少: %s" % (name, sorted(missing)[:5]))
        else:
            check(False, "不是有效 zip")
        print()

    print("=" * 46)
    if errors:
        print("校验失败：%d 项不通过" % len(errors))
        for e in errors:
            print("  - " + e)
        return 1
    print("校验通过：可以发布")
    return 0


if __name__ == "__main__":
    sys.exit(main())
