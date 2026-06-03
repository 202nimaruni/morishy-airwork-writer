# 求人作成AI【モリシー】

AirWork掲載用の求人原稿を、入力フォーム＋AIで生成するWebアプリです。

## 機能

- STEP1入力フォーム（基本 / 文体 / 選択項目）
- 求人URL・本文からの自動抽出
- AI原稿生成（OpenAI API — 各ユーザーが自分のAPIキーを設定）
- 履歴・自動保存・JSONバックアップ

## 公開方法（誰でもURLから使えるようにする）

静的HTMLのみのため、ビルド不要でそのままデプロイできます。

### いちばん簡単：Netlify Drop

1. [Netlify Drop](https://app.netlify.com/drop) を開く
2. `airwork-writer` フォルダをドラッグ＆ドロップ
3. 表示された URL（例: `https://xxxx.netlify.app`）を共有

### GitHub Pages

```bash
cd airwork-writer
git init
git add .
git commit -m "Initial deploy"
git branch -M main
git remote add origin https://github.com/YOUR_USER/morishy-airwork-writer.git
git push -u origin main
```

GitHub → Settings → Pages → **Deploy from branch: main / root**

### 一時公開（開発・確認用）

```bash
chmod +x scripts/tunnel.sh
./scripts/tunnel.sh
```

表示された `*.trycloudflare.com` のURLを共有できます（PCを起動したままにする必要があります）。

## ローカルで開く

```bash
open -a "Google Chrome" "file:///Users/owner/Documents/airwork-writer/index.html"
```

## 注意

- 履歴・APIキーは **各ユーザーのブラウザ** に保存されます（LocalStorage）
- APIキーはサーバーに送られません（ブラウザから直接 OpenAI API を呼び出します）
