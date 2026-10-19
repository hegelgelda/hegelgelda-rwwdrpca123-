"""
build_page1.py — public/data1/ を作り直す（このリポジトリ用）

nba.duckdb はリポジトリに入っていない。場所を --db で渡すか、
環境変数 NBA_DUCKDB を設定しておく。既定は C:/nba/nba.duckdb。

    python tools/build_page1.py
    python tools/build_page1.py --db D:/data/nba.duckdb
"""


from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone

import duckdb

HERE = os.path.dirname(os.path.abspath(__file__))        # tools/
REPO = os.path.abspath(os.path.join(HERE, ".."))
# nba.duckdb はリポジトリに入れない。外から場所を渡す
DEFAULT_DB = (os.environ.get("NBA_DUCKDB")
              or os.path.join(REPO, "nba.duckdb")
              or "C:/nba/nba.duckdb")
if not os.path.exists(DEFAULT_DB):
    DEFAULT_DB = "C:/nba/nba.duckdb"
DEFAULT_OUT = os.path.join(REPO, "public", "data1")

SEASON = "2026-27"
PREV = "2025-26"


def q(s: str) -> str:
    return " ".join(s.split())


def clean(v):
    """NaN / NaT / 空文字を None にする。

    ★ pandas の NaN は**真値**なので `if v else None` では落とせない。
      ここを怠ると json.dump が `NaN` を書き、ブラウザで JSON parse が失敗する。
    """
    if v is None:
        return None
    if isinstance(v, float) and v != v:      # NaN
        return None
    if isinstance(v, str) and not v.strip():
        return None
    return v


def has_table(con, name: str) -> bool:
    """その表が DB にあるか。

    GitHub Actions では日程とロスターだけを取り直すので、
    929MB の DB にしか無い表（player_game_base など）が存在しない。
    無いときは既存の JSON を使い回して、壊さずに進める。
    """
    return bool(con.execute(
        "select count(*) from information_schema.tables "
        "where table_schema = 'main' and table_name = ?", [name]).fetchone()[0])


def read_json(out: str, name: str):
    """既にコミットしてある JSON を読む。無ければ None"""
    p = os.path.join(out, name)
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def keep(out: str, name: str) -> int:
    """作り直さずに残す。サイズだけ数える"""
    p = os.path.join(out, name)
    if not os.path.exists(p):
        raise SystemExit(f"  ! {name} が無く、作り直す材料も無い")
    n = os.path.getsize(p)
    print(f"  {name:18s} {n / 1024:8,.1f} KB  (据え置き)")
    return n


def write(out: str, name: str, obj) -> int:
    p = os.path.join(out, name)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        # allow_nan=False: NaN が残っていたらここで例外にする（壊れた JSON を出さない）
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"),
                  allow_nan=False)
    n = os.path.getsize(p)
    print(f"  {name:18s} {n / 1024:8,.1f} KB")
    return n


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--out", default=DEFAULT_OUT)
    a = ap.parse_args()
    con = duckdb.connect(a.db, read_only=True)
    # ★ 試合開始時刻は ET で出す。
    #   `tip_et` 列は「ET の壁時計を UTC として格納した値」なので、
    #   そのまま strftime すると実行環境の TZ でずれる（JST だと 00:00 等になる）。
    #   正しいのは **tip_utc を America/New_York で描画**すること。
    #   検算: game_date と tip_utc の ET 日付は全レギュラー 15,645 件すべて一致。
    con.execute("set TimeZone='America/New_York'")
    os.makedirs(a.out, exist_ok=True)
    print(f"出力先: {a.out}\n")
    tot = 0

    # ---------------------------------------------------------- teams
    # team_dim はほぼ動かない。CI の小さい DB には無いので、
    # 無ければ既にコミットしてある teams.json をそのまま残す。
    if has_table(con, "team_dim"):
        t = con.execute(q("""
            select tri, full_name, conference, division, city
            from team_dim order by conference, division, tri""")).df()
        tot += write(a.out, "teams.json", t.to_dict("records"))
    else:
        tot += keep(a.out, "teams.json")

    # ---------------------------------------------------------- schedule
    # ★ 日本時間も一緒に出す。
    #   ET→JST は +13h(EDT) と +14h(EST) で切り替わるので、
    #   ブラウザ側で足し算せず、ここで tip_utc を Asia/Tokyo に落として渡す。
    #   `tjo` は ET の試合日から見た JST の日付のずれ（ほぼ常に +1）。
    s = con.execute(q(f"""
        select game_id,
               strftime(game_date, '%Y-%m-%d') as d,
               strftime(tip_utc, '%H:%M')      as t,
               strftime(tip_utc AT TIME ZONE 'Asia/Tokyo', '%H:%M') as tj,
               datediff('day', game_date,
                        (tip_utc AT TIME ZONE 'Asia/Tokyo')::date)  as tjo,
               away_tri as a, home_tri as h,
               arena_name as arena, arena_city as city,
               national_tv as tv, game_label as label,
               game_status as st
        from game_schedule
        where season = '{SEASON}'
          and substr(game_id, 3, 1) = '2'
          and home_team_id <> 0 and away_team_id <> 0
        order by game_date, tip_et""")).df()
    s = s.astype(object).where(s.notna(), None)
    tot += write(a.out, "schedule.json", {
        "season": SEASON,
        "games": s.to_dict("records"),
    })

    # ---------------------------------------------------------- rosters
    # 前季の平均成績（レギュラーのみ）。無い選手は null。
    # ★ 試合ログの表が無い（CI の小さい DB）ときは、
    #   既存の rosters.json から player_id 引きで持ってくる。
    #   前季の成績はもう動かないので、作り直す必要が無い。
    STAT = ("g", "mpg", "ppg", "rpg", "apg")
    if has_table(con, "player_game_base") and has_table(con, "team_game_adv"):
        prev_of = None
    else:
        old = read_json(a.out, "rosters.json")
        if not old:
            raise SystemExit("  ! 試合ログも既存の rosters.json も無い")
        prev_of = {p["id"]: {k: p.get(k) for k in STAT}
                   for ps in old["teams"].values() for p in ps}
        print(f"  （試合ログの表が無いので前季成績は据え置き: "
              f"{len(prev_of):,} 名ぶん）")

    prev = None if prev_of is not None else con.execute(q(f"""
        select b.player_id,
               count(*) as g,
               round(avg(split_part(b.min_sec,':',1)::double
                         + split_part(b.min_sec,':',2)::double/60), 1) as mpg,
               round(avg(b.pts), 1) as ppg,
               round(avg(b.reb), 1) as rpg,
               round(avg(b.ast), 1) as apg
        from player_game_base b
        join (select distinct game_id from team_game_adv
              where season_fetched = '{PREV}'
                and season_type = 'Regular Season') t using (game_id)
        where b.min is not null
        group by 1""")).df().set_index("player_id")

    r = con.execute(q(f"""
        select tri, player_id, player_name, jersey, position, height,
               weight, age, exp, school, how_acquired,
               coalesce(supplemental_status, 0) as two_way
        from team_roster where season = '{SEASON}'
        order by tri, try_cast(jersey as int) nulls last, player_name""")).df()

    by: dict[str, list] = {}
    for x in r.itertuples():
        if prev_of is not None:
            p = prev_of.get(int(x.player_id)) or {}
        else:
            p = (prev.loc[x.player_id].to_dict()
                 if x.player_id in prev.index else {})
        by.setdefault(x.tri, []).append({
            "id": int(x.player_id),
            "name": x.player_name,
            "num": clean(x.jersey),
            "pos": clean(x.position),
            "ht": clean(x.height),
            "wt": None if x.weight != x.weight else int(x.weight),
            "age": None if x.age != x.age else round(float(x.age), 1),
            "exp": clean(x.exp),
            "school": clean(x.school),
            "acq": clean(x.how_acquired),
            "tw": int(x.two_way),
            # 前季の成績（無ければ null）
            "g": int(p["g"]) if p.get("g") is not None else None,
            "mpg": clean(p.get("mpg")) if p else None,
            "ppg": clean(p.get("ppg")) if p else None,
            "rpg": clean(p.get("rpg")) if p else None,
            "apg": clean(p.get("apg")) if p else None,
        })
    tot += write(a.out, "rosters.json", {"season": SEASON, "prev": PREV,
                                         "teams": by})

    # ---------------------------------------------------------- manifest
    tot += write(a.out, "manifest.json", {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "season": SEASON,
        "n_games": len(s),
        "n_players": len(r),
        "note": "日程は NBA Cup のノックアウト 24 試合を含まない（12月に確定）",
    })
    print(f"\n  合計 {tot / 1024:,.1f} KB / 試合 {len(s):,} / 選手 {len(r):,}")
    con.close()


if __name__ == "__main__":
    main()
