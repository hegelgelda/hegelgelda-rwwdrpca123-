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

import ddi as ddi_mod

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


def r1(v, dig=1):
    """None と NaN を潰して丸める。

    ★ 素の `round()` を使わないこと。`mp/g` がちょうど 11.85 のような
      境界に乗ると、浮動小数の最後の桁（11.84999... か 11.85000...）で
      11.8 と 11.9 が入れ替わる。join の行順が変わるだけで結果が動き、
      毎日の差分に無意味な揺れが出る（2026-11-01 に 3 選手で実際に出た）。
      一度多めの桁で丸めてから、0.5 は常に外側へ寄せる。
    """
    if v is None or v != v:
        return None
    v = round(float(v), dig + 6)
    f = 10 ** dig
    n = int(abs(v) * f + 0.5)
    return (n / f) if v >= 0 else -(n / f)


def pct(made, att, dig=3):
    """率は平均の平均ではなく**合計から出す**。"""
    if not att or att != att:
        return None
    return round(made / att, dig)


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

    # ------------------------------------------------------- standings
    # ★ `team_standings_daily` は使わない。`build_team_dim.py` が作る派生表で、
    #   進行中の季には追いついていない（2026-11-01 時点で 2025-26 止まり）。
    #   `team_game_adv` と `player_game_base` から直に作る。
    # ★ Advanced には PTS が無いので、得点はボックスの合計から取る。
    if has_table(con, "team_game_adv") and has_table(con, "player_game_base"):
        tg = con.execute(q(f"""
            with pts as (
              select game_id, team_abbreviation as tri, sum(pts) as pts
              from player_game_base
              where season_year = '{SEASON}' and season_type = 'Regular Season'
              group by 1, 2)
            select a.team_abbreviation as tri,
                   substr(a.game_date, 1, 10) as d,
                   a.wl,
                   case when position('vs.' in a.matchup) > 0 then 1 else 0 end as home,
                   a.off_rating, a.def_rating, a.pace, a.poss,
                   me.pts as pf, op.pts as pa
            from team_game_adv a
            join pts me on me.game_id = a.game_id
                       and me.tri = a.team_abbreviation
            join pts op on op.game_id = a.game_id
                       and op.tri <> a.team_abbreviation
            where a.season_year = '{SEASON}'
              and a.season_type = 'Regular Season'
            order by a.team_abbreviation, a.game_date
        """)).df()
        dim = con.execute(q("""
            select tri, full_name, conference, division from team_dim
        """)).df().set_index("tri").to_dict("index")

        rows = []
        for tri, grp in tg.groupby("tri", sort=False):
            r = grp.to_dict("records")
            w = sum(1 for x in r if x["wl"] == "W")
            last10 = r[-10:]
            # 連勝 / 連敗は末尾から同じ結果が続く数
            k = 0
            for x in reversed(r):
                if x["wl"] != r[-1]["wl"]:
                    break
                k += 1
            poss = sum(x["poss"] for x in r) or 1
            d = dim.get(tri, {})
            rows.append({
                "tri": tri,
                "name": d.get("full_name", tri),
                "conf": d.get("conference"), "div": d.get("division"),
                "g": len(r), "w": w, "l": len(r) - w,
                "pct": round(w / len(r), 3),
                "hw": sum(1 for x in r if x["home"] and x["wl"] == "W"),
                "hl": sum(1 for x in r if x["home"] and x["wl"] == "L"),
                "aw": sum(1 for x in r if not x["home"] and x["wl"] == "W"),
                "al": sum(1 for x in r if not x["home"] and x["wl"] == "L"),
                "w10": sum(1 for x in last10 if x["wl"] == "W"),
                "l10": sum(1 for x in last10 if x["wl"] == "L"),
                "stk": ("W" if r[-1]["wl"] == "W" else "L") + str(k),
                "pf": r1(sum(x["pf"] for x in r) / len(r)),
                "pa": r1(sum(x["pa"] for x in r) / len(r)),
                # ★ レーティングはポゼッションで重み付けする。
                #   試合ごとの率の単純平均ではない（ペースが違うとずれる）
                "ortg": r1(sum(x["off_rating"] * x["poss"] for x in r) / poss, 1),
                "drtg": r1(sum(x["def_rating"] * x["poss"] for x in r) / poss, 1),
                "pace": r1(sum(x["pace"] for x in r) / len(r), 1),
            })
        for x in rows:
            x["diff"] = r1(x["pf"] - x["pa"])
            x["net"] = r1(x["ortg"] - x["drtg"])
        # ゲーム差はカンファレンス内の首位から
        for conf in {x["conf"] for x in rows}:
            side = [x for x in rows if x["conf"] == conf]
            top = max(side, key=lambda x: (x["pct"], x["w"]))
            for x in side:
                x["gb"] = r1(((top["w"] - x["w"]) + (x["l"] - top["l"])) / 2)
        rows.sort(key=lambda x: (x["conf"] or "", -x["pct"], -x["w"]))
        tot += write(a.out, "standings.json", {
            "season": SEASON,
            "asof": max(tg["d"]) if len(tg) else None,
            "teams": rows,
        })
    else:
        tot += keep(a.out, "standings.json")

    # --------------------------------------------------- 今季の選手一覧
    # 並べ替えできる 1 枚の表にする。選手ページの JSON は 1 人 1 ファイルで、
    # 「今季の得点上位」を見るには全部開くしかなかった。
    # ★ 先発は `player_track.position`。`panel_start` は進行中の季に
    #   追いついていない（build_players.py と同じ理由）。
    # ★ `select distinct` を外さないこと。`player_track` には**同じ行が
    #   複数入りうる**（`fetch_tracking.py` は delete せず insert するだけ）。
    #   2026-11-01 に 3 試合が 3 重になり、試合数も合計も水増しされた。
    if has_table(con, "player_game_base") and has_table(con, "player_track"):
        pl = con.execute(q(f"""
            select b.player_id as id,
                   any_value(b.player_name) as n,
                   arg_max(b.team_abbreviation, b.game_date) as t,
                   count(*) as g,
                   sum(st.started) as gs,
                   sum(split_part(b.min_sec,':',1)::double
                       + split_part(b.min_sec,':',2)::double/60) as mp,
                   sum(b.pts) as pts, sum(b.reb) as reb, sum(b.ast) as ast,
                   sum(b.stl) as stl, sum(b.blk) as blk, sum(b.tov) as tov,
                   sum(b.fgm) as fgm, sum(b.fga) as fga,
                   sum(b.fg3m) as tpm, sum(b.fg3a) as tpa,
                   sum(b.ftm) as ftm, sum(b.fta) as fta,
                   sum(b.plus_minus) as pm
            from player_game_base b
            left join (
                select distinct game_id, person_id as player_id,
                       case when coalesce(trim(position), '') <> ''
                            then 1 else 0 end as started
                from player_track where person_id is not null) st
              using (game_id, player_id)
            where b.season_year = '{SEASON}'
              and b.season_type = 'Regular Season'
              and b.min is not null
            group by b.player_id
        """)).df()

        def per(x, k):
            return r1(x[k] / x["g"])

        plist = []
        for x in pl.to_dict("records"):
            plist.append({
                "id": int(x["id"]), "n": x["n"], "t": x["t"],
                "g": int(x["g"]),
                "gs": None if x["gs"] != x["gs"] else int(x["gs"]),
                "mpg": r1(x["mp"] / x["g"]),
                "pts": per(x, "pts"), "reb": per(x, "reb"),
                "ast": per(x, "ast"), "stl": per(x, "stl"),
                "blk": per(x, "blk"), "tov": per(x, "tov"),
                "fg": pct(x["fgm"], x["fga"]),
                "tp": pct(x["tpm"], x["tpa"]),
                "ft": pct(x["ftm"], x["fta"]),
                "ts": pct(x["pts"], 2 * (x["fga"] + 0.44 * x["fta"])),
                "pm": r1(x["pm"] / x["g"]),
            })
        plist.sort(key=lambda z: -(z["pts"] or 0))
        tot += write(a.out, "season_players.json", {
            "season": SEASON, "players": plist,
        })
    else:
        tot += keep(a.out, "season_players.json")

    # ---------------------------------------------------------- rosters
    # 起用ブレ指数。ロスター表にも 1季版（DDI_25）を出す。
    # ★ 生の DDI は出場時間の水準と独立ではないので、帯内パーセンタイルも
    #   一緒に配ってサイト側で併記する（DDI_2627.md §7）
    ddi = ddi_mod.load()
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
        dd = ddi.get(int(x.player_id))
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
            # 起用ブレ（1季版）。pct は帯内の順位、band はその帯
            "ddi": (dd or {}).get("d25"),
            "ddip": (dd or {}).get("p25"),
            "ddib": (dd or {}).get("band"),
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
