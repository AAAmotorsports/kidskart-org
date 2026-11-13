"""PyInstaller 用の起動スクリプト (AoneTimingCapture.exe)。"""
import sys

from aonetiming.capture import main

if __name__ == "__main__":
    sys.exit(main())
