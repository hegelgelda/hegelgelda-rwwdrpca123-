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
# app.js が fetch するデータ。まとめて1つのハッシュにし、js に埋める
DATA_DIR = os.path.join(REPO, "public", "data1")


def digest(path: str) -> str:
    with open(path, "rb") as f:
        # 改行コードを揃えてから取る。CRLF で checkout されても同じ値になる
        body = f.read().replace(b"\r\n", b"\n")
    return hashlib.sha1(body).hexdigest()[:8]


def data_digest() -> str:
    """public/data1/ 全体のハッシュ。

    JSON にもバージョンを付けないと、データを作り直しても
    GitHub Pages の 10 分キャッシュで古いものが使われ続ける。
    実際それで「日本時間の列だけ出ない」状態になった。
    """
    h = hashlib.sha1()
    for root, dirs, files in os.walk(DATA_DIR):
        dirs.sort()
        for name in sorted(files):
            p = os.path.join(root, name)
            h.update(os.path.relpath(p, DATA_DIR).replace(os.sep, "/").encode())
            with open(p, "rb") as f:
                h.update(f.read())
    return h.hexdigest()[:8]


def stamp_data(check: bool) -> tuple[bool, str]:
    """js/app.js の DATA_V を書き換える。返り値は (変わったか, 説明)"""
    p = os.path.join(REPO, "js", "app.js")
    src = io.open(p, encoding="utf-8").read()
    v = data_digest()
    pat = re.compile(r"(const DATA_V = ')([0-9a-z]+)(')")
    hit = pat.search(src)
    if not hit:
        print("  ! js/app.js に DATA_V が無い")
        sys.exit(1)
    if hit.group(2) == v:
        return False, ""
    if not check:
        io.open(p, "w", encoding="utf-8", newline="\n").write(
            pat.sub(lambda m: m.group(1) + v + m.group(3), src, count=1))
    return True, f"public/data1/  {hit.group(2)} → {v}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="書き換えずに、ずれていたら 1 を返す")
    a = ap.parse_args()

    # ★ データ → app.js → index.html の順。
    #   DATA_V を書き換えると app.js のハッシュも変わるので、先にやる。
    moved, note = stamp_data(a.check)
    changed = [note] if moved else []

    html = io.open(PAGE, encoding="utf-8").read()
    out = html

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
