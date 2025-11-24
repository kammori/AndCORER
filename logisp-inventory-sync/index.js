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
const LOGISP_API_URL = 'https://asia-northeast1-logisp-production.cloudfunctions.net/inventories';

functions.http('syncLogispInventory', async (req, res) => {
  const startTime = Date.now();
  
  try {
    console.log('=== ロジスピ在庫同期開始 ===');
    
    // 環境変数チェック
    const apiKey = process.env.LOGISP_API_KEY;
    if (!apiKey) {
      throw new Error('環境変数 LOGISP_API_KEY が設定されていません');
    }
    
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
    const response = await axios.get(LOGISP_API_URL, {
      headers: {
        'X-API-Key': apiKey
      },
      timeout: 30000 // 30秒タイムアウト
    });
    
    // レスポンス形式の確認
    console.log('API Response Status:', response.status);
    console.log('API Response Sample:', JSON.stringify(response.data).slice(0, 200));
    
    // データ形式に応じて処理
    // 想定: { inventories: [{sku: "xxx", quantity: 10}, ...] } or 配列直接
    const inventories = response.data.inventories || response.data;
    
    if (!Array.isArray(inventories)) {
      throw new Error('APIレスポンスが配列ではありません');
    }
    
    return inventories;
    
  } catch (error) {
    if (error.response) {
      // APIからのエラーレスポンス
      throw new Error(`ロジスピAPI Error ${error.response.status}: ${JSON.stringify(error.response.data)}`);
    } else if (error.request) {
      // リクエストが送信されたがレスポンスなし
      throw new Error('ロジスピAPIへの接続タイムアウト');
    } else {
      throw error;
    }
  }
}

/**
 * 商品マスタ取得（ケース変換情報含む）
 */
async function fetchProductMaster() {
  const query = `
    SELECT 
      master_sku,
      is_case_product,
      units_per_case,
      case_sku
    FROM \`${datasetId}.${productMasterTableId}\`
  `;
  
  const [rows] = await bigquery.query(query);
  
  // SKUをキーとしたマップに変換（channel_sku と case_sku の両方に対応）
  const masterMap = {};
  
  rows.forEach(row => {
    // master_sku自体をキーとして登録
    masterMap[row.master_sku] = row;
    
    // case_sku がある場合、それもキーとして登録
    if (row.case_sku) {
      masterMap[row.case_sku] = row;
    }
  });
  
  // channel_settings も取得して追加
  const channelQuery = `
    SELECT 
      cs.channel_sku,
      cs.master_sku,
      pm.is_case_product,
      pm.units_per_case,
      pm.case_sku
    FROM \`${datasetId}.channel_settings\` cs
    LEFT JOIN \`${datasetId}.${productMasterTableId}\` pm
      ON cs.master_sku = pm.master_sku
  `;
  
  const [channelRows] = await bigquery.query(channelQuery);
  
  channelRows.forEach(row => {
    if (row.channel_sku) {
      masterMap[row.channel_sku] = {
        master_sku: row.master_sku,
        is_case_product: row.is_case_product,
        units_per_case: row.units_per_case,
        case_sku: row.case_sku
      };
    }
  });
  
  console.log(`商品マスタマップ登録SKU数: ${Object.keys(masterMap).length}`);
  
  return masterMap;
}

/**
 * 在庫データ変換（ケース→個数変換）
 */
function convertInventoryData(inventoryData, productMaster) {
  const now = new Date().toISOString();
  const rows = [];
  
  inventoryData.forEach(item => {
    // APIレスポンスのフィールド名を想定
    // 実際のAPI仕様に応じて調整が必要
    const sku = item.sku || item.SKU || item.itemCode;
    let quantity = parseInt(item.quantity || item.stock || item.available || 0);
    
    if (!sku) {
      console.warn('SKUが見つかりません:', item);
      return;
    }
    
    // 商品マスタから情報取得
    const product = productMaster[sku];
    let isCaseConverted = false;
    let finalSku = sku;
    
    // ケース商品の場合、個数に変換
    if (product && product.is_case_product && product.units_per_case > 1) {
      console.log(`ケース変換: ${sku} → ${quantity}ケース × ${product.units_per_case}個 = ${quantity * product.units_per_case}個`);
      quantity = quantity * product.units_per_case;
      isCaseConverted = true;
      
      // master_skuを使用
      finalSku = product.master_sku || sku;
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
      original_quantity: item.quantity || item.stock || item.available
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