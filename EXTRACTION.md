# Extraction Design

## Goal

LLM Handoff の最重要要件は、会話を Markdown 化することではなく、**表示中の会話を可能な限り欠落なく引き継げること**です。

そのため抽出は 1 つの実装に固定せず、複数の取得経路を優先順に試し、取得品質を必ず結果に含めます。

## Extraction Result

```ts
type ExtractionResult = {
  conversation?: Conversation;
  source: ExtractionSource;
  confidence: "verified" | "uncertain" | "incomplete";
  diagnostics: ExtractionDiagnostics;
  warnings: string[];
};

type ExtractionSource =
  | "network"
  | "page_state"
  | "shared_page"
  | "dom_snapshots"
  | "visible_dom";
```

`Conversation` は出力対象そのものです。`diagnostics` は取得品質の判定根拠です。

## Extractor Interface

各取得経路は共通のインターフェースを実装する想定です。

```ts
interface ConversationExtractor {
  canExtract(context: ExtractionContext): Promise<boolean>;
  extract(context: ExtractionContext): Promise<ExtractionResult>;
}
```

オーケストレーターは次の優先順で実行します。

1. `shared_page`
2. `page_state`
3. `network`
4. `dom_snapshots`
5. `visible_dom`

## Confidence Levels

### `verified`

次をすべて満たした場合だけ `verified` とします。

- 取得経路が会話全体を表す安定データである
- 表示中の会話 ID と取得データの会話 ID が一致する
- 表示中の先頭と末尾のメッセージが一致する
- 現在表示中の分岐と取得データの分岐が一致する
- メッセージ件数が安定している
- 明白な欠落や重複がない

### `uncertain`

次のいずれかを含むが、完全な欠落までは断定できない場合です。

- 取得経路はあるが、表示内容との完全一致を証明できない
- 先頭到達や件数安定の一部しか確認できない
- JSON 取得はできたが、現在分岐との一致が未確認
- DOM snapshot から十分量は取れたが、完全性を保証できない

### `incomplete`

次のいずれかを満たした場合です。

- 抽出件数が表示中の観測件数を下回る
- 取得途中で先頭未到達が検出される
- 明白な欠落、重複、順序破綻がある
- 会話 ID や現在分岐との整合が取れない
- そもそも部分 DOM しか見えていない

既定動作では、`incomplete` は保存不可とします。

## Diagnostics Checklist

調査モードで優先して見る項目は次です。

- request URL
- request method
- status
- content-type
- response size の概算
- top-level keys
- `messages`, `mapping`, `conversation`, `author`, `content` の存在
- 会話 ID 一致
- メッセージ件数
- 親子関係または時系列の再構築可否
- 表示中の先頭・末尾との一致
- 再読込、会話切替、過去スクロールでの再現性

本文全文は既定では調査表示しません。必要時だけ明示有効化します。

## Test Cases

完全取得判定のため、最低限次のケースを固定で確認します。

1. 100 件以上の長い会話
2. コードブロックを複数含む会話
3. 表を含む会話
4. 添付画像またはファイルを含む会話
5. 再生成や分岐が発生した会話
6. 会話途中からリロードした状態
7. 共有ページからの取得

## Current Status

ChatGPT通常会話ページでは、Web UI用の `/backend-api/conversation/:id` を主経路にします。取得した `mapping` を `current_node` から親方向へたどり、現在表示中の分岐だけを出力します。API取得に失敗した場合は `dom_snapshots` へフォールバックします。

観測上の既知課題:

- Web UI用APIは非公開実装であり、URL・認証・JSON構造が変更される可能性がある
- APIレスポンスに `mapping` または `current_node` がなければ `verified` にしない
- DOMフォールバックだけで完全取得を保証しない

## Timebox

`page_state` または `network` から安定した会話データを取る調査には期限を置きます。

目安:

- 2〜3 日調査して安定経路が見つからない
- 取得できても UI 更新への耐性が低い

この場合は、v0.1 の「完全取得保証」を外し、`uncertain` / `incomplete` を明示する運用を正式仕様にします。
