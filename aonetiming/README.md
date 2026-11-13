# AoneTiming

サーキットの計測ソフト。AMB(MyLaps) **TranX3 デコーダー** の通過データを受けて、
ゼッケン登録・タイムトライアル順位・レース順位・修正・印刷・結果保存を行う。
旧ソフト「fig Racing Systems (Ver 1.0)」(Windows 2000 専用) の置き換えが目的。

Windows 10/11 で動く。Python 標準ライブラリ中心で、画面はブラウザ (http://localhost:8765)。

## 現在の状態 (v0.1)

| 機能 | 状態 |
|---|---|
| ゼッケン・発信器登録 (画面編集 / CSV 読込・書出) | ✅ |
| タイムトライアル順位 (ベスト順) | ✅ |
| レース順位 (周回数 → 合計タイム) | ✅ |
| 修正: ベスト抹消 / 周回の無効化・復活 / ペナルティ ± 秒 / 選手削除 / 未走行ドライバー追加 | ✅ |
| 印刷: 順位表 / 通過データ / ゼッケン別ラップチャート | ✅ (ブラウザの印刷) |
| 結果の保存・読込・CSV(Excel)書出 | ✅ |
| 進行中データの自動保存 (落ちても復旧) | ✅ |
| **TranX3 実機からの受信** | ⏳ 通信形式を未確認。下の「通信記録」が必要 |
| QR コードで来場者がランキング登録 | 🔜 将来 |

実機につなぐまでは、設定タブの「疑似データ開始」で動作確認できる。

## 使い方

```
pip install -r requirements.txt
python -m aonetiming            # ブラウザが開く
python -m aonetiming --host 0.0.0.0   # 同じ LAN の別 PC/スマホからも見る場合
```

データは `AoneTimingData/` (exe と同じフォルダ) に保存される: `registry.csv`、`sessions/*.json`、`current.json`。
キー操作は旧ソフトと同じ: **Enter** 計測開始/停止、**Space** やり直し。

登録 CSV は `ゼッケン,発信器番号,選手名,チーム名,クラス` (UTF-8 / Shift-JIS どちらも可、ヘッダー任意)。

### 計測のルール (旧ソフトの動作を推測して実装。違っていたら直す)
- レース・タイムトライアル共通: 計測開始ボタンは 1 周目の始まりではない。ボタンのあと、各発信器が
  **最初にラインを通った瞬間が 1 周目のスタート**(基準点)で、2 回目の通過で 1 周目が終わる。
- レースの順位は周回数 → 合計タイム(自分の最初の通過〜最後の通過 + ペナルティ)。タイムトライアルはベスト順。
- 最小ラップタイム未満の通過は二重検知として無視 (通過一覧に取り消し線で残る)。
- ペナルティはレースの合計タイムに加算。ベスト抹消は次点のラップがベストになる(周回数は減らない)。

## 通信記録 (TranX3 に対応するための最初の作業)

デコーダーが送るデータの形式がまだ分からないので、まず生データを記録する。

```
AoneTimingCapture.exe COM3              # シリアル(RS232)。9600bps
AoneTimingCapture.exe COM3 --baud 19200
AoneTimingCapture.exe 192.168.0.10:12345   # LAN の場合 (IP とポートは要確認)
```

走行中に数分〜数周分記録し、できた `capture-日時.log` を渡す。
同じ時間帯の旧ソフトの「通過確認」画面(発信器番号とラップタイム)も写真で残すと照合できる。

## exe の作り方

GitHub Actions の「AoneTiming (Windows exe)」を実行(または `aonetiming/` を push)すると、
Artifacts から `AoneTiming.exe` / `AoneTimingCapture.exe` をダウンロードできる。
手元で作る場合:

```
pip install -r requirements.txt pyinstaller
pyinstaller --onefile --name AoneTiming --add-data "aonetiming/web;aonetiming/web" run_aonetiming.py
pyinstaller --onefile --name AoneTimingCapture run_capture.py
```

## テスト

```
python -m unittest discover -s tests
```
