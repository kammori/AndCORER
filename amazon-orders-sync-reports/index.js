/**
 * Amazon SP-API Reports 注文同期 Cloud Function
 * 
 * 機能:
 * - Reports APIで大量の注文データを高速取得
 * - BigQueryに保存（重複回避）
 * - マルチアカウント対応
 * - 文字エンコーディング対応（Shift-JIS/UTF-8）
 * - 配送先情報取得（都道府県・市区町村）
 * 
 * 環境変数:
 * - AMAZON_JP_CLIENT_ID_1, AMAZON_JP_CLIENT_SECRET_1, AMAZON_JP_REFRESH_TOKEN_1
 * - ACCOUNT_NAME_1
 * 
 * パラメータ:
 * - days_back: 取得する過去日数（デフォルト: 30）
 * - account: アカウント番号（1, 2, 3...、デフォルト: 1）
 * - marketplace: JP, US, CA, MX（デフォルト: JP）
 */

const functions = require('@google-cloud/functions-framework');
const { BigQuery } = require('@google-cloud/bigquery');
const https = require('https');
const querystring = require('querystring');
const iconv = require('iconv-lite');

const bigquery = new BigQuery();
const datasetId = 'andcore_main';
const tempTableId = 'orders_temp_amazon';
const ordersTableId = 'orders';
const orderItemsTableId = 'order_items';

// マーケットプレイス設定
const MARKETPLACES = {
  JP: {
    endpoint: 'sellingpartnerapi-fe.amazon.com',
    marketplaceId: 'A1VC38T7YXB528'
  },
  US: {
    endpoint: 'sellingpartnerapi-na.amazon.com',
    marketplaceId: 'ATVPDKIKX0DER'
  },
  CA: {
    endpoint: 'sellingpartnerapi-na.amazon.com',
    marketplaceId: 'A2EUQ1WTGCTBG2'
  },
  MX: {
    endpoint: 'sellingpartnerapi-na.amazon.com',
    marketplaceId: 'A1AM78C64UM0Y8'
  }
};

functions.http('syncAmazonOrdersReports', async (req, res) => {
  const startTime = Date.now();
  
  try {
    // パラメータ取得
    const daysBack = parseInt(req.query.days_back) || 30;
    const accountNum = parseInt(req.query.account) || 1;
    const marketplace = (req.query.marketplace || 'JP').toUpperCase();

    console.log(`=== Amazon注文同期開始（Reports API）===`);
    console.log(`アカウント: ${accountNum}, マーケットプレイス: ${marketplace}, 過去: ${daysBack}日`);

    // 環境変数取得
    const config = getAccountConfig(accountNum, marketplace);
    
    // 日付範囲計算
    const endDate = new Date();
    endDate.setMinutes(endDate.getMinutes() - 2);
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    console.log(`期間: ${startDate.toISOString()} - ${endDate.toISOString()}`);

    // 30日ごとに分割
    const allOrders = [];
    let currentStart = new Date(startDate);
    
    while (currentStart < endDate) {
      let currentEnd = new Date(currentStart);
      currentEnd.setDate(currentEnd.getDate() + 30);
      
      if (currentEnd > endDate) {
        currentEnd = endDate;
      }
      
      console.log(`分割取得: ${currentStart.toISOString()} - ${currentEnd.toISOString()}`);
      
      // Access Token取得
      console.log('Access Token取得中...');
      const accessToken = await getAccessToken(config);

      // レポート作成リクエスト
      console.log('レポート作成リクエスト中...');
      const reportId = await createReport(config, accessToken, currentStart, currentEnd);
      console.log(`レポートID: ${reportId}`);

      // レポート完成を待つ
      console.log('レポート生成待機中...');
      const documentId = await waitForReport(config, accessToken, reportId);
      console.log(`ドキュメントID: ${documentId}`);

      // レポートダウンロード
      console.log('レポートダウンロード中...');
      const reportData = await downloadReport(config, accessToken, documentId);
      console.log(`レポートサイズ: ${reportData.length}バイト`);

      // TSVパース
      console.log('レポート解析中...');
      const orders = parseReportData(reportData, config);
      console.log(`この期間の注文数: ${orders.length}`);
      
      allOrders.push(...orders);
      
      // 次の期間へ（1秒後から開始）
      currentStart = new Date(currentEnd);
      currentStart.setSeconds(currentStart.getSeconds() + 1);
      
      // レート制限対策（次のレポートまで5秒待機）
      if (currentStart < endDate) {
        console.log('次の期間取得まで5秒待機...');
        await sleep(5000);
      }
    }

    console.log(`全期間の合計注文数: ${allOrders.length}`);

    if (allOrders.length === 0) {
      console.log('新しい注文はありません');
      res.json({
        success: true,
        message: '新しい注文はありません',
        orders_count: 0,
        execution_time: `${(Date.now() - startTime) / 1000}秒`
      });
      return;
    }

    // ステップ5: 一時テーブル作成
    await createTempTable();

    // ステップ6: 一時テーブルに挿入
    await insertToTempTable(allOrders);

    // ステップ7: 90秒待機
    console.log('90秒待機中...');
    await sleep(90000);

    // ステップ8: MERGEで本テーブルに統合
    const stats = await mergeToMainTables(config.channel);

    // ステップ9: 一時テーブル削除
    await deleteTempTable();

    // 完了
    const executionTime = (Date.now() - startTime) / 1000;
    console.log(`=== 同期完了 ===`);
    console.log(`実行時間: ${executionTime}秒`);

    res.json({
      success: true,
      message: 'Amazon注文同期が完了しました（Reports API）',
      account: config.accountName,
      marketplace: marketplace,
      period: {
        start: startDate.toISOString(),
        end: endDate.toISOString()
      },
      stats: {
        fetched: allOrders.length,
        inserted: stats.inserted,
        updated: stats.updated
      },
      execution_time: `${executionTime}秒`
    });

  } catch (error) {
    console.error('エラー:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      execution_time: `${(Date.now() - startTime) / 1000}秒`
    });
  }
});

/**
 * アカウント設定取得
 */
function getAccountConfig(accountNum, marketplace) {
  const suffix = `_${accountNum}`;
  const prefix = `AMAZON_${marketplace}`;
  
  const config = {
    clientId: process.env[`${prefix}_CLIENT_ID${suffix}`],
    clientSecret: process.env[`${prefix}_CLIENT_SECRET${suffix}`],
    refreshToken: process.env[`${prefix}_REFRESH_TOKEN${suffix}`],
    accountName: process.env[`ACCOUNT_NAME${suffix}`] || `Amazon ${marketplace} ${accountNum}`,
    channel: `Amazon-${marketplace}-${accountNum}`,
    marketplace: MARKETPLACES[marketplace]
  };
  
  if (!config.clientId || !config.clientSecret || !config.refreshToken) {
    throw new Error(`環境変数が設定されていません: ${prefix}_CLIENT_ID${suffix}, ${prefix}_CLIENT_SECRET${suffix}, ${prefix}_REFRESH_TOKEN${suffix}`);
  }

  return config;
}

/**
 * LWA Access Token取得
 */
async function getAccessToken(config) {
  return new Promise((resolve, reject) => {
    const postData = querystring.stringify({
      grant_type: 'refresh_token',
      refresh_token: config.refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret
    });

    const options = {
      hostname: 'api.amazon.com',
      path: '/auth/o2/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          const json = JSON.parse(data);
          resolve(json.access_token);
        } else {
          reject(new Error(`Token取得失敗: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * レポート作成リクエスト
 */
async function createReport(config, accessToken, startDate, endDate) {
  const body = JSON.stringify({
    reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
    marketplaceIds: [config.marketplace.marketplaceId],
    dataStartTime: startDate.toISOString(),
    dataEndTime: endDate.toISOString()
  });

  const response = await callSpApi(
    config,
    accessToken,
    'POST',
    '/reports/2021-06-30/reports',
    body
  );

  return response.reportId;
}

/**
 * レポート完成を待つ（ポーリング）
 */
async function waitForReport(config, accessToken, reportId, maxWaitTime = 600000) {
  const startTime = Date.now();
  const pollInterval = 10000; // 10秒ごとにチェック

  while (Date.now() - startTime < maxWaitTime) {
    const response = await callSpApi(
      config,
      accessToken,
      'GET',
      `/reports/2021-06-30/reports/${reportId}`,
      null
    );

    console.log(`レポートステータス: ${response.processingStatus}`);

    if (response.processingStatus === 'DONE') {
      return response.reportDocumentId;
    } else if (response.processingStatus === 'FATAL' || response.processingStatus === 'CANCELLED') {
      throw new Error(`レポート生成失敗: ${response.processingStatus}`);
    }

    await sleep(pollInterval);
  }

  throw new Error('レポート生成タイムアウト（10分）');
}

/**
 * レポートダウンロード（エンコーディング対応版）
 */
async function downloadReport(config, accessToken, documentId) {
  // ドキュメント情報取得
  const docInfo = await callSpApi(
    config,
    accessToken,
    'GET',
    `/reports/2021-06-30/documents/${documentId}`,
    null
  );

  // レポートダウンロード（Bufferとして取得）
  return new Promise((resolve, reject) => {
    const url = new URL(docInfo.url);
    
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET'
    };

    https.get(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => { chunks.push(chunk); });
      res.on('end', () => {
        if (res.statusCode === 200) {
          const buffer = Buffer.concat(chunks);
          
          // エンコーディング自動判定してデコード
          let data;
          try {
            // まずUTF-8で試す
            data = buffer.toString('utf8');
            // 文字化けチェック（replacement character U+FFFDが含まれていたら失敗）
            if (data.includes('\uFFFD') || data.includes('�')) {
              throw new Error('UTF-8 decode failed');
            }
            console.log('エンコーディング: UTF-8');
          } catch (e) {
            // UTF-8失敗 → Shift-JISでデコード
            console.log('UTF-8失敗、Shift-JISで再試行...');
            data = iconv.decode(buffer, 'shift_jis');
            console.log('エンコーディング: Shift-JIS');
          }
          
          resolve(data);
        } else {
          reject(new Error(`ダウンロード失敗: ${res.statusCode}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * レポートデータ解析（TSV形式）
 */
function parseReportData(reportData, config) {
  const lines = reportData.split('\n');
  const headers = lines[0].split('\t');
  const orders = [];

  console.log(`ヘッダー: ${headers.slice(0, 5).join(', ')}...`);

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = line.split('\t');
    const row = {};
    
    headers.forEach((header, index) => {
      row[header.trim()] = values[index] || '';
    });

    // 注文データ構築
    if (row['amazon-order-id']) {
      // 顧客名の取得（複数フィールドを試す）
      const customerName = row['buyer-name'] || row['recipient-name'] || 'Amazon Customer';
      
      // 配送先情報の取得
      const shipState = row['ship-state'] || row['ship-state-or-region'] || '';
      const shipCity = row['ship-city'] || '';
      const shipPostalCode = row['ship-postal-code'] || '';
      
      orders.push({
        order_id: row['amazon-order-id'],
        channel: config.channel,
        account_name: config.accountName,
        order_number: row['amazon-order-id'],
        order_date: row['purchase-date'] ? new Date(row['purchase-date']).toISOString() : new Date().toISOString(),
        customer_name: customerName,
        ship_state: shipState,
        ship_city: shipCity,
        ship_postal_code: shipPostalCode,
        subtotal_amount: parseFloat(row['item-price'] || 0),
        tax_amount: parseFloat(row['item-tax'] || 0),
        shipping_amount: parseFloat(row['shipping-price'] || 0),
        total_amount: parseFloat(row['item-price'] || 0) + parseFloat(row['item-tax'] || 0) + parseFloat(row['shipping-price'] || 0),
        currency: row['currency'] || 'JPY',
        payment_status: row['payment-method'] || 'unknown',
        fulfillment_status: row['order-status'] || 'unknown',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        // 商品情報
        line_item_id: row['order-item-id'] || `${row['amazon-order-id']}-1`,
        sku: row['sku'] || '',
        product_name: row['product-name'] || '',
        quantity: parseInt(row['quantity-purchased'] || 1),
        unit_price: parseFloat(row['item-price'] || 0) / parseInt(row['quantity-purchased'] || 1),
        line_total: parseFloat(row['item-price'] || 0)
      });
    }
  }

  // デバッグ: 最初のデータを表示
  if (orders.length > 0) {
    console.log(`サンプル商品名: ${orders[0].product_name}`);
    console.log(`サンプル配送先: ${orders[0].ship_state} ${orders[0].ship_city}`);
  }

  return orders;
}

/**
 * SP-API呼び出し（リトライ対応）
 */
async function callSpApi(config, accessToken, method, path, body, retryCount = 0) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: config.marketplace.endpoint,
      path: path,
      method: method,
      headers: {
        'x-amz-access-token': accessToken,
        'Content-Type': 'application/json'
      }
    };

    if (body && method !== 'GET') {
      options.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = https.request(options, async (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', async () => {
        if (res.statusCode === 200 || res.statusCode === 202) {
          resolve(JSON.parse(data));
        } else if (res.statusCode === 429 && retryCount < 3) {
          console.log(`レート制限。60秒待機後リトライ (${retryCount + 1}/3)`);
          await sleep(60000);
          try {
            const result = await callSpApi(config, accessToken, method, path, body, retryCount + 1);
            resolve(result);
          } catch (error) {
            reject(error);
          }
        } else {
          reject(new Error(`SP-API Error ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    
    if (body && method !== 'GET') {
      req.write(body);
    }
    
    req.end();
  });
}

/**
 * 一時テーブル作成
 */
async function createTempTable() {
  const schema = [
    { name: 'order_id', type: 'STRING' },
    { name: 'channel', type: 'STRING' },
    { name: 'account_name', type: 'STRING' },
    { name: 'order_number', type: 'STRING' },
    { name: 'order_date', type: 'TIMESTAMP' },
    { name: 'customer_name', type: 'STRING' },
    { name: 'ship_state', type: 'STRING' },
    { name: 'ship_city', type: 'STRING' },
    { name: 'ship_postal_code', type: 'STRING' },
    { name: 'subtotal_amount', type: 'FLOAT64' },
    { name: 'tax_amount', type: 'FLOAT64' },
    { name: 'shipping_amount', type: 'FLOAT64' },
    { name: 'total_amount', type: 'FLOAT64' },
    { name: 'currency', type: 'STRING' },
    { name: 'payment_status', type: 'STRING' },
    { name: 'fulfillment_status', type: 'STRING' },
    { name: 'created_at', type: 'TIMESTAMP' },
    { name: 'updated_at', type: 'TIMESTAMP' },
    { name: 'line_item_id', type: 'STRING' },
    { name: 'sku', type: 'STRING' },
    { name: 'product_name', type: 'STRING' },
    { name: 'quantity', type: 'INT64' },
    { name: 'unit_price', type: 'FLOAT64' },
    { name: 'line_total', type: 'FLOAT64' }
  ];

  await bigquery.dataset(datasetId).table(tempTableId).delete({ ignoreNotFound: true });
  await bigquery.dataset(datasetId).createTable(tempTableId, { schema });
  console.log('一時テーブル作成完了');
}

/**
 * 一時テーブルに挿入（バッチ処理）
 */
async function insertToTempTable(orders) {
  if (orders.length === 0) return;

  const batchSize = 500; // 500件ずつ
  
  for (let i = 0; i < orders.length; i += batchSize) {
    const batch = orders.slice(i, i + batchSize);
    await bigquery.dataset(datasetId).table(tempTableId).insert(batch);
    console.log(`${i + batch.length}/${orders.length}件挿入完了`);
  }
  
  console.log(`一時テーブルに合計${orders.length}件挿入完了`);
}

/**
 * MERGEで本テーブルに統合
 */
async function mergeToMainTables(channel) {
  // orders テーブルへのMERGE修正版
  const ordersMergeQuery = `
    MERGE \`${datasetId}.${ordersTableId}\` T
    USING (
      SELECT DISTINCT
        order_id,
        channel,
        account_name,
        order_number,
        order_date,
        customer_name,
        ship_state,
        ship_city,
        ship_postal_code,
        subtotal_amount,
        tax_amount,
        shipping_amount,
        total_amount,
        currency,
        payment_status,
        fulfillment_status,
        created_at,
        updated_at
      FROM (
        -- 注文レベルで集約（商品明細を無視）
        SELECT 
          order_id,
          channel,
          ANY_VALUE(account_name) as account_name,
          ANY_VALUE(order_number) as order_number,
          ANY_VALUE(order_date) as order_date,
          ANY_VALUE(customer_name) as customer_name,
          ANY_VALUE(ship_state) as ship_state,
          ANY_VALUE(ship_city) as ship_city,
          ANY_VALUE(ship_postal_code) as ship_postal_code,
          SUM(subtotal_amount) as subtotal_amount,
          SUM(tax_amount) as tax_amount,
          SUM(shipping_amount) as shipping_amount,
          SUM(total_amount) as total_amount,
          ANY_VALUE(currency) as currency,
          ANY_VALUE(payment_status) as payment_status,
          ANY_VALUE(fulfillment_status) as fulfillment_status,
          ANY_VALUE(created_at) as created_at,
          ANY_VALUE(updated_at) as updated_at
        FROM \`${datasetId}.${tempTableId}\`
        GROUP BY order_id, channel
      )
    ) S
    ON T.order_id = S.order_id AND T.channel = S.channel
    WHEN MATCHED THEN
      UPDATE SET
        order_number = S.order_number,
        order_date = S.order_date,
        customer_name = S.customer_name,
        ship_state = S.ship_state,
        ship_city = S.ship_city,
        ship_postal_code = S.ship_postal_code,
        subtotal_amount = S.subtotal_amount,
        tax_amount = S.tax_amount,
        shipping_amount = S.shipping_amount,
        total_amount = S.total_amount,
        currency = S.currency,
        payment_status = S.payment_status,
        fulfillment_status = S.fulfillment_status,
        updated_at = CURRENT_TIMESTAMP()
    WHEN NOT MATCHED THEN
      INSERT (
        order_id, channel, account_name, order_number, order_date,
        customer_name, ship_state, ship_city, ship_postal_code,
        subtotal_amount, tax_amount, shipping_amount,
        total_amount, currency, payment_status, fulfillment_status,
        created_at, updated_at
      )
      VALUES (
        S.order_id, S.channel, S.account_name, S.order_number, S.order_date,
        S.customer_name, S.ship_state, S.ship_city, S.ship_postal_code,
        S.subtotal_amount, S.tax_amount, S.shipping_amount,
        S.total_amount, S.currency, S.payment_status, S.fulfillment_status,
        S.created_at, S.updated_at
      )
  `;

  const [ordersJob] = await bigquery.createQueryJob({ query: ordersMergeQuery });
  await ordersJob.getQueryResults();

  // order_items テーブルへのMERGE（変更なし）
  const itemsMergeQuery = `
    MERGE \`${datasetId}.${orderItemsTableId}\` T
    USING (
      SELECT
        order_id,
        channel,
        line_item_id,
        sku,
        product_name,
        quantity,
        unit_price,
        line_total,
        currency,
        0 as quantity_fulfilled,
        quantity as quantity_unfulfilled,
        created_at
      FROM \`${datasetId}.${tempTableId}\`
    ) S
    ON T.order_id = S.order_id AND T.channel = S.channel AND T.line_item_id = S.line_item_id
    WHEN MATCHED THEN
      UPDATE SET
        sku = S.sku,
        product_name = S.product_name,
        quantity = S.quantity,
        unit_price = S.unit_price,
        line_total = S.line_total
    WHEN NOT MATCHED THEN
      INSERT (
        order_id, channel, line_item_id, sku, product_name,
        quantity, unit_price, line_total, currency,
        quantity_fulfilled, quantity_unfulfilled, created_at
      )
      VALUES (
        S.order_id, S.channel, S.line_item_id, S.sku, S.product_name,
        S.quantity, S.unit_price, S.line_total, S.currency,
        S.quantity_fulfilled, S.quantity_unfulfilled, S.created_at
      )
  `;

  const [itemsJob] = await bigquery.createQueryJob({ query: itemsMergeQuery });
  await itemsJob.getQueryResults();

  console.log('MERGE完了');

  return {
    inserted: 'unknown',
    updated: 'unknown'
  };
}

/**
 * 一時テーブル削除
 */
async function deleteTempTable() {
  await bigquery.dataset(datasetId).table(tempTableId).delete({ ignoreNotFound: true });
  console.log('一時テーブル削除完了');
}

/**
 * スリープ
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
