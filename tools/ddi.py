"""
ddi.py — 起用ブレ指数（DDI）を読む

別途計算した `ddi_2627.parquet` を person_id 引きの辞書にするだけ。
ここでは再計算しない。定義と検算は `DDI_2627.md`。

`build_page1.py`（ロスター表）と `build_players.py`（選手ページ）の
両方から使う。

★ 生の DDI は出場時間の水準と独立ではない（相関 −0.16、DDI_2627.md §7）。
  選手どうしを横に並べるのは**帯内パーセンタイル** `p25` / `p3` の側。
  生の値だけを並べると、出番の長い選手が一律に低く見える。
★ `flag_no_data = 1` は 2023-24 以降に出場が無く DDI = 100 を
  置いただけの行。平均値そのものなので数値として出さない。
"""


from __future__ import annotations

import os

HERE = os.path.dirname(os.path.abspath(__file__))
DDI_FILE = os.path.join(HERE, "ddi_2627.parquet")

# パーセンタイルが出る試合数の下限（DDI_2627.md §5）
MIN_25 = 20
MIN_3Y = 40


def _num(v, dig=1):
    return None if v is None or v != v else round(float(v), dig)


def load(quiet: bool = False) -> dict[int, dict]:
    """person_id -> DDI の辞書。ファイルが無ければ空"""
    if not os.path.exists(DDI_FILE):
        if not quiet:
            print(f"  （{os.path.basename(DDI_FILE)} が無いので DDI は付けない）")
        return {}
    import pandas as pd
    d = pd.read_parquet(DDI_FILE)

    out = {}
    for x in d.itertuples():
        nodata = int(x.flag_no_data) == 1
        out[int(x.person_id)] = {
            "nodata": 1 if nodata else 0,
            # 1季（2025-26）と3季（2023-24〜2025-26）
            "d25": None if nodata else _num(x.DDI_25),
            "n25": int(x.n_25),
            "p25": _num(x.pct_25),
            "d3": None if nodata else _num(x.DDI_3y),
            "n3": int(x.n_3y),
            "p3": _num(x.pct_3y),
            "band": None if nodata else x.band_25,
            # 帯を合併した / 直近に出場した季の帯で代用した行
            "merged": int(x.pct_band_merged),
        }
    if not quiet:
        n = sum(1 for v in out.values() if not v["nodata"])
        print(f"  DDI: {len(out):,} 名（数値あり {n:,} 名）")
    return out
