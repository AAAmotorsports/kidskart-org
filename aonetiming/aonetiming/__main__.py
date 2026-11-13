import argparse

from .app import App
from .server import serve


def main() -> None:
    ap = argparse.ArgumentParser(description="AoneTiming 計測ソフト")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1",
                    help="他のPCや携帯から見る場合は 0.0.0.0")
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    serve(App(), a.host, a.port, not a.no_browser)


if __name__ == "__main__":
    main()
