const { BigQuery } = require('@google-cloud/bigquery');
const axios = require('axios');

const bigquery = new BigQuery();
const projectId = 'andcore2';
const datasetId = 'andcore_main';

// Amazon SP-API設定
const MARKETPLACE_IDS = {
  JP: 'A1VC38T7YXB528',
  US: 'ATVPDKIKX0DER',
  CA: 'A2EUQ1WTGCTBG2',
  MX: 'A1AM78C64UM0Y8'
};

const ENDPOINTS = {
  JP: 'https://sellingpartnerapi-fe.amazon.com',
  US: 'https://sellingpartnerapi-na.amazon.com',
  CA: 'https://sellingpartnerapi-na.amazon.com',
  MX: 'https://sellingpartnerapi-na.amazon.com'
};

/**
 * Amazon LWA Access Token取得
 */
async function getAccessToken(clientId, clientSecret, refreshToken) {
  try {
    const response = await axios.post('https://api.amazon.com/auth/o2/token', {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret
    }, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    
    return response.data.access_token;
  } catch (error) {
    console.error('Access Token取得エラー:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * FBA在庫データ取得
 */
async function getFBAInventory(accessToken, marketplace, accountNum) {
  const marketplaceId = MARKETPLACE_IDS[marketplace];
  const endpoint = ENDPOINTS[marketplace];
  
  const url = `${endpoint}/fba/inventory/v1/summaries`;
  
  try {
    const response = await axios.get(url, {
      headers: {
        'x-amz-access-token': accessToken,
        'Content-Type': 'application/json'
      },
      params: {
        granularityType: 'Marketplace',
        granularityId: marketplaceId,
        marketplaceIds: marketplaceId
      }
    });
    
    console.log(`✅ FBA在庫取得成功 (${marketplace}):`, response.data.payload?.inventorySummaries?.length || 0, '件');
    return response.data.payload?.inventorySummaries || [];
    
  } catch (error) {
    if (error.response?.status === 429) {
      console.warn('⚠️ レート制限に達しました。60秒待機...');
      await new Promise(resolve => setTimeout(resolve, 60000));
      return getFBAInventory(accessToken, marketplace, accountNum);
    }
    console.error('FBA在庫取得エラー:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * BigQueryに在庫データを保存（MERGE方式）
 */
async function saveInventoryToBigQuery(inventoryData) {
  if (inventoryData.length === 0) {
    console.log('⚠️ 保存する在庫データがありません');
    return;
  }

  const tempTableId = 'inventory_temp_amazon_' + Date.now();
  
  try {
    // 1. 一時テーブル作成
    console.log('📝 一時テーブル作成中...');
    const [tempTable] = await bigquery.dataset(datasetId).createTable(tempTableId, {
      schema: [
        { name: 'sku', type: 'STRING', mode: 'REQUIRED' },
        { name: 'location', type: 'STRING', mode: 'REQUIRED' },
        { name: 'location_type', type: 'STRING' },
        { name: 'available_quantity', type: 'INTEGER' },
        { name: 'reserved_quantity', type: 'INTEGER' },
        { name: 'inbound_quantity', type: 'INTEGER' },
        { name: 'total_quantity', type: 'INTEGER' },
        { name: 'last_updated', type: 'TIMESTAMP' },
        { name: 'sync_status', type: 'STRING' }
      ],
      timePartitioning: null,
      clustering: null
    });
    
    console.log(`✅ 一時テーブル作成完了: ${tempTableId}`);
    
    // 2. バッチinsert（500件ずつ）
    console.log('📥 データ投入中...');
    const batchSize = 500;
    for (let i = 0; i < inventoryData.length; i += batchSize) {
      const batch = inventoryData.slice(i, i + batchSize);
      await bigquery.dataset(datasetId).table(tempTableId).insert(batch);
      console.log(`   ${i + batch.length}/${inventoryData.length} 件投入完了`);
    }
    
    // 3. 90秒待機（ストリーミングバッファ対策）
    console.log('⏳ 90秒待機中（ストリーミングバッファ対策）...');
    await new Promise(resolve => setTimeout(resolve, 90000));
    
    // 4. MERGE実行
    console.log('🔄 MERGE実行中...');
    const mergeQuery = `
    MERGE \`${projectId}.${datasetId}.inventory\` T
    USING (
        SELECT DISTINCT
        sku,
        location,
        location_type,
        available_quantity,
        reserved_quantity,
        inbound_quantity,
        total_quantity,
        last_updated,
        sync_status
        FROM \`${projectId}.${datasetId}.${tempTableId}\`
    ) S
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
        available_quantity, reserved_quantity, inbound_quantity, total_quantity,
        last_updated, sync_status
        )
        VALUES (
        S.sku, S.location, S.location_type,
        S.available_quantity, S.reserved_quantity, S.inbound_quantity, S.total_quantity,
        S.last_updated, S.sync_status
        )
    `;

    const [job] = await bigquery.createQueryJob({ 
    query: mergeQuery,
    location: 'asia-northeast2'  // ← これを追加
    });
    await job.getQueryResults();
    console.log('✅ MERGE完了');
    
    // 5. 一時テーブル削除
    await bigquery.dataset(datasetId).table(tempTableId).delete();
    console.log('🗑️ 一時テーブル削除完了');
    
  } catch (error) {
    console.error('❌ BigQuery保存エラー:', error);
    // エラー時も一時テーブルを削除
    try {
      await bigquery.dataset(datasetId).table(tempTableId).delete();
    } catch (e) {}
    throw error;
  }
}

/**
 * メイン処理
 */
exports.syncAmazonFBAInventory = async (req, res) => {
  console.log('🚀 Amazon FBA在庫同期開始');
  console.log('📅 実行日時:', new Date().toISOString());
  
  const accountNum = req.query.account || '1';
  const marketplace = req.query.marketplace || 'JP';
  
  console.log(`📦 アカウント${accountNum} (${marketplace})`);
  
  try {
    // 環境変数取得
    const clientId = process.env[`AMAZON_${marketplace}_CLIENT_ID_${accountNum}`];
    const clientSecret = process.env[`AMAZON_${marketplace}_CLIENT_SECRET_${accountNum}`];
    const refreshToken = process.env[`AMAZON_${marketplace}_REFRESH_TOKEN_${accountNum}`];
    const accountName = process.env[`ACCOUNT_NAME_${accountNum}`] || `Amazon ${marketplace} ${accountNum}`;
    
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error(`環境変数が設定されていません (アカウント${accountNum}, ${marketplace})`);
    }
    
    // 1. Access Token取得
    console.log('🔐 Access Token取得中...');
    const accessToken = await getAccessToken(clientId, clientSecret, refreshToken);
    console.log('✅ Access Token取得完了');
    
    // 2. FBA在庫データ取得
    console.log('📦 FBA在庫データ取得中...');
    const inventorySummaries = await getFBAInventory(accessToken, marketplace, accountNum);
    
    if (inventorySummaries.length === 0) {
      console.log('⚠️ 在庫データが0件でした');
      res.status(200).json({
        success: true,
        message: '在庫データが0件でした',
        account: accountName,
        marketplace: marketplace,
        count: 0
      });
      return;
    }
    
    // 3. データ整形
    console.log('🔄 データ整形中...');
    const inventoryData = inventorySummaries.map(item => {
      const fnSku = item.fnSku || item.sellerSku;
      const condition = item.condition || 'NEW';
      
      return {
        sku: fnSku,
        location: `FBA-${marketplace}-${accountNum}`,
        location_type: 'FBA',
        available_quantity: item.totalQuantity || 0,
        reserved_quantity: item.reservedQuantity?.totalReservedQuantity || 0,
        inbound_quantity: item.inboundWorkingQuantity || 0,
        total_quantity: (item.totalQuantity || 0) + (item.inboundWorkingQuantity || 0),
        last_updated: new Date().toISOString(),
        sync_status: 'success'
      };
    });
    
    console.log(`✅ データ整形完了: ${inventoryData.length}件`);
    
    // 4. BigQueryに保存
    console.log('💾 BigQueryに保存中...');
    await saveInventoryToBigQuery(inventoryData);
    console.log('✅ BigQuery保存完了');
    
    // 5. 完了レスポンス
    const response = {
      success: true,
      message: 'Amazon FBA在庫同期完了',
      account: accountName,
      marketplace: marketplace,
      inventoryCount: inventoryData.length,
      timestamp: new Date().toISOString()
    };
    
    console.log('🎉 同期完了:', response);
    res.status(200).json(response);
    
  } catch (error) {
    console.error('❌ エラー発生:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
};