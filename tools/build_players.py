"""
build_players.py — public/data1/players/<id>.json を作る

選手ページ用。シーズンごとの平均成績（Basketball-Reference の
"Per Game" に相当）を選手1人1ファイルで配る。1ファイル 1〜3 KB なので
選手ページを開いたときだけ取りにいけばよい。

対象は 2026-27 のロスターに載っている 526 名。

    python tools/build_players.py
    python tools/build_players.py --db D:/data/nba.duckdb
"""


from __future__ import annotations

import argparse
import json
import os
import shutil
from datetime import datetime, timezone

import duckdb

import ddi as ddi_mod

HERE = os.path.dirname(os.path.abspath(__file__))        # tools/
REPO = os.path.abspath(os.path.join(HERE, ".."))
DEFAULT_DB = (os.environ.get("NBA_DUCKDB")
              or os.path.join(REPO, "nba.duckdb"))
if not os.path.exists(DEFAULT_DB):
    DEFAULT_DB = "C:/nba/nba.duckdb"
DEFAULT_OUT = os.path.join(REPO, "public", "data1")

SEASON = "2026-27"
# 選手ページに出す最も古いシーズン。注記としても表示する。
# DB は 2014-15 から持っているが、ここより前は出さない
FIRST = "2021-22"

# 出場時間の分布に使う範囲。1シーズンと3シーズンの2通りを出す
DIST1 = "2025-26"
DIST3 = ("2023-24", "2025-26")
BIN = 2          # 分
NBIN = 24        # 0〜46分+。最後の箱は 46 分以上（延長戦があるので上は開く）

# 起用ブレ指数（DDI）。読み込みは ddi.py に置いて build_page1.py と共有する


def q(s: str) -> str:
    return " ".join(s.split())


def r1(v, dig=1):
    """None と NaN を潰して丸める。

    ★ build_page1.py と同じ理由で NaN をここで落とす。
      pandas の NaN は真値なので `if v else None` では消えない。
    """
    if v is None or v != v:
        return None
    return round(float(v), dig)


def pct(made, att, dig=3):
    """率は平均の平均ではなく**合計から出す**。
    試合ごとの fg_pct を平均すると出場時間の短い試合に引っ張られる。
    """
    if not att:
        return None
    return round(made / att, dig)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--out", default=DEFAULT_OUT)
    a = ap.parse_args()
    con = duckdb.connect(a.db, read_only=True)
    pdir = os.path.join(a.out, "players")
    # 移籍などで居なくなった選手のファイルを残さない
    if os.path.isdir(pdir):
        shutil.rmtree(pdir)
    os.makedirs(pdir, exist_ok=True)

    ddi = ddi_mod.load()

    ids = [int(x[0]) for x in con.execute(
        f"select distinct player_id from team_roster where season = '{SEASON}'"
    ).fetchall()]
    print(f"対象 {len(ids):,} 名 → {pdir}\n")

    # シーズン × 種別で集計。出場した試合だけ（min is not null）。
    # 先発は panel_start。2021-22 以降は欠けが無いのを確認済み。
    # ★ SQL 内に -- コメントを書かないこと。q() が改行を潰すので、
    #   以降のクエリ全体がコメント扱いになって消える。
    rows = con.execute(q(f"""
        select player_id,
               any_value(player_name)                       as name,
               season_year                                  as y,
               season_type                                  as st,
               array_to_string(list_distinct(
                   list(team_abbreviation order by game_date)), '/') as teams,
               count(*)                                     as g,
               sum(coalesce(st.started, 0))                 as gs,
               sum(split_part(min_sec,':',1)::double
                   + split_part(min_sec,':',2)::double/60)  as mp,
               sum(fgm) as fgm, sum(fga) as fga,
               sum(fg3m) as tpm, sum(fg3a) as tpa,
               sum(ftm) as ftm, sum(fta) as fta,
               sum(oreb) as oreb, sum(dreb) as dreb, sum(reb) as reb,
               sum(ast) as ast, sum(stl) as stl, sum(blk) as blk,
               sum(tov) as tov, sum(pf) as pf, sum(pts) as pts,
               sum(plus_minus) as pm
        from player_game_base b
        left join panel_start st using (game_id, player_id)
        where b.min is not null
          and b.season_year >= '{FIRST}'
          and b.player_id in ({','.join(str(i) for i in ids)})
        group by player_id, season_year, season_type
        order by player_id, season_year, season_type
    """)).fetchdf()

    def line(d, label, y=None, st=None, teams=None):
        """合計の dict から1行ぶんの平均を作る"""
        g = int(d["g"])
        per = lambda k: r1(d[k] / g)                          # noqa: E731
        return {
            "y": y, "st": st, "teams": teams, "label": label,
            "g": g,
            "gs": int(d["gs"]),
            "mpg": r1(d["mp"] / g),
            "fgm": per("fgm"), "fga": per("fga"),
            "fg": pct(d["fgm"], d["fga"]),
            "tpm": per("tpm"), "tpa": per("tpa"),
            "tp": pct(d["tpm"], d["tpa"]),
            "ftm": per("ftm"), "fta": per("fta"),
            "ft": pct(d["ftm"], d["fta"]),
            "oreb": per("oreb"), "dreb": per("dreb"), "reb": per("reb"),
            "ast": per("ast"), "stl": per("stl"), "blk": per("blk"),
            "tov": per("tov"), "pf": per("pf"), "pts": per("pts"),
            "pm": r1(d["pm"] / g),
            # TS% も合計から。 PTS / (2 * (FGA + 0.44 * FTA))
            "ts": pct(d["pts"], 2 * (d["fga"] + 0.44 * d["fta"])),
        }

    SUMS = ["g", "gs", "mp", "fgm", "fga", "tpm", "tpa", "ftm", "fta", "oreb",
            "dreb", "reb", "ast", "stl", "blk", "tov", "pf", "pts", "pm"]

    # ---------------------------------------------------- 出場時間の分布
    # 選手ページの一番下に出すヒストグラム。
    # 「平均 30 分」が『毎試合 30 分』なのか『40 分と出番なしの往復』なのかは
    # 平均だけでは判らない。試合ごとの出場時間を数えて形を見せる。
    # レギュラーシーズンのみ。
    logs = con.execute(q(f"""
        select player_id,
               season_year as y,
               split_part(min_sec,':',1)::double
               + split_part(min_sec,':',2)::double/60 as m
        from player_game_base
        where min is not null
          and season_type = 'Regular Season'
          and season_year >= '{DIST3[0]}'
          and player_id in ({','.join(str(i) for i in ids)})
    """)).fetchdf()

    def hist(ms: list[float]) -> dict | None:
        """2分刻み 24 本。最後の箱は 46 分以上（延長戦で 48 を超える）"""
        if not ms:
            return None
        bins = [0] * NBIN
        for m in ms:
            bins[min(int(m // BIN), NBIN - 1)] += 1
        s = sorted(ms)
        n = len(s)
        med = s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2
        return {"n": n, "med": round(med, 1), "bins": bins}

    by_player: dict[int, dict] = {}
    for pid, g in logs.groupby("player_id", sort=False):
        one = hist(g.loc[g["y"] == DIST1, "m"].tolist())
        three = hist(g["m"].tolist())
        if one or three:
            by_player[int(pid)] = {"bin": BIN, "s1": one, "s3": three}

    n_file = n_byte = 0
    for pid, grp in rows.groupby("player_id", sort=False):
        seasons, career, recent = [], {}, {}
        for x in grp.to_dict("records"):
            st = "P" if x["st"] == "Playoffs" else (
                "I" if x["st"] == "PlayIn" else "R")
            seasons.append(line(x, None, x["y"], st, x["teams"]))
            # 通算はレギュラーシーズンのみ（Basketball-Reference と同じ）
            if st == "R":
                for k in SUMS:
                    career[k] = career.get(k, 0) + x[k]
                # 期待値モデルは直近3季だけを使う。
                # 役割が変わった選手で、古い季の率を混ぜないため
                if x["y"] >= DIST3[0]:
                    for k in SUMS:
                        recent[k] = recent.get(k, 0) + x[k]

        obj = {
            "id": int(pid),
            "name": grp["name"].iloc[0],
            "first": FIRST,
            "seasons": seasons,
            "career": line(career, "通算") if career else None,
            # 期待値モデル用。DIST3 の範囲（レギュラーのみ）の合計
            "r3": line(recent, f"{DIST3[0]} 〜 {DIST3[1]}") if recent else None,
            "dist": by_player.get(int(pid)),
            "ddi": ddi.get(int(pid)),
            "d1": DIST1,
            "d3": f"{DIST3[0]} 〜 {DIST3[1]}",
        }
        p = os.path.join(pdir, f"{pid}.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"),
                      allow_nan=False)
        n_file += 1
        n_byte += os.path.getsize(p)

    # 1試合も出ていない選手（新人など）は上の group に現れない
    missing = len(ids) - n_file
    with open(os.path.join(a.out, "players_index.json"), "w",
              encoding="utf-8") as f:
        json.dump({
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "first_season": FIRST,
            "ids": sorted(int(x) for x in rows["player_id"].unique()),
        }, f, separators=(",", ":"))

    print(f"  players/*.json  {n_file:>4,} ファイル "
          f"{n_byte / 1024:8,.1f} KB（平均 {n_byte / n_file / 1024:.1f} KB）")
    print(f"  出場記録なし    {missing:>4,} 名（{FIRST} 以降に出場が無い）")
    con.close()


if __name__ == "__main__":
    main()
