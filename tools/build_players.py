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

HERE = os.path.dirname(os.path.abspath(__file__))        # tools/
REPO = os.path.abspath(os.path.join(HERE, ".."))
DEFAULT_DB = (os.environ.get("NBA_DUCKDB")
              or os.path.join(REPO, "nba.duckdb"))
if not os.path.exists(DEFAULT_DB):
    DEFAULT_DB = "C:/nba/nba.duckdb"
DEFAULT_OUT = os.path.join(REPO, "public", "data1")

SEASON = "2026-27"
# player_game_base が持っている最も古いシーズン。選手ページに注記として出す
FIRST = "2014-15"


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

    ids = [int(x[0]) for x in con.execute(
        f"select distinct player_id from team_roster where season = '{SEASON}'"
    ).fetchall()]
    print(f"対象 {len(ids):,} 名 → {pdir}\n")

    # シーズン × 種別で集計。出場した試合だけ（min is not null）
    rows = con.execute(q(f"""
        select player_id,
               any_value(player_name)                       as name,
               season_year                                  as y,
               season_type                                  as st,
               string_agg(distinct team_abbreviation, '/')  as teams,
               count(*)                                     as g,
               sum(split_part(min_sec,':',1)::double
                   + split_part(min_sec,':',2)::double/60)  as mp,
               sum(fgm) as fgm, sum(fga) as fga,
               sum(fg3m) as tpm, sum(fg3a) as tpa,
               sum(ftm) as ftm, sum(fta) as fta,
               sum(oreb) as oreb, sum(dreb) as dreb, sum(reb) as reb,
               sum(ast) as ast, sum(stl) as stl, sum(blk) as blk,
               sum(tov) as tov, sum(pf) as pf, sum(pts) as pts,
               sum(plus_minus) as pm
        from player_game_base
        where min is not null
          and player_id in ({','.join(str(i) for i in ids)})
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

    SUMS = ["g", "mp", "fgm", "fga", "tpm", "tpa", "ftm", "fta", "oreb",
            "dreb", "reb", "ast", "stl", "blk", "tov", "pf", "pts", "pm"]

    n_file = n_byte = 0
    for pid, grp in rows.groupby("player_id", sort=False):
        seasons, career = [], {}
        for x in grp.to_dict("records"):
            st = "P" if x["st"] == "Playoffs" else (
                "I" if x["st"] == "PlayIn" else "R")
            seasons.append(line(x, None, x["y"], st, x["teams"]))
            # 通算はレギュラーシーズンのみ（Basketball-Reference と同じ）
            if st == "R":
                for k in SUMS:
                    career[k] = career.get(k, 0) + x[k]

        obj = {
            "id": int(pid),
            "name": grp["name"].iloc[0],
            "first": FIRST,
            "seasons": seasons,
            "career": line(career, "通算") if career else None,
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
