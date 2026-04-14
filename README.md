## What is This?

OpenAI-WhisperをつかってDiscordの音声通話の文字起こしをするBot<br>
日本語のみに対応しています。

## Features

- **音声転写**: リアルタイムで音声をテキストに変換
- **WebHookによる表示**: Teams風に話者を表示
- **レポート出力**: 会話の記録をテキストファイルで保存
- **音声録音**: 複数ユーザーの音声を時間軸に合わせて1つのファイルに結合
- **自動退室**: ボイスチャットが0人になると自動で退室
- **細かな制御**: 各機能をコマンドオプションで個別にON/OFF可能

## Commands

### `/join [options]`

ボイスチャンネルに参加して音声転写を開始します。

**オプション:**

- `realtime`: リアルタイムメッセージ送信 (デフォルト: `true`)
- `report`: 退室時のレポート出力 (デフォルト: `true`)
- `audio`: 音声ファイルの録音・出力 (デフォルト: `true`)

### `/leave`

ボイスチャンネルから退室します。

## Installation & Setup

### Prerequisites

このBotを動作させるには以下のソフトウェアが必要です：

1. **Node.js** (v16.0.0以上)
2. **FFmpeg** - 音声ファイルの処理に必要
   - Windows: [公式サイト](https://ffmpeg.org/download.html)からダウンロードしてPATHに追加
   - macOS: `brew install ffmpeg`
   - Linux: `sudo apt install ffmpeg` または `sudo yum install ffmpeg`
3. **cmake**
   - macOS: `brew install cmake`

### Environment Variables

`.env`ファイルを作成し、以下を設定してください：

```env
BOT_TOKEN=your_discord_bot_token
```

### Dependencies Installation

```bash
# Node.js依存関係のインストール
npm install

# Whisperモデルのダウンロード（初回のみ）
npx nodejs-whisper download
```

> [!WARNING]
> **nodejs-whisperのインストールについて**
>
> このライブラリはWhisperのネイティブバイナリをダウンロードします：
>
> - 初回実行時に約1.5GB〜3GBのモデルファイルをダウンロード
> - ダウンロードには時間がかかる場合があります
> - CUDAが利用可能な場合、GPU加速が有効になります
> - インストールに失敗する場合は[nodejs-whisper公式ドキュメント](https://www.npmjs.com/package/nodejs-whisper)を参照してください

### Running the Bot

```bash
npm run start
```

Bot起動後、DiscordサーバーでSlashコマンドが利用可能になります。
