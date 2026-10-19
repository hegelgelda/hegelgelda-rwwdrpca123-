"""
stamp_assets.py — index.html の css/js 参照に ?v=<中身のハッシュ> を付ける

GitHub Pages は静的ファイルを `Cache-Control: max-age=600` で返すので、
app.js や style.css を直せても訪問済みのブラウザには最大10分届かない。
参照 URL を中身のハッシュで変えて、別ファイル扱いにさせる。

**css/js を直したら、コミットの前にこれを走らせる。**

    python tools/stamp_assets.py
    python tools/stamp_assets.py --check   # ずれていたら終了コード 1

ハッシュなので、中身が変わらなければ URL も変わらない
（手で数字を上げるより取りこぼしが無い）。
"""


from __future__ import annotations

import argparse
import hashlib
import io
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
PAGE = os.path.join(REPO, "index.html")

# index.html が参照している、ハッシュを付けたいファイル
ASSETS = ["css/style.css", "js/app.js"]


def digest(path: str) -> str:
    with open(path, "rb") as f:
        # 改行コードを揃えてから取る。CRLF で checkout されても同じ値になる
        body = f.read().replace(b"\r\n", b"\n")
    return hashlib.sha1(body).hexdigest()[:8]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="書き換えずに、ずれていたら 1 を返す")
    a = ap.parse_args()

    html = io.open(PAGE, encoding="utf-8").read()
    out, changed = html, []

    for rel in ASSETS:
        p = os.path.join(REPO, rel.replace("/", os.sep))
        if not os.path.exists(p):
            print(f"  ! {rel} が無い")
            return 1
        v = digest(p)
        # ./css/style.css も ./css/style.css?v=xxxxxxxx も拾う
        pat = re.compile(r'(\./' + re.escape(rel) + r')(\?v=[0-9a-f]+)?')
        hit = pat.search(out)
        if not hit:
            print(f"  ! index.html が {rel} を参照していない")
            return 1
        now = (hit.group(2) or "")[3:]
        if now != v:
            changed.append(f"{rel}  {now or '(なし)'} → {v}")
        out = pat.sub(lambda m: f"{m.group(1)}?v={v}", out, count=1)

    if not changed:
        print("  変更なし（ハッシュは最新）")
        return 0

    for line in changed:
        print(f"  {line}")
    if a.check:
        print("\n  index.html が古い。python tools/stamp_assets.py を走らせる")
        return 1

    io.open(PAGE, "w", encoding="utf-8", newline="\n").write(out)
    print(f"\n  index.html を書き換えた（{len(changed)} 件）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
