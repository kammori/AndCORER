# マルチチャネル売上・在庫統合管理システム 仕様書 ver4

## 📋 プロジェクト概要

### 目的
複数ECチャネル・実店舗の売上と在庫を一元管理し、リアルタイムでの意思決定を可能にする

### 解決する課題
- ❌ 各部署で異なる計算方法による売上管理の非効率
- ❌ 手入力による在庫管理の漏れ・在庫切れ発生
- ❌ データ確認に時間がかかり意思決定が遅延
- ❌ 原価情報の権限管理不足

---

## 🎯 対象チャネル

### 売上データ統合
| チャネル | アカウント数 | 備考 | ステータス |
|---------|------------|------|-----------|
| Amazon JP | 3アカウント | SP-API (Reports) | ✅ 完了 |
| Amazon 北米 | 1アカウント | SP-API（US/CA/MX） | ⏳ 準備中 |
| Shopify | 3アカウント（拡張可） | REST API | ✅ 完了 |
| 楽天 | 1店舗 | RMS API（11月末開始予定） | ⏳ 準備中 |
| Square | 1店舗 | 実店舗POS | ✅ 完了 |

**合計: 8-9チャネル（将来的に拡張可能）**

### 在庫データ統合
| ソース | 連携方法 | 備考 |
|--------|---------|------|
| Amazon FBA | SP-API | 全アカウント対応 |
| 外部倉庫 | REST API | URL + APIキーで在庫一覧取得 |
| 楽天RMS | RMS API | 在庫照会API |

---

## 🏗️ システム構成
```
┌─────────────────────────────────────────────────┐
│  データソース層                                  │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌─────────┐ │
│  │Amazon  │ │Shopify │ │楽天    │ │ Square  │ │
│  │(4)     │ │(3+)    │ │(1)     │ │  (1)    │ │
│  └───┬────┘ └───┬────┘ └───┬────┘ └────┬────┘ │
└──────┼──────────┼──────────┼───────────┼──────┘
       │          │          │           │
       └──────────┴──────────┴───────────┘
                      ▼
┌─────────────────────────────────────────────────┐
│  Google Cloud Functions（データ取得・正規化）   │
│  - マルチアカウント対応                         │
│  - 為替レート取得                               │
│  - 在庫データ統合                               │
│  - 文字エンコーディング対応（Shift-JIS/UTF-8） │
└──────────────────┬──────────────────────────────┘
                   ▼
┌─────────────────────────────────────────────────┐
│  BigQuery（データウェアハウス）                 │
│  ┌──────────────┐ ┌──────────────┐             │
│  │ 売上統合     │ │ 在庫統合     │             │
│  │ - orders     │ │ - inventory  │             │
│  │ - order_items│ │ - stock_log  │             │
│  └──────────────┘ └──────────────┘             │
│  ┌──────────────┐ ┌──────────────┐             │
│  │ マスタ       │ │ 予測         │             │
│  │ - products   │ │ - forecast   │             │
│  │ - costs      │ │ - stockout   │             │
│  │ - fx_rates   │ └──────────────┘             │
│  └──────────────┘                               │
└──────┬──────────────────────┬───────────────────┘
       │                      │
       ▼                      ▼
┌──────────────┐    ┌───────────────────────────┐
│ Looker Studio│    │ AppSheet（管理画面）      │
│ ダッシュボード│    │ - 商品マスタ管理          │
│ - KPI        │    │ - 原価入力（権限管理）    │
│ - 売上分析   │    │ - 在庫確認                │
│ - 在庫状況   │    │ - 発注提案                │
│ - 予測       │    └───────────────────────────┘
│ - 地域分析   │
└──────────────┘
```

---

## 📊 データベース設計

### 1. 売上関連テーブル

#### orders（注文テーブル）
```sql
CREATE TABLE orders (
  order_id STRING,
  channel STRING,           -- 'Amazon-JP-1', 'Shopify-1', 'Rakuten', 'Square'
  account_name STRING,      -- アカウント識別用
  order_number STRING,
  order_date TIMESTAMP,
  fulfillment_date TIMESTAMP,  -- 出荷日（NEW）
  customer_name STRING,
  
  -- 配送先情報（NEW）
  ship_state STRING,        -- 都道府県
  ship_city STRING,         -- 市区町村
  ship_postal_code STRING,  -- 郵便番号
  
  -- 金額情報
  subtotal_amount FLOAT64,
  tax_amount FLOAT64,
  shipping_amount FLOAT64,
  total_amount FLOAT64,
  currency STRING,          -- 'JPY', 'USD', 'CAD', 'MXN'
  
  -- ステータス
  payment_status STRING,
  fulfillment_status STRING,
  
  -- メタ情報
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  
  PRIMARY KEY(order_id, channel)
);
```

#### order_items（注文明細テーブル）
```sql
CREATE TABLE order_items (
  order_id STRING,
  channel STRING,
  line_item_id STRING,
  
  -- 商品情報
  sku STRING,
  product_name STRING,
  quantity INT64,
  
  -- 金額
  unit_price FLOAT64,
  line_total FLOAT64,
  currency STRING,
  
  -- 出荷情報
  quantity_fulfilled INT64,
  quantity_unfulfilled INT64,
  
  created_at TIMESTAMP,
  
  PRIMARY KEY(order_id, channel, line_item_id)
);
```

### 2. 在庫関連テーブル

#### inventory（在庫統合テーブル）
```sql
CREATE TABLE inventory (
  sku STRING,
  location STRING,          -- 'FBA-JP-1', 'FBA-US', '外部倉庫', '楽天'
  location_type STRING,     -- 'FBA', 'External', 'Rakuten'
  
  -- 在庫数
  available_quantity INT64,     -- 販売可能在庫
  reserved_quantity INT64,      -- 引当済み
  inbound_quantity INT64,       -- 入庫予定
  total_quantity INT64,         -- 合計
  
  -- 更新情報
  last_updated TIMESTAMP,
  sync_status STRING,       -- 'success', 'error'
  
  PRIMARY KEY(sku, location)
);
```

#### stock_movement_log（在庫移動ログ）
```sql
CREATE TABLE stock_movement_log (
  log_id STRING,
  sku STRING,
  location STRING,
  
  -- 移動情報
  movement_type STRING,     -- 'in', 'out', 'adjustment'
  quantity_change INT64,
  reason STRING,
  
  -- 残高
  quantity_before INT64,
  quantity_after INT64,
  
  created_at TIMESTAMP,
  created_by STRING
);
```

### 3. マスタ関連テーブル

#### product_master（商品マスタ）
```sql
CREATE TABLE product_master (
  sku STRING PRIMARY KEY,
  product_name STRING,
  
  -- カテゴリ
  category STRING,
  brand STRING,
  
  -- 販売チャネル
  amazon_enabled BOOL,
  shopify_enabled BOOL,
  rakuten_enabled BOOL,
  square_enabled BOOL,
  
  -- 手数料率
  amazon_fee_rate FLOAT64,
  shopify_fee_rate FLOAT64,
  rakuten_fee_rate FLOAT64,
  
  -- その他
  shipping_cost FLOAT64,
  weight FLOAT64,
  
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);
```

#### cost_master（原価マスタ）**権限管理対象**
```sql
CREATE TABLE cost_master (
  sku STRING,
  
  -- 原価情報
  cost_price FLOAT64,
  cost_currency STRING,     -- 'JPY', 'USD', 'CNY'
  cost_price_jpy FLOAT64,   -- 円換算後（自動計算）
  
  -- 仕入先
  supplier_name STRING,
  supplier_country STRING,
  
  -- 更新情報
  effective_date DATE,      -- 適用開始日
  created_at TIMESTAMP,
  created_by STRING,
  
  PRIMARY KEY(sku, effective_date)
);
```

#### fx_rates（為替レート）
```sql
CREATE TABLE fx_rates (
  rate_date DATE,
  currency STRING,          -- 'USD', 'CNY', 'EUR'
  rate_to_jpy FLOAT64,
  
  created_at TIMESTAMP,
  
  PRIMARY KEY(rate_date, currency)
);
```

### 4. 予測関連テーブル

#### sales_forecast（売上予測）
```sql
CREATE TABLE sales_forecast (
  sku STRING,
  forecast_date DATE,
  channel STRING,
  
  -- 予測値
  predicted_quantity INT64,
  confidence_level FLOAT64, -- 0.0 - 1.0
  
  -- 実績（予測後に記録）
  actual_quantity INT64,
  
  created_at TIMESTAMP,
  model_version STRING
);
```

#### stockout_alert（在庫切れ予測）
```sql
CREATE TABLE stockout_alert (
  sku STRING,
  location STRING,
  
  -- 予測
  predicted_stockout_date DATE,
  current_stock INT64,
  daily_sales_rate FLOAT64,
  days_until_stockout INT64,
  
  -- アラート
  alert_level STRING,       -- 'critical', 'warning', 'normal'
  suggested_order_qty INT64,
  
  calculated_at TIMESTAMP,
  
  PRIMARY KEY(sku, location, calculated_at)
);
```

### 5. 権限管理テーブル

#### users（ユーザー）
```sql
CREATE TABLE users (
  user_id STRING PRIMARY KEY,
  email STRING,
  name STRING,
  role STRING,              -- 'admin', 'manager', 'staff'
  can_view_cost BOOL,       -- 原価閲覧権限
  
  created_at TIMESTAMP
);
```

---

## 🎨 主要機能詳細

### 1. ダッシュボード（Looker Studio）

#### トップKPI
- 今日の売上（前日比）
- 今月の売上（前月比）
- 総在庫金額
- 在庫切れアラート数

#### チャネル別売上（フィルター・ソート対応）
- 日次/週次/月次切り替え
- チャネル選択（Amazon JP/US、Shopify、楽天、Square）
- アカウント別表示
- 期間指定
- CSV/Excelエクスポート

#### 商品別売上ランキング
- TOP100商品
- 利益率順/売上順/販売数量順
- チャネル別フィルター
- 在庫状況表示

#### 地域別売上分析（NEW）
- 都道府県別売上マップ（ジオチャート）
- 市区町村別売上TOP20
- チャネル × 地域クロス分析

### 2. 在庫切れ予測機能

#### 予測ロジック
- 過去30日間の平均販売数から算出
- 在庫切れ予測日の計算
- アラートレベル判定（Critical/Warning/Normal）
- 発注推奨数の提案（30日分在庫確保）

#### アラート通知
- 🔴 Critical（7日以内）: Slack + メール
- ⚠️ Warning（14日以内）: Slack通知
- ダッシュボードに常時表示

### 3. 原価管理（権限管理付き）

#### 権限レベル
- **Admin**: 全データ閲覧・編集
- **Manager**: 原価閲覧・編集可能
- **Staff**: 原価非表示

#### 為替レート自動更新
- Cloud Functionsで毎日自動取得
- 無料API使用（ExchangeRate-API等）
- 手動更新も可能

### 4. フィルター・ソート機能

#### Looker Studio
- 📅 期間: 今日/昨日/今週/先週/今月/先月/カスタム
- 🏪 チャネル: 全て/Amazon/Shopify/楽天/Square
- 🏷️ アカウント: 個別選択可能
- 📦 商品カテゴリ
- 💰 金額範囲
- 📊 ソート: 売上/利益/数量/利益率
- 📍 地域: 都道府県/市区町村（NEW）

#### AppSheet
- 商品名/SKU検索
- 在庫状況フィルター（在庫あり/少ない/なし）
- カテゴリ/ブランド
- チャネル別表示

---

## 🔐 セキュリティ・権限管理

### 権限マトリックス

| 機能 | Admin | Manager | Staff |
|------|-------|---------|-------|
| ダッシュボード閲覧 | ✅ | ✅ | ✅ |
| 売上データ閲覧 | ✅ | ✅ | ✅ |
| 在庫データ閲覧 | ✅ | ✅ | ✅ |
| 地域データ閲覧 | ✅ | ✅ | ✅ |
| **原価データ閲覧** | ✅ | ✅ | ❌ |
| **原価データ編集** | ✅ | ✅ | ❌ |
| 商品マスタ編集 | ✅ | ✅ | ❌ |
| ユーザー管理 | ✅ | ❌ | ❌ |
| システム設定 | ✅ | ❌ | ❌ |

---

## ⚙️ 技術スタック

| レイヤー | 技術 | 理由 |
|---------|------|------|
| **データ収集** | Cloud Functions (Node.js 20) | サーバーレス、複数API統合に最適 |
| **データ保存** | BigQuery | 実質無制限、高速クエリ、低コスト |
| **可視化** | Looker Studio | 無料、BigQuery連携、リアルタイム |
| **管理画面** | AppSheet | ノーコード、権限管理、モバイル対応 |
| **スケジューラー** | Cloud Scheduler | 定期実行（1時間毎、日次など） |
| **通知** | Cloud Functions + Slack/Gmail | アラート通知 |
| **為替API** | ExchangeRate-API | 無料、1,500リクエスト/月 |
| **文字エンコーディング** | iconv-lite | Shift-JIS対応 |

---

## 📅 構築スケジュール・工数見積もり

### Phase 1: 基盤構築（3-4日）✅ 完了
- Day 1: 環境セットアップ（4-5時間）
- Day 2-3: データ取得実装（8-10時間）
- Day 4: スケジューラー設定（2-3時間）

### Phase 2: API連携（4-5日）🔄 進行中（90%完了）
- ✅ Shopify連携（3アカウント対応）
- ✅ Square連携
- ✅ Amazon JP連携（Reports API、文字化け対応）
- ⏳ Amazon JP追加アカウント（2,3）
- ⏳ Amazon 北米連携
- ⏳ 楽天RMS連携（11月末開始予定）

### Phase 3: 分析・予測機能（2-3日）⏳ 未着手
- Day 5-6: 分析SQL実装（6-8時間）
- Day 7: 予測モデル実装（4-5時間）

### Phase 4: ダッシュボード構築（2-3日）🔄 進行中（50%完了）
- ✅ 基本ダッシュボード（KPI、チャネル別売上、商品別売上）
- ⏳ 地域分析パネル追加
- ⏳ 在庫状況パネル
- ⏳ 利益分析パネル
- ⏳ AppSheet管理画面（4-5時間）

### Phase 5: テスト・調整（2日）⏳ 未着手
- Day 11-12: 総合テスト（6-8時間）

---

## 📊 最終工数見積もり

| Phase | 予定時間 | 実績時間 | ステータス |
|-------|---------|---------|-----------|
| Phase 1: 基盤構築 | 12-15時間 | ~15時間 | ✅ 完了 |
| Phase 2: API連携 | 15-20時間 | ~18時間 | 🔄 90% |
| Phase 3: 分析機能 | 10-13時間 | - | ⏳ 未着手 |
| Phase 4: UI構築 | 10-13時間 | ~5時間 | 🔄 50% |
| Phase 5: テスト | 6-8時間 | - | ⏳ 未着手 |
| **合計** | **53-69時間** | **~38時間** | **進捗率: 70%** |

---

## 💰 コスト見積もり

### 初期費用: ¥0

### 月額ランニングコスト

| 項目 | 予想使用量 | 月額費用 |
|------|-----------|---------|
| BigQuery（ストレージ） | 〜10GB | ¥0（無料枠内） |
| BigQuery（クエリ） | 〜200GB | ¥0（無料枠内） |
| Cloud Functions | 〜10万回 | ¥0（無料枠内） |
| Cloud Scheduler | 10ジョブ | ¥70 |
| AppSheet | 10ユーザー | ¥0（Core無料） |
| Looker Studio | - | ¥0（完全無料） |
| 為替API | 30リクエスト | ¥0（無料枠内） |
| **合計** | - | **¥70/月** |

---

## 🚀 導入効果予測

### 時間削減効果

| 作業 | 現状 | 導入後 | 削減時間 |
|------|------|--------|---------|
| 売上集計 | 10時間/日 | 0時間 | 10時間/日 |
| 在庫確認 | 1時間/日 | 0時間 | 1時間/日 |
| レポート作成 | 4時間/週 | 0時間 | 4時間/週 |
| **月間削減** | - | - | **約250時間** |

**人件費換算（時給2,000円）: 月50万円削減**

### その他効果
- ✅ 在庫切れ削減 → 機会損失削減
- ✅ 意思決定スピード向上
- ✅ データドリブン経営の実現
- ✅ 人為的ミス削減
- ✅ 地域別マーケティング戦略立案が可能に

---

## 🔄 データ同期の実装詳細

### Amazon SP-API連携（Reports API）

#### 実装の特徴
```
Reports API → TSVダウンロード → 文字エンコーディング自動判定
→ 一時テーブル → 90秒待機 → MERGE → クリーンアップ
```

#### 文字エンコーディング対応（NEW）
- **自動判定**: UTF-8 → Shift-JIS の順で試行
- **ライブラリ**: iconv-lite
- **対象**: 商品名、顧客名などの日本語フィールド

#### パラメータ
```bash
# 過去30日取得（日次更新）
?days_back=30

# 過去2年取得（初回同期）
?days_back=780

# アカウント指定
?account=1&days_back=30
```

#### 取得データ
- 注文データ（全フィールド）
- 商品情報（SKU、商品名）
- 配送先情報（都道府県、市区町村、郵便番号）
- 金額情報（通貨込み）

#### タイムアウト・メモリ設定
- **タイムアウト**: 540秒
- **メモリ**: 512 MiB
- **レート制限対策**: 60秒待機 + 自動リトライ

---

### Shopify連携

#### 実装の特徴
```
REST API → ページネーション → 一時テーブル → 90秒待機 → MERGE
```

#### パラメータ
```bash
# 過去30日取得
?days_back=30

# 全期間取得
?full_sync=true&days_back=3650

# アカウント指定
?account=1
```

#### 取得データ
- 注文データ
- 商品明細
- 顧客情報（名前）
- 配送先情報（詳細）
- フルフィルメント日付

#### レート制限対策
- 500ms待機（各リクエスト間）
- 最大250件/ページ

---

### Square連携

#### 実装済み機能
- 注文データ取得（Orders API）
- 決済データ統合
- 実店舗在庫対応

#### パラメータ
```bash
?days_back=30
```

---

## 🔐 環境変数管理

### Amazon SP-API
```
AMAZON_JP_CLIENT_ID_1=amzn1.application-oa2-client.xxxxx
AMAZON_JP_CLIENT_SECRET_1=amzn1.oa2-cs.v1.xxxxx
AMAZON_JP_REFRESH_TOKEN_1=Atzr|IwEBxxxxx
ACCOUNT_NAME_1=Amazon JP アカウント1
```

### Shopify
```
SHOPIFY_STORE_1=store-name-1
SHOPIFY_ACCESS_TOKEN_1=shpat_xxxxx
ACCOUNT_NAME_1=オンラインストア
```

### Square
```
SQUARE_ACCESS_TOKEN=EAAAxxxxxxxx
SQUARE_LOCATION_ID=Lxxxxxxxx
ACCOUNT_NAME=実店舗
```

---

## ⚙️ Cloud Scheduler設定（自動実行）

### 設定済みスケジュール

| ジョブ名 | 頻度 | URL | 説明 |
|---------|------|-----|------|
| shopify-daily-sync | 毎日2:00 | ?days_back=30 | Shopify日次更新 |
| shopify-weekly-sync | 毎週月曜3:00 | ?days_back=90 | Shopify週次再同期 |
| square-daily-sync | 毎日2:00 | ?days_back=30 | Square日次更新 |
| amazon-daily-sync | 毎日2:30 | ?days_back=30 | Amazon日次更新（追加予定） |

---

## 🎯 今後の拡張予定

### Phase 2完了: 残りのチャネル連携
- ⏳ Amazon JP アカウント2,3追加
- ⏳ Amazon 北米（US/CA/MX）
- ⏳ 楽天RMS（11月末開始）

### Phase 3: 在庫連携
- FBA在庫自動同期
- 外部倉庫API連携
- 在庫切れアラート自動化

### Phase 4: 予測機能
- 売上予測モデル
- 在庫最適化
- 発注提案自動化

### Phase 5: ダッシュボード拡張
- ✅ 基本ダッシュボード完成
- ⏳ 地域別売上マップ（ジオチャート）
- ⏳ 在庫状況パネル追加
- ⏳ 利益分析パネル追加
- ⏳ AppSheet管理画面
- ⏳ Slack通知連携

---

## 📊 現在の構築状況（2024-11-19時点）

### 完了項目
- ✅ BigQuery基盤構築（10テーブル + 配送先カラム追加）
- ✅ テストデータ投入
- ✅ 実践的SQLクエリ作成
- ✅ Cloud Functions基礎（test-bigquery-insert）
- ✅ Shopify連携完全実装（重複回避対応、配送先情報追加）
- ✅ 全期間データ取得成功（4万件対応確認済み）
- ✅ Square連携完全実装
- ✅ Amazon SP-API連携（Reports API、文字化け対応、配送先情報追加）
- ✅ Cloud Scheduler自動化設定（3ジョブ）
- ✅ Looker Studio基本ダッシュボード作成
  - KPIカード4つ
  - チャネル別売上（円グラフ）
  - 日次売上推移（時系列グラフ）
  - 商品別売上TOP10（棒グラフ、日付連動）
  - 最近の注文一覧（テーブル）
  - 期間フィルター・チャネルフィルター

### 進捗率
```
Phase 1: 基盤構築       ━━━━━━━━━━━━ 100% ✅ 完了！
Phase 2: API連携        ━━━━━━━━━━━░  90% 🔄 進行中
Phase 3: 分析機能       ░░░░░░░░░░░░   0% ⏳ 未着手
Phase 4: ダッシュボード ━━━━━░░░░░░░  50% 🔄 進行中
Phase 5: テスト         ░░░░░░░░░░░░   0% ⏳ 未着手

全体進捗: ━━━━━━━░░░░░  70%
```

### 次回作業
1. ⏳ Amazonアカウント2,3追加
2. ⏳ Amazon北米アカウント追加
3. ⏳ 楽天RMS連携（11月末）
4. ⏳ Looker Studio地域分析パネル追加
5. ⏳ 在庫連携開始

---

## 📈 Looker Studioダッシュボード詳細

### 現在の構成
```
┌─────────────────────────────────────────┐
│  AndCORE2 売上ダッシュボード             │
├─────────────────────────────────────────┤
│  📅 期間フィルター | 🏪 チャネルフィルター │
├─────────────────────────────────────────┤
│  📈 KPIカード（4つ）                     │
│  ├─ 今月の売上                          │
│  ├─ 今日の売上                          │
│  ├─ 総注文数                            │
│  └─ 平均注文単価                        │
├─────────────────────────────────────────┤
│  📊 チャネル別売上（円グラフ）            │
├─────────────────────────────────────────┤
│  📈 日次売上推移（折れ線グラフ）          │
├─────────────────────────────────────────┤
│  🏆 商品別売上TOP10（棒グラフ）          │
│     ※期間フィルターと連動                │
├─────────────────────────────────────────┤
│  📋 最近の注文一覧（テーブル）            │
│     ※商品名・SKU表示対応                │
└─────────────────────────────────────────┘
```

### 追加予定の可視化（Phase 4）
- 📍 **都道府県別売上マップ**（ジオチャート）
- 🏙️ **市区町村別売上TOP20**（テーブル）
- 🗾 **チャネル × 地域クロス分析**（ピボットテーブル）
- 📦 **在庫状況パネル**（ゲージチャート）
- 💰 **利益分析パネル**（複合グラフ）

---

## 💾 バックアップ・リカバリ

### テーブルバックアップ方法
```sql
-- 日次バックアップ
CREATE TABLE `andcore_main.orders_backup_YYYYMMDD` AS
SELECT * FROM `andcore_main.orders`;

-- 復元
CREATE OR REPLACE TABLE `andcore_main.orders` AS
SELECT * FROM `andcore_main.orders_backup_YYYYMMDD`;
```

### 自動バックアップ（推奨）
- BigQueryのスケジュールクエリ機能を使用
- 週次で過去90日分を別データセットに保存

---

## 🐛 トラブルシューティング

### よくあるエラーと対処法

#### 1. 文字化け
```
商品名: �����
```
**対処**: iconv-lite実装済み（自動対応）

#### 2. ストリーミングバッファエラー
```
Error: UPDATE or DELETE statement over table would affect rows in the streaming buffer
```
**対処**: 90秒待機ロジック実装済み

#### 3. タイムアウトエラー
```
Error: Function timeout
```
**対処**: タイムアウト設定を540秒に延長

#### 4. Slackbot 403エラー
```
GET 403 Slackbot-LinkExpanding
```
**対処**: 正常動作（無視してOK）

---

## 🎨 データ分析例

### 地域別売上分析クエリ

```sql
-- 都道府県別売上（全チャネル統合）
SELECT 
  ship_state as 都道府県,
  COUNT(DISTINCT order_id) as 注文数,
  SUM(total_amount) as 売上合計,
  AVG(total_amount) as 平均注文単価
FROM `andcore_main.orders`
WHERE ship_state IS NOT NULL
  AND ship_state != ''
GROUP BY ship_state
ORDER BY 売上合計 DESC;
```

```sql
-- チャネル × 地域クロス分析
SELECT 
  channel,
  ship_state as 都道府県,
  COUNT(*) as 注文数,
  SUM(total_amount) as 売上
FROM `andcore_main.orders`
WHERE ship_state IS NOT NULL
GROUP BY channel, ship_state
ORDER BY 売上 DESC
LIMIT 50;
```

```sql
-- 出荷ベース売上（Shopifyのみ）
SELECT 
  DATE(fulfillment_date) as 出荷日,
  COUNT(*) as 出荷数,
  SUM(total_amount) as 売上
FROM `andcore_main.orders`
WHERE channel = 'Shopify'
  AND fulfillment_date IS NOT NULL
GROUP BY 出荷日
ORDER BY 出荷日 DESC;
```

---

## 📚 参考リンク

### API ドキュメント
- [Shopify Admin API](https://shopify.dev/docs/api/admin-rest)
- [Amazon SP-API](https://developer-docs.amazon.com/sp-api/)
- [Square API](https://developer.squareup.com/reference/square)
- [楽天RMS API](https://webservice.rms.rakuten.co.jp/)

### Google Cloud
- [BigQuery Documentation](https://cloud.google.com/bigquery/docs)
- [Cloud Functions Documentation](https://cloud.google.com/functions/docs)
- [Cloud Scheduler Documentation](https://cloud.google.com/scheduler/docs)
- [Looker Studio](https://lookerstudio.google.com/)

### 開発ツール
- [Square SDK (Node.js)](https://www.npmjs.com/package/square)
- [iconv-lite (文字エンコーディング)](https://www.npmjs.com/package/iconv-lite)

---

## 📝 構築済みCloud Functions一覧

| Function名 | 用途 | エントリポイント | タイムアウト | メモリ | ステータス |
|-----------|------|----------------|-------------|--------|-----------|
| test-bigquery-insert | テスト用データ投入 | testInsert | 60秒 | 256 MiB | ✅ |
| shopify-orders-sync | Shopify注文同期 | syncShopifyOrders | 540秒 | 512 MiB | ✅ |
| square-orders-sync | Square注文同期 | syncSquareOrders | 540秒 | 512 MiB | ✅ |
| amazon-orders-sync-reports | Amazon注文同期 | syncAmazonOrdersReports | 540秒 | 512 MiB | ✅ |

---

## 🎯 まとめ

### プロジェクト概要
- **対象**: 9チャネル（Amazon 4 + Shopify 3+ + 楽天 + Square）
- **機能**: 売上統合、在庫統合、予測、権限管理、地域分析
- **期間**: 10-15日（実働）
- **費用**: 初期¥0、月額¥70
- **進捗**: 70%完了

### 完成イメージ
✅ 全チャネルの売上が1画面で確認可能  
✅ リアルタイム在庫状況の把握  
✅ 在庫切れ7日前に自動アラート  
✅ 原価情報は権限者のみ閲覧  
✅ スマホからでも確認・入力可能  
✅ 商品名の文字化けなし（日本語完全対応）  
✅ 地域別売上分析が可能  
✅ 注文ベース・出荷ベース両方の分析に対応  

### 新機能（ver4）
🆕 配送先情報の取得・分析  
🆕 文字エンコーディング自動判定（Shift-JIS/UTF-8）  
🆕 出荷日ベースの分析対応  
🆕 Amazon Reports API対応（高速・大量データ取得）  

---

## 📝 新しいチャットで開始する際の定型文

各Phaseの新チャット開始時に以下をコピペしてください：
```
こんにちは！マルチチャネル売上・在庫管理システム（AndCORE2）を構築中です。

【システム概要】
- チャネル: Amazon(4) + Shopify(3+) + 楽天 + Square
- 技術: BigQuery + Cloud Functions + AppSheet + Looker Studio
- 主要機能: 売上統合、在庫統合、在庫切れ予測、原価管理（権限付き）、地域分析

【現在の進捗】
- Phase 1（基盤構築）: 100% ✅
- Phase 2（API連携）: 90% 🔄
  - Shopify, Square, Amazon JP (1): 完了
  - 文字化け対応・配送先情報追加: 完了
- Phase 4（ダッシュボード）: 50% 🔄

【今やりたいこと】
Phase X: ○○○（具体的に記載）

【現在の状況】
- 完了済み: ○○
- 今困っていること: ○○

詳しい仕様書はProject Knowledgeにあります（ver4が最新）。
よろしくお願いします！
```

---

**作成者**: AndCORE2プロジェクト  
**最終更新**: 2024年11月19日  
**バージョン**: 4.0  
**主な変更点**: 
- 配送先情報追加（都道府県・市区町村・郵便番号）
- 文字エンコーディング対応（Shift-JIS/UTF-8自動判定）
- 出荷日フィールド追加
- Amazon Reports API実装完了
- 地域別分析機能追加
- 進捗状況更新（70%完了）
