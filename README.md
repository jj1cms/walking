# ウォーキング計測 (Walking Tracker PWA)

GPSで歩行距離と消費カロリーを計測する、iPhone向けのWebアプリ（PWA）です。
体重を入力しておくと、歩いた距離・時間から消費カロリーを推定します。

- 📍 **リアルタイムGPS追跡** — 歩いた経路を地図上に記録
- 🗺 **無料地図** — OpenStreetMap（APIキー・課金不要）
- 🔥 **消費カロリー推定** — 体重 × 速度（METs法）で算出
- 🔒 **プライバシー重視** — データは端末内だけに保存。外部送信なし。任意でPINロック
- 📲 **ホーム画面に追加** — ネイティブアプリのように全画面で使える／オフライン対応

---

## 使い方（インストール）

1. iPhoneの **Safari** で公開URL（例: `https://jj1cms.github.io/walking/`）を開く
2. 共有ボタン → **「ホーム画面に追加」**
3. ホーム画面のアイコンから起動
4. 初回は **「設定」タブで体重を入力**
5. 「計測」タブで **「計測開始」** → 歩き終わったら **「終了」**

> 位置情報の許可を求められたら **「許可」** を選んでください。
> 計測はSafari／PWAを開いている間に行われます（バックグラウンドでの常時記録はWebの制約上できません。画面を点けたまま使ってください）。

---

## GitHub Pages で公開する手順

このフォルダ一式をあなたのGitHub（`jj1cms`）に置き、GitHub Pagesを有効にすると公開できます。

### 1. リポジトリを作る
GitHubで新しいリポジトリ（例: `walking`）を作成します。

### 2. このフォルダをプッシュ
このフォルダで以下を実行（`<repo>` は作成したリポジトリ名）:

```bash
git init
git add .
git commit -m "ウォーキング計測 PWA"
git branch -M main
git remote add origin https://github.com/jj1cms/<repo>.git
git push -u origin main
```

### 3. GitHub Pages を有効化
リポジトリの **Settings → Pages** で:
- **Source**: `Deploy from a branch`
- **Branch**: `main` / `(root)` を選び **Save**

数分後、`https://jj1cms.github.io/<repo>/` で公開されます（HTTPSなのでGPSも動作します）。

---

## プライバシーとセキュリティ

- **データは端末内のみ**: 体重・歩行履歴・経路はすべてブラウザの `localStorage` に保存され、サーバーやクラウドへは一切送信されません。アプリ自体（GitHub Pages）は公開でも、**あなたの記録は他人からは見えません**（各端末のローカルにしか存在しないため）。
- **PINロック（任意）**: 設定で4〜8桁のPINを有効化できます。PINは平文では保存されず、`PBKDF2`（Web Crypto）でハッシュ化されます。
- **HTTPS**: GitHub Pagesは常時HTTPS。位置情報APIもHTTPS環境でのみ動作します。
- **全データ削除**: 設定からワンタップで全消去できます。
- **地図について**: 地図画像（タイル）はOpenStreetMapから読み込むため、表示中の地図範囲（おおよその位置）は地図サーバーに伝わります。これは地図表示に不可欠なもので、体重や歩行記録が送られることはありません。

> さらに強固にしたい場合は、iPhone自体に画面ロック（Face ID / パスコード）を設定してください。

---

## iOS向けアイコンをきれいにする（任意）

PWAは標準のSVGアイコンでも動作しますが、iOSのホーム画面アイコンをくっきり表示したい場合:

1. 公開URLの `generate-icons.html` をブラウザで開く（例: `.../walking/generate-icons.html`）
2. 表示された `icon-192.png` / `icon-512.png` / `apple-touch-icon.png` をダウンロード
3. `icons/` フォルダに同名で保存し、`<head>` に次を追加して再プッシュ:
   ```html
   <link rel="apple-touch-icon" href="icons/apple-touch-icon.png" />
   ```

---

## ファイル構成

```
.
├── index.html              アプリ本体
├── css/styles.css          スタイル
├── js/app.js               計測・地図・カロリー計算ロジック
├── manifest.webmanifest    PWA設定
├── service-worker.js       オフライン対応
├── icons/icon.svg          アプリアイコン
├── generate-icons.html     iOS用PNGアイコン生成ツール（任意）
└── .nojekyll               GitHub Pages用
```

## 計算方法について

- **距離**: 連続するGPS測位点間をHaversine（球面）距離で積算。精度の悪い測位（35m超）やGPSのゆらぎ（3m未満の微動）・飛び（43km/h超）は除外して誤差を抑えています。
- **消費カロリー**: 区間ごとに `METs × 体重(kg) × 時間(h)` を積算。METsは歩行速度に応じて2.0〜7.0で変化します。あくまで推定値です。

---

## ローカルで試す

PWA/Service Workerは `file://` では正しく動きません。簡易サーバーで開いてください。
（Node.jsがある場合の例）

```bash
npx serve .
# 表示されたURLをブラウザで開く
```
