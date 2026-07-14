# LLM Handoff

ChatGPTやClaudeで続けた長い議論を、Codex CLI、Claude Code、Cursor、人間、将来の自分へ引き継ぐためのChrome拡張です。

現在の会話をMarkdownへ変換するだけでなく、必要な範囲の選択、引き継ぎ指示、プロジェクト分類、関連付け、差分エクスポートまでをローカルで行います。

> AIとの会話を、一度きりのチャットから再利用できるプロジェクト資産へ。

## 解決する問題

AIとの長い設計・実装相談を別のAIへ渡すとき、手作業のコピーでは次の情報が失われやすくなります。

- 決定に至るまでの検討過程
- 却下した案と理由
- 制約条件と未解決事項
- コードブロック、表、添付参照
- どこまで作業が完了しているか

会話を丸ごと渡せても、無関係な話題や個人情報まで含まれ、コンテキストを浪費することがあります。LLM Handoffは、取得品質を検証したうえで必要な文脈だけを選び、目的を添えたMarkdownとして引き継げるようにします。

## 主な機能

- ChatGPTとClaudeの現在表示中の1会話を手動取得
- YAML frontmatter付きMarkdownのプレビュー、全文コピー、ダウンロード
- 連続したメッセージ範囲の選択
- キーワード検索とユーザー発言だけの絞り込み
- Handoff Instructionsの編集とCodex／Claude Code向けプリセット
- メッセージ件数、文字数、概算トークン数、ファイルサイズの表示
- プロジェクト名、タグ、会話タイプによる分類
- `export_id`を使った親子関係の記録
- 前回末尾のメッセージIDを使った差分エクスポート
- 差分直前の最大2メッセージを文脈として追加
- エクスポート履歴の分類編集、削除、全消去
- `verified`、`uncertain`、`incomplete`による取得品質の表示

通常のプレビューには、会話タイトル、取得元、メッセージ件数、取得品質だけを表示します。プロジェクト設定と履歴は折りたたみ、検索結果は検索時だけ表示します。内部取得経路の詳細は操作画面へ常時表示せず、警告がある場合だけ利用者へ伝えます。

## 使い方

1. ChatGPTまたはClaudeで対象の会話を開く。
2. LLM Handoffの拡張ボタンを押す。
3. 「現在の会話を取得」を押す。
4. プレビューで取得品質、出力範囲、Handoff Instructionsを確認する。
5. Markdown全文をコピーするか、`.md`ファイルをダウンロードする。
6. Codex CLIやClaude Codeへファイルを渡し、作業を続ける。

会話取得後のプレビュー画面にある「使い方」、またはChromeの拡張機能詳細画面にある「拡張機能のオプション」から、拡張内の利用ガイドを開けます。

差分エクスポートを使う場合は、最初に一度通常のエクスポートを行います。同じ会話に発言を追加したあと「前回エクスポート以降だけを選択」を有効にすると、前回の末尾IDより後だけを選択します。

前回IDが現在の分岐に存在しない場合は、推測で続行しません。会話の編集、回答の再生成、分岐変更などの可能性を表示し、全文または手動範囲の選択を求めます。

## 出力例

```yaml
---
schema_version: "0.3"
export_id: "..."
exported_at: "2026-07-14T14:00:00+09:00"
source:
  service: "chatgpt"
  conversation_id: "..."
  url: "https://chatgpt.com/c/..."
  title: "LLM Handoff"
classification:
  project: "llm-handoff"
  type: "implementation"
  tags:
    - "chrome-extension"
relation:
  parent_export_id: "..."
extraction:
  source: page_api
  confidence: verified
  total_messages: 177
export:
  mode: incremental
  previous_last_message_id: "..."
  context_messages: 2
  exported_messages: 14
  new_messages: 12
---
```

差分の直前文脈を含めた場合、本文は`Previous Context`と`New Messages`に分かれます。意図的な部分出力と取得失敗による欠落は、別の情報として記録されます。

## プライバシー

会話内容を第三者サーバー、外部LLM API、アナリティクスへ送信しません。ChatGPTでは、ログイン済みタブからChatGPT自身のWeb UI用バックエンドへ同一オリジンでアクセスし、現在の会話を取得します。

会話本文は`chrome.storage.local`へ保存しません。プレビュー中はbackgroundのメモリに一時保持し、履歴には最大500件の次の情報だけを保存します。

- エクスポートID
- プロジェクト、タグ、会話タイプ
- 元会話URL
- 出力範囲
- 先頭・末尾メッセージID
- 親エクスポートID

履歴は端末間で同期されず、Chromeプロファイルごとに管理されます。拡張を削除すると履歴も削除される可能性がありますが、ダウンロード済みMarkdownには影響しません。シークレットモードでは、拡張の許可状態や保存領域の扱いが通常と異なる場合があります。

## 取得品質

### ChatGPT

通常会話ではChatGPTのWeb UI用バックエンドから会話JSONを取得し、`current_node`から親ノードをたどって現在表示中の分岐だけを出力します。会話ID、`mapping`、`current_node`が一致した場合に`verified`と判定します。

この経路は公開APIではなく、予告なくURL、認証、JSON構造が変わる可能性があります。失敗時はDOM snapshotへフォールバックし、完全性を保証できない場合は警告します。

### Claude

現在はDOM snapshotによる取得です。短い会話では動作を確認していますが、長い会話の完全取得はまだ`verified`ではなく、`uncertain`として扱います。

### 保存制御

- `verified`: 通常どおり保存可能
- `uncertain`: 欠落の可能性を確認してから保存
- `incomplete`: 既定では保存不可

詳しい判定方針は[EXTRACTION.md](EXTRACTION.md)を参照してください。

## インストール

現在はChrome Web Store未公開です。開発版として読み込みます。

1. `chrome://extensions`を開く。
2. デベロッパーモードを有効にする。
3. 「パッケージ化されていない拡張機能を読み込む」を押す。
4. この`llm-handoff/`ディレクトリを選ぶ。
5. 更新後は拡張を再読み込みし、対象のChatGPT／Claudeタブも再読み込みする。

## 権限

- `activeTab`: 現在の対応タブへ抽出要求を送る
- `downloads`: Markdownを保存する
- `storage`: 設定と本文を含まないエクスポート履歴を保存する
- `scripting`: ChatGPTのページコンテキストで同一オリジンの会話取得を実行する

host permissionは`chatgpt.com`と`claude.ai`だけです。

## Dogfooding

v0.4の開発前に、1週間は新機能を追加せず、実作業で検証します。

推奨する流れ:

1. ChatGPTで設計や相談を続ける。
2. LLM Handoffで必要範囲をMarkdownへ出す。
3. Codex CLIまたはClaude Codeへ渡す。
4. 同じ会話を続け、差分エクスポートする。
5. 面倒だった操作、欠落、重複、分かりにくい表示だけをIssueとして記録する。

最低限、同じ長期会話で3〜5回の差分エクスポートを行い、次を確認します。

- 新規メッセージが重複しない
- 分岐変更時に安全に停止する
- 直前2メッセージで次のAIが自然に作業を再開できる
- Codex CLIとClaude CodeがMarkdownを問題なく読める
- プロジェクト分類と親子関係が実際に役立つ

## 現在やらないこと

- 会話の要約
- PROJECT／SPEC／ADRのAI自動生成
- 外部LLM API連携
- JSONLの正式出力
- Gemini対応
- 複数会話の一括取得
- ローカルフォルダ内のMarkdown管理

## ディレクトリ構成

- `.agents/skills/llm-handoff-ui/`: UI改善時の情報設計・アクセシビリティ基準
- `background/`: 一時データとChatGPT取得
- `content/`: 抽出処理のオーケストレーション
- `extractors/`: ChatGPT／Claude固有の取得と共通形式への正規化
- `help/`: 拡張内で表示する利用ガイド
- `icons/`: 拡張アイコンのSVG原本とChrome用PNG
- `popup/`: 抽出開始UI
- `preview/`: 範囲・分類・履歴・Markdownプレビュー
- `shared/`: 共通型、DOM変換、Markdown生成

## 開発ステータス

現在のバージョンは`v0.3.0`です。Git for AI Conversationsという方向性は仮説として持ちつつ、次の機能を決める前にdogfoodingで実際の摩擦を観察します。
