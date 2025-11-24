/**
 * ロジスピ外部倉庫 在庫同期 Cloud Function
 * 
 * 機能:
 * - ロジスピAPIから在庫取得
 * - ケース在庫を個数に変換
 * - BigQueryに保存（重複回避）
 * 
 * 環境変数:
 * - LOGISP_API_KEY: ロジスピAPIキー
 * 
 * パラメータ:
 * - なし（定期実行想定）
 */

const functions = require('@google-cloud/functions-framework');
const { BigQuery } = require('@google-cloud/bigquery');
const axios = require('axios');

const bigquery = new BigQuery();
const datasetId = 'andcore_main';
const inventoryTableId = 'inventory';
const productMasterTableId = 'product_master';

// ロジスピAPI設定
// 注意: 実際のロジスピAPIのURLを確認してください
// 環境変数で上書き可能
const LOGISP_API_URL = process.env.LOGISP_API_URL || 
  'https://asia-northeast1-logisp-production.cloudfunctions.net/inventories';

console.log('ロジスピAPI URL:', LOGISP_API_URL);

functions.http('syncLogispInventory', async (req, res) => {
  const startTime = Date.now();
  
  try {
    console.log('=== ロジスピ在庫同期開始 ===');
    console.log('Environment check...');
    
    // 環境変数チェック
    const apiKey = process.env.LOGISP_API_KEY;
    if (!apiKey) {
      const error = '環境変数 LOGISP_API_KEY が設定されていません';
      console.error('❌ ERROR:', error);
      return res.status(500).json({
        success: false,
        error: error,
        hint: 'Cloud Functionsの環境変数にLOGISP_API_KEYを設定してください'
      });
    }
    console.log('✅ API Key found');
    
    // Step 1: ロジスピAPIから在庫取得
    console.log('ロジスピAPIから在庫取得中...');
    const inventoryData = await fetchLogispInventory(apiKey);
    console.log(`取得件数: ${inventoryData.length}件`);
    
    if (inventoryData.length === 0) {
      console.log('在庫データが0件です');
      return res.json({
        success: true,
        message: '在庫データが0件でした',
        execution_time: `${(Date.now() - startTime) / 1000}秒`
      });
    }
    
    // Step 2: 商品マスタ取得（ケース変換用）
    console.log('商品マスタ取得中...');
    const productMaster = await fetchProductMaster();
    console.log(`商品マスタ件数: ${Object.keys(productMaster).length}件`);
    
    // Step 3: 在庫データ変換（ケース→個数変換）
    console.log('在庫データ変換中...');
    const inventoryRows = convertInventoryData(inventoryData, productMaster);
    console.log(`変換後件数: ${inventoryRows.length}件`);
    
    // Step 4: BigQueryに保存（MERGE方式）
    console.log('BigQueryに保存中...');
    await saveInventoryToBigQuery(inventoryRows);
    console.log('保存完了');
    
    // 完了
    const executionTime = (Date.now() - startTime) / 1000;
    console.log(`=== ロジスピ在庫同期完了 ===`);
    console.log(`実行時間: ${executionTime}秒`);
    
    res.json({
      success: true,
      message: 'ロジスピ在庫同期が完了しました',
      stats: {
        fetched: inventoryData.length,
        converted: inventoryRows.length,
        case_products: inventoryRows.filter(r => r.is_case_converted).length
      },
      execution_time: `${executionTime}秒`
    });
    
  } catch (error) {
    console.error('エラー:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack,
      execution_time: `${(Date.now() - startTime) / 1000}秒`
    });
  }
});

/**
 * ロジスピAPIから在庫取得
 */
async function fetchLogispInventory(apiKey) {
  try {
    console.log('ロジスピAPI呼び出し中...');
    console.log('URL:', LOGISP_API_URL);
    
    const response = await axios.get(LOGISP_API_URL, {
      headers: {
        'X-API-Key': apiKey
      },
      timeout: 30000 // 30秒タイムアウト
    });
    
    console.log('✅ API Response Status:', response.status);
    console.log('API Response Sample:', JSON.stringify(response.data).slice(0, 300));
    
    // データ形式に応じて処理
    const inventories = response.data.inventories || response.data;
    
    if (!Array.isArray(inventories)) {
      console.error('❌ APIレスポンスが配列ではありません:', typeof inventories);
      console.error('Response:', JSON.stringify(response.data));
      throw new Error(`APIレスポンスが配列ではありません: ${typeof inventories}`);
    }
    
    console.log(`✅ 在庫データ取得成功: ${inventories.length}件`);
    return inventories;
    
  } catch (error) {
    if (error.response) {
      // APIからのエラーレスポンス
      console.error('❌ ロジスピAPI Error Response:');
      console.error('  Status:', error.response.status);
      console.error('  Data:', JSON.stringify(error.response.data));
      throw new Error(`ロジスピAPI Error ${error.response.status}: ${JSON.stringify(error.response.data)}`);
    } else if (error.request) {
      // リクエストが送信されたがレスポンスなし
      console.error('❌ ロジスピAPIへの接続タイムアウト');
      console.error('  Request config:', error.config);
      throw new Error('ロジスピAPIへの接続タイムアウト（30秒）');
    } else {
      console.error('❌ リクエスト設定エラー:', error.message);
      throw error;
    }
  }
}

/**
 * 商品マスタ取得（ケース変換情報含む）
 */
async function fetchProductMaster() {
  try {
    console.log('商品マスタ（SKU紐付け + ケース情報）取得中...');
    
    // channel_settings（SKU紐付け）とproduct_master（ケース情報）をJOIN
    const query = `
      SELECT 
        cs.channel_sku,
        cs.master_sku,
        cs.account_name,
        COALESCE(pm.is_case_product, FALSE) as is_case_product,
        COALESCE(pm.units_per_case, 1) as units_per_case
      FROM \`${datasetId}.channel_settings\` cs
      LEFT JOIN \`${datasetId}.${productMasterTableId}\` pm
        ON cs.master_sku = pm.master_sku
      WHERE cs.account_name = 'ロジスピ'
        AND cs.is_enabled = TRUE
    `;
    
    const [rows] = await bigquery.query(query);
    
    console.log(`✅ クエリ実行成功: ${rows.length}件`);
    
    // channel_sku をキーとしたマップに変換
    const masterMap = {};
    
    rows.forEach(row => {
      masterMap[row.channel_sku] = {
        master_sku: row.master_sku,
        is_case_product: row.is_case_product,
        units_per_case: row.units_per_case || 1
      };
      
      console.log(`  マッピング: ${row.channel_sku} → ${row.master_sku} (ケース: ${row.is_case_product}, 倍率: ${row.units_per_case})`);
    });
    
    console.log(`✅ ロジスピSKUマップ登録数: ${Object.keys(masterMap).length}`);
    
    if (Object.keys(masterMap).length === 0) {
      console.warn('⚠️  ロジスピのSKU紐付けが0件です。channel_settingsに登録してください。');
    }
    
    return masterMap;
    
  } catch (error) {
    console.error('❌ 商品マスタ取得エラー:', error.message);
    throw new Error(`商品マスタ取得失敗: ${error.message}`);
  }
}

/**
 * 在庫データ変換（ケース→個数変換）
 */
function convertInventoryData(inventoryData, productMaster) {
  const now = new Date().toISOString();
  const rows = [];
  
  inventoryData.forEach(item => {
    // APIレスポンスのフィールド名を想定
    const sku = item.sku || item.SKU || item.itemCode;
    let quantity = parseInt(item.quantity || item.stock || item.available || 0);
    
    if (!sku) {
      console.warn('⚠️  SKUが見つかりません:', item);
      return;
    }
    
    // channel_settingsから情報取得
    const product = productMaster[sku];
    
    if (!product) {
      // マッピングが見つからない場合は警告（スキップしない）
      console.warn(`⚠️  SKUマッピングが見つかりません: ${sku} - そのまま保存します`);
      rows.push({
        sku: sku,
        location: 'ロジスピ',
        location_type: 'External',
        available_quantity: quantity,
        reserved_quantity: 0,
        inbound_quantity: 0,
        total_quantity: quantity,
        last_updated: now,
        sync_status: 'success',
        is_case_converted: false,
        original_sku: sku,
        original_quantity: quantity
      });
      return;
    }
    
    let isCaseConverted = false;
    const finalSku = product.master_sku;
    const originalQuantity = quantity;
    
    // ケース商品の場合、個数に変換
    if (product.is_case_product && product.units_per_case > 1) {
      console.log(`✅ ケース変換: ${sku} → ${quantity}ケース × ${product.units_per_case}個 = ${quantity * product.units_per_case}個 → master_sku: ${finalSku}`);
      quantity = quantity * product.units_per_case;
      isCaseConverted = true;
    } else {
      console.log(`✅ SKU紐付け: ${sku} → master_sku: ${finalSku} (${quantity}個)`);
    }
    
    rows.push({
      sku: finalSku,
      location: 'ロジスピ',
      location_type: 'External',
      available_quantity: quantity,
      reserved_quantity: 0,
      inbound_quantity: 0,
      total_quantity: quantity,
      last_updated: now,
      sync_status: 'success',
      is_case_converted: isCaseConverted,
      original_sku: sku,
      original_quantity: originalQuantity
    });
  });
  
  return rows;
}

/**
 * BigQueryに保存（MERGE方式）
 */
async function saveInventoryToBigQuery(inventoryRows) {
  if (inventoryRows.length === 0) {
    console.log('保存するデータがありません');
    return;
  }
  
  // 一時テーブル作成
  const timestamp = Date.now();
  const tempTableId = `inventory_temp_logisp_${timestamp}`;
  
  console.log(`一時テーブル作成: ${tempTableId}`);
  
  const schema = [
    { name: 'sku', type: 'STRING' },
    { name: 'location', type: 'STRING' },
    { name: 'location_type', type: 'STRING' },
    { name: 'available_quantity', type: 'INT64' },
    { name: 'reserved_quantity', type: 'INT64' },
    { name: 'inbound_quantity', type: 'INT64' },
    { name: 'total_quantity', type: 'INT64' },
    { name: 'last_updated', type: 'TIMESTAMP' },
    { name: 'sync_status', type: 'STRING' }
  ];
  
  await bigquery.dataset(datasetId).createTable(tempTableId, { schema });
  
  // データ投入（500件ずつバッチ処理）
  console.log('一時テーブルにデータ投入中...');
  const batchSize = 500;
  
  for (let i = 0; i < inventoryRows.length; i += batchSize) {
    const batch = inventoryRows.slice(i, i + batchSize).map(row => ({
      sku: row.sku,
      location: row.location,
      location_type: row.location_type,
      available_quantity: row.available_quantity,
      reserved_quantity: row.reserved_quantity,
      inbound_quantity: row.inbound_quantity,
      total_quantity: row.total_quantity,
      last_updated: row.last_updated,
      sync_status: row.sync_status
    }));
    
    await bigquery.dataset(datasetId).table(tempTableId).insert(batch);
    console.log(`  ${Math.min(i + batchSize, inventoryRows.length)}/${inventoryRows.length}件投入完了`);
  }
  
  // ストリーミングバッファ待機（90秒）
  console.log('ストリーミングバッファ待機中（90秒）...');
  await sleep(90000);
  
  // MERGE実行
  console.log('MERGE実行中...');
  const projectId = await bigquery.getProjectId();
  
  const mergeQuery = `
    MERGE \`${projectId}.${datasetId}.${inventoryTableId}\` T
    USING \`${projectId}.${datasetId}.${tempTableId}\` S
    ON T.sku = S.sku AND T.location = S.location
    WHEN MATCHED THEN
      UPDATE SET
        available_quantity = S.available_quantity,
        reserved_quantity = S.reserved_quantity,
        inbound_quantity = S.inbound_quantity,
        total_quantity = S.total_quantity,
        last_updated = S.last_updated,
        sync_status = S.sync_status
    WHEN NOT MATCHED THEN
      INSERT (
        sku, location, location_type,
        available_quantity, reserved_quantity, inbound_quantity,
        total_quantity, last_updated, sync_status
      )
      VALUES (
        S.sku, S.location, S.location_type,
        S.available_quantity, S.reserved_quantity, S.inbound_quantity,
        S.total_quantity, S.last_updated, S.sync_status
      )
  `;
  
  await bigquery.query(mergeQuery);
  console.log('MERGE完了');
  
  // 一時テーブル削除
  console.log('一時テーブル削除中...');
  await bigquery.dataset(datasetId).table(tempTableId).delete({ ignoreNotFound: true });
  console.log('一時テーブル削除完了');
}

/**
 * スリープ
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}