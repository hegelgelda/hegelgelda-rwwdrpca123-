"""build_games.py — 試合ページ用の JSON を作る（public/data1/games/ と games_index.json）

**手元の PC で走らせる。** `nba.duckdb` / `nba_pbp.duckdb` と、VPS から取ってきた
`reports/injury_games.json` を読んで、試合 1 つに 1 ファイルを書く。

    python tools/build_games.py                 # 新しい試合だけ
    python tools/build_games.py --all           # 全部作り直す
    python tools/build_games.py --no-injury     # VPS に取りに行かない
    python tools/build_games.py --game 0022600001

## 何を載せるか

| 欄 | 出どころ | 備考 |
|---|---|---|
| クォーター別得点 Q1-4 | `game_line_score.period1_score..4` | **公式** |
| 延長の得点 | `team_quarter`（PBP 集計） | **延長はここにしか無い** |
| 最終得点 | `player_game_base` の合計 | `game_line_score.pts` は全行 null |
| ボックススコア | `player_game_base` + `player_game_adv` | |
| ラインナップ推移 | `player_stint`（PBP から再構成） | `stint_game_qc.合格` を添える |
| 得点推移 | `pbp` の得点が動いた行 | |
| injury report | VPS の `injury_games.json` | **初出**と最終の両方 |
| 実際の欠場 | `game_inactive` | 試合後に確定したもの |

★ **クォーター別得点は3ソースが 1〜2% 食い違う**（直近の季ほど増える）。
  公式 line_score を主、PBP 集計を検算に使い、**食い違いは `check` に印として残す**。
  隠して1つだけ出すと、どちらが正しいか後から分からなくなる。

★ **injury は最終 status だけでは足りない。** NBA はティップまでに必ず
  Questionable を解決するので、最終だけ見ると Questionable が常にゼロになる。
  不確定さは初出にしか残らない（`export_injury_games.py` の注記と同じ）。

★ **ラインナップ推移は検算に落ちた試合では出さない。** `stint_game_qc.合格` が偽の
  試合（今季 12 / 71）は、ピリオド開始5人の推定が外れている可能性がある。
  黙って出すと「ベンチにいた選手がコートにいる」表示になる。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import duckdb

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
DB = Path(os.environ.get("NBA_DUCKDB") or r"C:\nba\nba.duckdb")
PBP_DB = Path(os.environ.get("NBA_PBP_DUCKDB") or r"C:\nba\nba_pbp.duckdb")
OUT = REPO / "public" / "data1"
SEASON = "2026-27"

# VPS から取ってくる injury の中間ファイル
HOST = os.environ.get("NBA_LIVE_HOST", "root@155.138.226.166")
INJ_REMOTE = "/opt/nba/reports/injury_games.json"
INJ_LOCAL = Path(r"C:\nba\reports\injury_games.json")
_SYS = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "OpenSSH"
SSH = str(_SYS / "ssh.exe") if (_SYS / "ssh.exe").exists() else "ssh"
SCP = str(_SYS / "scp.exe") if (_SYS / "scp.exe").exists() else "scp"

ET = ZoneInfo("America/New_York")
JST = ZoneInfo("Asia/Tokyo")


def i(v):
    """DuckDB の Decimal / float を JSON に出せる形へ。"""
    if v is None:
        return None
    f = float(v)
    return int(f) if f == int(f) else round(f, 3)


def secs(ms):
    """'MM:SS' -> 秒。★ `player_game_base.min_sec` は文字列。`min` は小数の分。"""
    if ms is None:
        return None
    t = str(ms)
    if ":" not in t:
        return i(t)
    m, _, s2 = t.partition(":")
    try:
        return int(m) * 60 + int(round(float(s2)))
    except ValueError:
        return None


def pull_injury() -> dict:
    """VPS で export_injury_games.py を走らせて JSON を取ってくる。"""
    cmd = ("cd /opt/nba && sudo -u nba /opt/nba/venv/bin/python -I "
           "nba_live/tools/export_injury_games.py")
    r = subprocess.run([SSH, "-o", "BatchMode=yes", "-o", "ConnectTimeout=20",
                        HOST, cmd], capture_output=True,
                       encoding="utf-8", errors="replace", timeout=300)
    if r.returncode != 0:
        print("  [warn] VPS 側の書き出しに失敗: %s" % (r.stderr or "")[:160])
    else:
        print("  VPS: %s" % (r.stdout or "").strip())
    INJ_LOCAL.parent.mkdir(parents=True, exist_ok=True)
    r2 = subprocess.run([SCP, "-q", "-o", "BatchMode=yes",
                         "%s:%s" % (HOST, INJ_REMOTE), str(INJ_LOCAL)],
                        capture_output=True, encoding="utf-8",
                        errors="replace", timeout=300)
    if r2.returncode != 0:
        print("  [warn] scp に失敗: %s" % (r2.stderr or "")[:160])
    if not INJ_LOCAL.exists():
        return {}
    with open(INJ_LOCAL, encoding="utf-8") as f:
        return json.load(f).get("games", {})


def connect():
    con = duckdb.connect(str(DB), read_only=True)
    con.execute("attach '%s' as p (read_only)" % str(PBP_DB).replace("\\", "/"))
    return con


def meta_rows(con, season: str):
    return con.execute("""
        select b.game_id, any_value(b.game_date) as game_date,
               any_value(s.tip_utc) as tip_utc,
               any_value(s.home_tri) as home, any_value(s.away_tri) as away,
               any_value(a.arena_name) as arena, any_value(a.arena_city) as city
        from (select distinct game_id, game_date, season_fetched
              from team_game_adv where season_fetched = ?) b
        left join game_schedule s using (game_id)
        left join game_arena a on a.game_id = b.game_id
        group by b.game_id order by b.game_id
    """, [season]).fetchall()


BOX_SQL = """
select b.team_abbreviation as tri, b.player_id as pid, b.player_name as name,
       b.min_sec, b.pts, b.reb, b.oreb, b.dreb, b.ast, b.stl, b.blk, b.tov, b.pf,
       b.fgm, b.fga, b.fg3m, b.fg3a, b.ftm, b.fta, b.plus_minus,
       v.usg_pct, v.ts_pct, v.off_rating, v.def_rating
from player_game_base b
left join player_game_adv v using (game_id, player_id)
where b.game_id = ?
order by b.team_abbreviation, b.min desc nulls last
"""


def build_one(con, gid, gdate, tip, home, away, arena, city, inj):
    # ---- 公式のクォーター別（Q1-4）
    line = {}
    for tri, q1, q2, q3, q4 in con.execute("""
        select team_tricode, try_cast(period1_score as int),
               try_cast(period2_score as int), try_cast(period3_score as int),
               try_cast(period4_score as int)
        from game_line_score where game_id = ?""", [gid]).fetchall():
        line[tri] = [q1, q2, q3, q4]

    # ---- PBP 集計（延長を含む全ピリオド）
    pbpq, mx = {}, 4
    for tri, per, pts in con.execute("""
        select d.tri, q.period, q.pts
        from p.team_quarter q join team_dim d on d.team_id = q.team_id
        where q.game_id = ? order by 2""", [gid]).fetchall():
        pbpq.setdefault(tri, {})[int(per)] = i(pts)
        mx = max(mx, int(per))
    periods = ["Q%d" % k for k in (1, 2, 3, 4)] + \
              ["OT%d" % (k - 4) for k in range(5, mx + 1)]

    quarters, qsrc = {}, {}
    for tri in set(list(line) + list(pbpq)):
        off = line.get(tri) or [None] * 4
        pb = pbpq.get(tri, {})
        row = [off[k] if off[k] is not None else pb.get(k + 1) for k in range(4)]
        row += [pb.get(k) for k in range(5, mx + 1)]
        quarters[tri] = row
        qsrc[tri] = ["official" if off[k] is not None else "pbp" for k in range(4)] \
            + ["pbp"] * (mx - 4)

    # ---- 最終得点（公式ボックスの合計）と検算
    box_pts = {tri: i(v) for tri, v in con.execute("""
        select team_abbreviation, sum(pts) from player_game_base
        where game_id = ? group by 1""", [gid]).fetchall()}
    check = {}
    for tri, row in quarters.items():
        s = sum(x for x in row if x is not None)
        if tri in box_pts and box_pts[tri] != s:
            check.setdefault("quarter_vs_box", {})[tri] = [s, box_pts[tri]]
    for tri in line:
        pb = pbpq.get(tri, {})
        d = [k + 1 for k in range(4)
             if line[tri][k] is not None and pb.get(k + 1) is not None
             and line[tri][k] != pb[k + 1]]
        if d:
            check.setdefault("official_vs_pbp", {})[tri] = d

    # ---- ボックススコア
    box = {}
    for r in con.execute(BOX_SQL, [gid]).fetchall():
        tri = r[0]
        box.setdefault(tri, []).append({
            "pid": int(r[1]), "name": r[2], "sec": secs(r[3]),
            "pts": i(r[4]), "reb": i(r[5]), "oreb": i(r[6]), "dreb": i(r[7]),
            "ast": i(r[8]), "stl": i(r[9]), "blk": i(r[10]), "tov": i(r[11]),
            "pf": i(r[12]), "fgm": i(r[13]), "fga": i(r[14]),
            "fg3m": i(r[15]), "fg3a": i(r[16]), "ftm": i(r[17]), "fta": i(r[18]),
            "pm": i(r[19]), "usg": i(r[20]), "ts": i(r[21]),
            "ortg": i(r[22]), "drtg": i(r[23]),
        })

    # ---- ラインナップ推移（検算に合格した試合だけ）
    ok = con.execute("select 合格 from stint_game_qc where game_id = ?",
                     [gid]).fetchone()
    stint_ok = bool(ok[0]) if ok else False
    stints = {}
    if stint_ok:
        name_of = {p["pid"]: p["name"] for team in box.values() for p in team}
        raw = {}
        for tri, pid, t_in, t_out in con.execute("""
            select d.tri, s.person_id, s.t_in, s.t_out
            from player_stint s join team_dim d on d.team_id = s.team_id
            where s.game_id = ? order by d.tri, s.person_id, s.t_in""",
                [gid]).fetchall():
            raw.setdefault((tri, int(pid)), []).append([i(t_in), i(t_out)])
        for (tri, pid), iv in raw.items():
            # ピリオド境界で割れている区間はつなぐ（出番は切れていない）
            merged = [iv[0][:]]
            for a0, b0 in iv[1:]:
                if a0 == merged[-1][1]:
                    merged[-1][1] = b0
                else:
                    merged.append([a0, b0])
            stints.setdefault(tri, []).append(
                {"pid": pid, "name": name_of.get(pid, str(pid)), "iv": merged})
        for tri in stints:
            stints[tri].sort(key=lambda x: -sum(b - a for a, b in x["iv"]))

    # ---- 得点推移
    path = []
    last = None
    for sec, h, aw in con.execute("""
        select
          case when period <= 4 then (period - 1) * 720 else 2880 + (period - 5) * 300 end
          + (case when period <= 4 then 720 else 300 end
             - (try_cast(regexp_extract(clock, 'PT(\\d+)M', 1) as int) * 60
                + try_cast(regexp_extract(clock, 'M([\\d.]+)S', 1) as double))) as sec,
          try_cast(score_home as int) as h, try_cast(score_away as int) as a
        from p.pbp
        where game_id = ? and score_home is not null and score_home <> ''
        order by period, action_number""", [gid]).fetchall():
        if sec is None or h is None:
            continue
        if last == (h, aw):
            continue
        last = (h, aw)
        path.append([i(sec), h, aw])

    # ---- 実際の欠場（試合後）
    inactive = {}
    for tri, first, fam in con.execute("""
        select d.tri, g.first_name, g.family_name
        from game_inactive g join team_dim d on d.team_id = g.team_id
        where g.game_id = ? order by 1, 3""", [gid]).fetchall():
        inactive.setdefault(tri, []).append(("%s %s" % (first or "", fam or "")).strip())

    # ---- injury report（VPS）
    injury = {}
    for p in (inj.get(gid, {}) or {}).get("players", []):
        injury.setdefault(p["tri"], []).append(
            {k: p[k] for k in ("name", "first", "final", "reason") if p.get(k)})

    tip_et = tip_jst = None
    if tip is not None:
        t = tip.replace(tzinfo=timezone.utc) if tip.tzinfo is None else tip
        tip_et = t.astimezone(ET).strftime("%H:%M")
        tip_jst = t.astimezone(JST).strftime("%m/%d %H:%M")

    return {
        "game_id": gid,
        "date": str(gdate)[:10],
        "tip_et": tip_et, "tip_jst": tip_jst,
        "away": away, "home": home,
        "arena": arena, "city": city,
        "score": {"away": box_pts.get(away), "home": box_pts.get(home)},
        "periods": periods, "quarters": quarters, "quarter_src": qsrc,
        "check": check, "stint_ok": stint_ok,
        "box": box, "stints": stints, "score_path": path,
        "inactive": inactive, "injury": injury,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", default=SEASON)
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--game", default=None)
    ap.add_argument("--no-injury", action="store_true")
    a = ap.parse_args()

    inj = {} if a.no_injury else pull_injury()
    gdir = OUT / "games"
    gdir.mkdir(parents=True, exist_ok=True)

    con = connect()
    rows = meta_rows(con, a.season)
    if a.game:
        rows = [r for r in rows if r[0] == a.game]
    print("対象 %d 試合" % len(rows))

    index, made, total = [], 0, 0
    for gid, gdate, tip, home, away, arena, city in rows:
        fp = gdir / ("%s.json" % gid)
        need = a.all or a.game or not fp.exists()
        if need:
            g = build_one(con, gid, gdate, tip, home, away, arena, city, inj)
            with open(fp, "w", encoding="utf-8") as f:
                json.dump(g, f, ensure_ascii=False, separators=(",", ":"))
            made += 1
        else:
            with open(fp, encoding="utf-8") as f:
                g = json.load(f)
        total += fp.stat().st_size
        index.append({
            "id": gid, "d": g["date"], "a": g["away"], "h": g["home"],
            "ap": g["score"]["away"], "hp": g["score"]["home"],
            "np": len(g["periods"]),
        })
    con.close()

    index.sort(key=lambda x: (x["d"], x["id"]))
    with open(OUT / "games_index.json", "w", encoding="utf-8") as f:
        json.dump({"season": a.season, "games": index}, f,
                  ensure_ascii=False, separators=(",", ":"))
    print("書いた %d / 全 %d 試合 / 合計 %.1f MB（1試合 %.1f KB）"
          % (made, len(index), total / 1e6,
             total / 1024 / max(1, len(index))))
    print("索引: %s" % (OUT / "games_index.json"))


if __name__ == "__main__":
    main()
