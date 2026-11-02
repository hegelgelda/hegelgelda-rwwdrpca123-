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


# ----------------------------------------------- チームのシーズン指標

# 指標の定義は**ここ 1 か所**。画面はこれを読んで描くだけにする。
#   a   **攻撃**側の列
#   b   **守備**側の列。無ければ省略
#   f   書式  1=小数1桁 / 0=整数 / p=百分率（0〜1 を %1桁に）
#   da  a の向き  1=大きいほど良い / -1=小さいほど良い / 0=良し悪しなし
#   db  b の向き
# ★ 列の見出しは「自チーム / 被」ではなく **「攻撃 / 守備」**。
#   `dreb_pct` は相手に許した値ではなく**自軍の守備リバウンド率**、
#   `tovr_op` は**奪ったターンオーバー**なので、「被」と書くと嘘になる。
# ★ 攻守で対になっていない指標を同じ行に並べないこと。
#   最初は `cfga_rate`（自軍の試投のうちコンテストされた割合）と
#   `rim_pct`（リムで守った被 FG%）を 1 行にしてしまい、
#   無関係な 2 つが「攻撃 / 守備」に見えていた。
TEAM_METRICS = [
    ("得点効率", [
        ("得点 / 失点（1 試合）", "pf", "pa", 1, 1, -1),
        ("ORtg / DRtg（100 poss）", "ortg", "drtg", 1, 1, -1),
        ("Net", "net", None, 1, 1, 0),
        ("ペース（1 試合の poss）", "pace", None, 1, 0, 0),
    ]),
    ("四大要素", [
        ("eFG%", "efg", "efg_op", "p", 1, -1),
        ("TOV / 100 poss", "tovr", "tovr_op", 1, -1, 1),
        ("OREB% / DREB%", "oreb_pct", "dreb_pct", 1, 1, 1),
        ("FT 試投率（FTA/FGA）", "ftr", "ftr_op", "p", 1, -1),
    ]),
    ("シュート", [
        ("FG%", "fg", "fg_op", "p", 1, -1),
        ("3P%", "tp", "tp_op", "p", 1, -1),
        ("3PA 率（3PA/FGA）", "tpa_rate", "tpa_rate_op", "p", 0, 0),
        ("FT%", "ft", None, "p", 1, 0),
        ("TS%", "ts", None, "p", 1, 0),
    ]),
    ("得点の内訳（1 試合）", [
        ("ペイント内", "pip", "pip_op", 1, 1, -1),
        ("セカンドチャンス", "psc", "psc_op", 1, 1, -1),
        ("速攻", "pfb", "pfb_op", 1, 1, -1),
        ("ターンオーバーから", "pft", "pft_op", 1, 1, -1),
        ("ベンチ", "bp", "bp_op", 1, 0, 0),
    ]),
    ("カウント（1 試合）", [
        ("リバウンド", "reb", "reb_op", 1, 1, -1),
        ("アシスト", "ast", "ast_op", 1, 1, -1),
        ("ターンオーバー", "tov", "tov_op", 1, -1, 1),
        ("スティール", "stl", None, 1, 1, 0),
        ("ブロック", "blk", None, 1, 1, 0),
        ("ファウル", "pf_n", None, 1, -1, 0),
    ]),
    ("トラッキング（1 試合）", [
        ("走行距離（マイル・チーム計）", "dist", None, 1, 0, 0),
        ("タッチ", "touches", None, 0, 0, 0),
        ("パス", "passes", None, 0, 0, 0),
        ("コンテストされた FGA 率（自軍の試投）", "cfga_rate", None, "p", 0, 0),
        ("リムで守った被 FG%", "rim_pct", None, "p", -1, 0),
        ("リムで守った被 FGA", "rim_a", None, 1, 0, 0),
    ]),
]

TEAM_SQL = """
with box as (
  select game_id, team_abbreviation as tri,
         sum(pts) pts, sum(fgm) fgm, sum(fga) fga, sum(fg3m) fg3m, sum(fg3a) fg3a,
         sum(ftm) ftm, sum(fta) fta, sum(oreb) oreb, sum(dreb) dreb, sum(reb) reb,
         sum(ast) ast, sum(tov) tov, sum(stl) stl, sum(blk) blk, sum(pf) pf
  from player_game_base
  where season_type = 'Regular Season'
  group by 1, 2),
oth as (
  select game_id, team_tricode as tri,
         points_in_the_paint pip, points_second_chance psc,
         points_fast_break pfb, points_from_turnovers pft, bench_points bp
  from game_other_stats),
trk as (
  select distinct game_id, team_tricode as tri, distance, touches, passes,
         contested_field_goals_attempted cfga,
         defended_at_rim_field_goals_attempted rim_a,
         defended_at_rim_field_goals_made rim_m
  from team_track)
select a.season_year season, a.team_abbreviation tri, a.wl, a.poss,
       a.off_rating, a.def_rating, a.pace, a.oreb_pct, a.dreb_pct,
       b.pts, b.fgm, b.fga, b.fg3m, b.fg3a, b.ftm, b.fta, b.reb,
       b.ast, b.tov, b.stl, b.blk, b.pf pf_n,
       ob.pts pts_op, ob.fgm fgm_op, ob.fga fga_op, ob.fg3m fg3m_op,
       ob.fg3a fg3a_op, ob.fta fta_op, ob.reb reb_op, ob.ast ast_op, ob.tov tov_op,
       o.pip, o.psc, o.pfb, o.pft, o.bp,
       oo.pip pip_op, oo.psc psc_op, oo.pfb pfb_op, oo.pft pft_op, oo.bp bp_op,
       t.distance, t.touches, t.passes, t.cfga, t.rim_a, t.rim_m
from team_game_adv a
join box  b  on b.game_id = a.game_id and b.tri = a.team_abbreviation
join box  ob on ob.game_id = a.game_id and ob.tri <> a.team_abbreviation
left join oth o  on o.game_id = a.game_id and o.tri = a.team_abbreviation
left join oth oo on oo.game_id = a.game_id and oo.tri <> a.team_abbreviation
left join trk t  on t.game_id = a.game_id and t.tri = a.team_abbreviation
where a.season_type = 'Regular Season'
"""


def _ratio(num, den):
    """0 除算と欠損を潰す。"""
    if den is None or num is None or den != den or num != num or den == 0:
        return None
    return num / den


def _season_metrics(rows):
    """チーム 1 季ぶんのチーム試合の行から指標をまとめる。

    ★ 合計は「その列が埋まっている行だけ」で取る。`game_other_stats` は
      全期間で 80 試合ぶん欠けているので、null を 0 で足すと平均が下がる。
    """
    k = len(rows)

    def tot(c):
        v = [r[c] for r in rows if r.get(c) is not None and r[c] == r[c]]
        return (sum(v), len(v)) if v else (None, 0)

    def avg(c):
        sm, n = tot(c)
        return _ratio(sm, n)

    poss = tot("poss")[0] or 1
    wmean = {}
    for c in ("off_rating", "def_rating", "oreb_pct", "dreb_pct"):
        wmean[c] = _ratio(sum((r[c] or 0) * (r["poss"] or 0) for r in rows), poss)
    S = {c: tot(c)[0] for c in
         ("pts", "fgm", "fga", "fg3m", "fg3a", "ftm", "fta", "reb", "ast", "tov",
          "stl", "blk", "pf_n", "pts_op", "fgm_op", "fga_op", "fg3m_op", "fg3a_op",
          "fta_op", "reb_op", "ast_op", "tov_op", "cfga", "rim_a", "rim_m")}

    m = {
        "g": k,
        "w": sum(1 for r in rows if r["wl"] == "W"),
        "pf": _ratio(S["pts"], k), "pa": _ratio(S["pts_op"], k),
        "ortg": wmean["off_rating"], "drtg": wmean["def_rating"],
        "pace": avg("pace"),
        "oreb_pct": None if wmean["oreb_pct"] is None else 100 * wmean["oreb_pct"],
        "dreb_pct": None if wmean["dreb_pct"] is None else 100 * wmean["dreb_pct"],
        "efg": _ratio(S["fgm"] + 0.5 * S["fg3m"], S["fga"]),
        "efg_op": _ratio(S["fgm_op"] + 0.5 * S["fg3m_op"], S["fga_op"]),
        "ts": _ratio(S["pts"], 2 * (S["fga"] + 0.44 * S["fta"])),
        "tovr": _ratio(100 * S["tov"], poss),
        "tovr_op": _ratio(100 * S["tov_op"], poss),
        "ftr": _ratio(S["fta"], S["fga"]),
        "ftr_op": _ratio(S["fta_op"], S["fga_op"]),
        "fg": _ratio(S["fgm"], S["fga"]), "fg_op": _ratio(S["fgm_op"], S["fga_op"]),
        "tp": _ratio(S["fg3m"], S["fg3a"]), "tp_op": _ratio(S["fg3m_op"], S["fg3a_op"]),
        "tpa_rate": _ratio(S["fg3a"], S["fga"]),
        "tpa_rate_op": _ratio(S["fg3a_op"], S["fga_op"]),
        "ft": _ratio(S["ftm"], S["fta"]),
        "cfga_rate": _ratio(S["cfga"], S["fga"]),
        "rim_pct": _ratio(S["rim_m"], S["rim_a"]),
    }
    m["l"] = k - m["w"]
    m["pct"] = _ratio(m["w"], k)
    m["net"] = (None if m["ortg"] is None or m["drtg"] is None
                else m["ortg"] - m["drtg"])
    m["diff"] = (None if m["pf"] is None or m["pa"] is None else m["pf"] - m["pa"])
    for c in ("reb", "ast", "tov", "stl", "blk", "pf_n",
              "reb_op", "ast_op", "tov_op",
              "pip", "psc", "pfb", "pft", "bp",
              "pip_op", "psc_op", "pfb_op", "pft_op", "bp_op",
              "distance", "touches", "passes", "rim_a"):
        m[{"distance": "dist"}.get(c, c)] = avg(c)
    return m


def team_stats(con):
    """`team_stats.json` を作る。今季の指標（リーグ順位つき）＋ 季別の成績。"""
    df = con.execute(q(TEAM_SQL)).df()
    df = df.astype(object).where(df.notna(), None)
    rows = df.to_dict("records")
    dim = con.execute(q(
        "select tri, conference from team_dim")).df().set_index("tri")["conference"]
    dim = dim.to_dict()

    by = {}
    for r in rows:
        by.setdefault((r["season"], r["tri"]), []).append(r)
    agg = {ks: _season_metrics(v) for ks, v in by.items()}

    # ---- 季別。カンファレンス内の順位もここで出す（派生表は使わない）
    hist = {}
    for (season, tri), m in agg.items():
        hist.setdefault(tri, []).append(dict(m, season=season))
    for season in {k[0] for k in agg}:
        for conf in set(dim.values()):
            side = [(tri, agg[(season, tri)]) for (s, tri) in agg
                    if s == season and dim.get(tri) == conf]
            side.sort(key=lambda x: (-(x[1]["pct"] or 0), -x[1]["w"]))
            for i, (tri, m) in enumerate(side, 1):
                for h in hist[tri]:
                    if h["season"] == season:
                        h["rk_conf"] = i
    for tri in hist:
        hist[tri].sort(key=lambda h: h["season"], reverse=True)

    # ---- 今季。指標ごとにリーグ順位を付ける
    cur = {tri: agg[(SEASON, tri)] for (s, tri) in agg if s == SEASON}
    keys = []
    for _, items in TEAM_METRICS:
        for it in items:
            keys += [it[1]] + ([it[2]] if it[2] else [])
    keys += ["net", "diff", "pct"]
    rk = {tri: {} for tri in cur}
    for key in dict.fromkeys(keys):
        dirs = {}
        for _, items in TEAM_METRICS:
            for it in items:
                if it[1] == key:
                    dirs[key] = it[4]
                if it[2] == key:
                    dirs[key] = it[5]
        d = dirs.get(key, 1) or 1          # 向きなしは「大きい順」で並べる
        have = [(tri, cur[tri].get(key)) for tri in cur
                if cur[tri].get(key) is not None]
        have.sort(key=lambda x: x[1] * (-1 if d > 0 else 1))
        for i, (tri, _) in enumerate(have, 1):
            rk[tri][key] = i

    out_cur = {}
    for tri, m in cur.items():
        o = {k2: (r1(v, 3) if isinstance(v, float) and abs(v) < 2 else r1(v, 1))
             for k2, v in m.items() if v is not None}
        o["w"], o["l"], o["g"] = m["w"], m["l"], m["g"]
        o["rk"] = rk[tri]
        out_cur[tri] = o

    out_hist = {}
    for tri, hs in hist.items():
        out_hist[tri] = [{
            "season": h["season"], "g": h["g"], "w": h["w"], "l": h["l"],
            "pct": r1(h["pct"], 3), "rk_conf": h.get("rk_conf"),
            "pf": r1(h["pf"]), "pa": r1(h["pa"]), "diff": r1(h["diff"]),
            "ortg": r1(h["ortg"]), "drtg": r1(h["drtg"]), "net": r1(h["net"]),
            "pace": r1(h["pace"]), "efg": r1(h["efg"], 3),
            "efg_op": r1(h["efg_op"], 3), "tpa_rate": r1(h["tpa_rate"], 3),
        } for h in hs]

    return {
        "season": SEASON,
        "n": len(out_cur),
        "metrics": [{"group": g, "rows": [
            {"label": it[0], "a": it[1], "b": it[2], "f": it[3],
             "da": it[4], "db": it[5]} for it in items]}
            for g, items in TEAM_METRICS],
        "cur": out_cur,
        "hist": out_hist,
    }


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
    # ★ `sn` / `sc` は「今季このカードが何回目 / 全部で何試合か」。
    #   組は **順序なし**（least/greatest）で作る。ホームとアウェイが
    #   入れ替わるので `a || h` で組にすると同じカードが2組に割れる。
    #   窓関数は WHERE のあとに評価されるので、TBD（team_id = 0）や
    #   プレシーズンは分母に入らない。
    # ★ `sc` は確定ぶんだけの数。2026-27 は NBA Cup のノックアウト 24 試合が
    #   12月に追加されるので、**それまでは 3/4 が 3/3 に見えるカードがある**。
    #   日程を取り直してこれを回せば直る（`update_season.py` の schedule → site）。
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
               game_status as st,
               row_number() over w  as sn,
               count(*)     over w2 as sc
        from game_schedule
        where season = '{SEASON}'
          and substr(game_id, 3, 1) = '2'
          and home_team_id <> 0 and away_team_id <> 0
        window w as (partition by least(away_tri, home_tri),
                                  greatest(away_tri, home_tri)
                     order by game_date, tip_et),
               w2 as (partition by least(away_tri, home_tri),
                                   greatest(away_tri, home_tri))
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

    # ------------------------------------------------- チームのシーズン指標
    # ★ `team_season_summary` は使わない。`build_team_dim.py` が作る派生表で
    #   2025-26 止まり（`team_standings_daily` と同じ）。全部ここで組む。
    # ★ 率はカウントから直に出す。試合ごとの率の単純平均ではない
    #   （ペースの違う試合が同じ重みになる）。レーティングだけは
    #   ポゼッション重みの加重平均。
    # ★ 相手側の値は同じ game_id の相手の行から取る。`def_rating` は
    #   相手の `off_rating` の写しなので、守備の指標はこれで一貫する。
    # ★ `team_track` は **distinct が必要**。`_fetch_log` の索引の不具合で
    #   同じ試合が 3 重に入っている（2026-11-02 時点で今季 12 行）。
    #   `speed` は全行 null なので出さない。
    if (has_table(con, "team_game_adv") and has_table(con, "player_game_base")
            and has_table(con, "team_dim")):
        tot += write(a.out, "team_stats.json", team_stats(con))
    else:
        tot += keep(a.out, "team_stats.json")

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

    # ------------------------------------------------- モデルの出力（段階1）
    # `predict_upcoming.py` が書いた未実施試合の予測とレーティング。
    # ★ 同じ試合を何度も予測するので、**一番新しい基準日のぶん**だけ出す。
    #   過去の予測は DB に残す（市場と同じ土俵で測るのに要る）。
    if has_table(con, "stage1_future") and has_table(con, "team_rating_snapshot"):
        # ★ 1 日に何度も走らせるので、**試合ごとに一番新しい予測**を採る。
        #   「朝の予測」と「直前の予測」は両方 DB に残っている。
        as_of = con.execute(
            "select max(as_of_utc) from team_rating_snapshot").fetchone()[0]
        rt = con.execute("""
            select team as tri, off, def, net
            from team_rating_snapshot where as_of_utc = ?
            order by net desc""", [as_of]).df()
        pr = con.execute("""
            select f.game_id, f.pred, f.sigma, f.p_home, f.total, f.pace_hat,
                   coalesce(f.av, 0) as av, f.model, f.tip_lead_h, f.as_of_utc
            from stage1_future f
            join (select game_id, max(as_of_utc) as t from stage1_future
                  group by 1) m
              on m.game_id = f.game_id and m.t = f.as_of_utc""").df()
        # ★ 予想得点差か勝率が null の予測は捨てる。
        #   `predict_upcoming.py` の σ が NaN になると p_home が null で
        #   保存され、画面は `p.toFixed()` で落ちる（**日程のページが
        #   丸ごと白くなる**）。2026-11-02 の 15 試合で実際にそうなった。
        #   ここで落として、落としたことを必ず印字する。
        nn = pr[pr.pred.isna() | pr.p_home.isna()]
        if len(nn):
            print("  ★ model.json: 予測が欠けた %d 試合を落とした（%s）"
                  % (len(nn), ", ".join(nn.game_id.head(3))))
            pr = pr[~(pr.pred.isna() | pr.p_home.isna())].copy()
        games = {}
        for x in pr.to_dict("records"):
            games[x["game_id"]] = {
                "pred": r1(x["pred"], 2), "p": r1(x["p_home"] * 100, 1),
                "total": r1(x["total"], 1), "pace": r1(x["pace_hat"], 1),
                # ★ 1 なら「その試合の injury report が出ていて可用性を使えた」。
                #   0 はレポートがまだ無く、欠場を見ずに出した予測
                "av": int(x["av"]),
                # ★ 予測した時点がティップの何時間前か。市場側の「何分前の値か」
                #   と対になる量で、これが無いと公平に比べられない
                "lead": r1(x["tip_lead_h"], 1),
            }
        tot += write(a.out, "model.json", {
            "season": SEASON,
            "as_of": str(as_of)[:16],
            "sigma": r1(float(pr.sigma.iloc[0]), 2) if len(pr) else None,
            "model": str(pr.model.iloc[0]) if len(pr) else None,
            "n_av": int(pr.av.sum()) if len(pr) else 0,
            "ratings": [{k: (v if k == "tri" else r1(v, 2))
                         for k, v in x.items()} for x in rt.to_dict("records")],
            "games": games,
        })
    else:
        print("  model.json       （predict_upcoming.py をまだ回していない）")

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
