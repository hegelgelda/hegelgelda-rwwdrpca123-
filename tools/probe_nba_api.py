"""
probe_nba_api.py — NBA API に届くかどうかだけを確かめる

GitHub Actions のログは未サインインでは読めない。
結果を `::error::` / `::notice::` で出して**注釈**に載せ、
API から読めるようにする。

    python tools/probe_nba_api.py

届けば 0、届かなければ 1 を返す。
stats.nba.com はクラウドの IP を弾くことがあり、
その場合ここで止めてログを無駄に長くしない。
"""


from __future__ import annotations

import os
import sys
import time


def say(level: str, msg: str) -> None:
    """GitHub Actions の注釈として出す。手元では普通に表示される"""
    if os.environ.get("GITHUB_ACTIONS"):
        print(f"::{level}::{msg}")
    else:
        print(f"[{level}] {msg}")


def main() -> int:
    t0 = time.time()
    try:
        from nba_api.stats.endpoints import scheduleleaguev2
        # ★ 独自ヘッダは付けない。付けると stats.nba.com が無応答になる
        r = scheduleleaguev2.ScheduleLeagueV2(season="2026-27", league_id="00",
                                              timeout=30)
        n = len(r.get_data_frames()[0])
    except Exception as e:                                   # noqa: BLE001
        dt = time.time() - t0
        say("error",
            f"NBA API に届かない: {type(e).__name__}: "
            f"{str(e)[:200].replace(chr(10), ' ')} ({dt:.0f}秒)")
        say("error",
            "stats.nba.com がこのランナーの IP を弾いている可能性が高い。"
            "その場合 Actions では更新できないので、ローカル実行に切り替える。")
        return 1

    say("notice", f"NBA API に届いた: {n:,} 行 ({time.time() - t0:.1f}秒)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
