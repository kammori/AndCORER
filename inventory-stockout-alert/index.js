const { BigQuery } = require('@google-cloud/bigquery');
const axios = require('axios');

const bigquery = new BigQuery();
const datasetId = 'andcore_main';

/**
 * 在庫切れアラート機能
 * 
 * 機能:
 * - 過去30日の販売数から在庫切れ予測
 * - Critical/Warning判定
 * - Slack通知
 * - stockout_alertテーブルに記録
 */
exports.checkStockoutAlert = async (req, res) => {
  console.log('🚨 在庫切れアラートチェック開始');
  console.log('📅 実行日時:', new Date().toISOString());
  
  try {
    // 1. 過去30日の販売データを集計（master_sku単位）
    console.log('📊 過去30日の販売データ集計中...');
    const salesQuery = `
      WITH sales_summary AS (
        SELECT
          cs.master_sku,
          pm.product_name,
          SUM(oi.quantity) as total_sold,
          COUNT(DISTINCT DATE(o.order_date)) as sales_days,
          SUM(oi.quantity) / 30.0 as daily_avg_sales
        FROM \`${datasetId}.order_items\` oi
        JOIN \`${datasetId}.orders\` o 
          ON oi.order_id = o.order_id AND oi.channel = o.channel
        LEFT JOIN \`${datasetId}.channel_settings\` cs
          ON oi.sku = cs.channel_sku AND o.account_name = cs.account_name
        LEFT JOIN \`${datasetId}.product_master\` pm
          ON cs.master_sku = pm.master_sku
        WHERE o.order_date >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
          AND cs.master_sku IS NOT NULL
        GROUP BY cs.master_sku, pm.product_name
        HAVING SUM(oi.quantity) > 0
      )
      SELECT * FROM sales_summary
      ORDER BY daily_avg_sales DESC
    `;
    
    const [salesResults] = await bigquery.query(salesQuery);
    console.log(`✅ 販売データ取得: ${salesResults.length}商品（master_sku単位）`);
    
    // 2. 現在の在庫データを取得（master_sku単位、二重計上回避）
    console.log('📦 現在の在庫データ取得中...');
    const inventoryQuery = `
      WITH unique_sku_map AS (
        -- SKU文字列が同じなら、どのアカウント設定でも同じMasterSKUを指すと仮定して重複を排除
        SELECT DISTINCT channel_sku, master_sku
        FROM \`${datasetId}.channel_settings\`
        WHERE master_sku IS NOT NULL
      )
      SELECT
        map.master_sku,
        inv.location,
        inv.location_type,
        inv.available_quantity,
        inv.reserved_quantity,
        inv.inbound_quantity,
        inv.total_quantity
      FROM \`${datasetId}.inventory\` inv
      JOIN unique_sku_map map
        ON inv.sku = map.channel_sku
      WHERE (inv.available_quantity > 0 OR inv.inbound_quantity > 0)
    `;
    
    const [inventoryResults] = await bigquery.query(inventoryQuery);
    console.log(`✅ 在庫データ取得: ${inventoryResults.length}件`);
    
    // 3. master_sku単位で在庫を集計
    const inventoryByMasterSku = {};
    inventoryResults.forEach(item => {
      if (!inventoryByMasterSku[item.master_sku]) {
        inventoryByMasterSku[item.master_sku] = {
          available: 0,
          inbound: 0,
          total: 0,
          locations: []
        };
      }
      inventoryByMasterSku[item.master_sku].available += item.available_quantity;
      inventoryByMasterSku[item.master_sku].inbound += item.inbound_quantity;
      inventoryByMasterSku[item.master_sku].total += item.total_quantity;
      inventoryByMasterSku[item.master_sku].locations.push({
        location: item.location,
        available: item.available_quantity
      });
    });
    
    // 4. 在庫切れ予測計算（master_sku単位）
    console.log('🔮 在庫切れ予測計算中...');
    const alerts = [];
    
    salesResults.forEach(sale => {
      const inventory = inventoryByMasterSku[sale.master_sku];
      
      if (!inventory || inventory.available === 0) {
        // 在庫なし（すでに切れている）
        alerts.push({
          master_sku: sale.master_sku,
          product_name: sale.product_name || sale.master_sku,
          current_stock: 0,
          inbound_stock: inventory ? inventory.inbound : 0,
          daily_sales_rate: sale.daily_avg_sales,
          days_until_stockout: 0,
          alert_level: 'CRITICAL',
          suggested_order_qty: Math.ceil(sale.daily_avg_sales * 30),
          message: '🔴 在庫切れ中'
        });
      } else {
        const daysUntilStockout = Math.floor(inventory.available / sale.daily_avg_sales);
        
        let alertLevel = 'NORMAL';
        let message = '';
        
        if (daysUntilStockout <= 7) {
          alertLevel = 'CRITICAL';
          message = `🔴 あと${daysUntilStockout}日で在庫切れ`;
        } else if (daysUntilStockout <= 14) {
          alertLevel = 'WARNING';
          message = `⚠️ あと${daysUntilStockout}日で在庫切れ`;
        }
        
        if (alertLevel !== 'NORMAL') {
          alerts.push({
            master_sku: sale.master_sku,
            product_name: sale.product_name || sale.master_sku,
            current_stock: inventory.available,
            inbound_stock: inventory.inbound,
            daily_sales_rate: parseFloat(sale.daily_avg_sales.toFixed(2)),
            days_until_stockout: daysUntilStockout,
            alert_level: alertLevel,
            suggested_order_qty: Math.ceil(sale.daily_avg_sales * 30) - inventory.available - inventory.inbound,
            message: message
          });
        }
      }
    });
    
    console.log(`⚠️ アラート対象: ${alerts.length}商品`);
    console.log(`   🔴 CRITICAL: ${alerts.filter(a => a.alert_level === 'CRITICAL').length}件`);
    console.log(`   ⚠️ WARNING: ${alerts.filter(a => a.alert_level === 'WARNING').length}件`);
    
    // 5. BigQueryに記録
    if (alerts.length > 0) {
      console.log('💾 BigQueryに記録中...');
      await saveAlertsToBigQuery(alerts);
    }
    
    // 6. Slack通知
    if (alerts.length > 0) {
      console.log('📢 Slack通知送信中...');
      await sendSlackNotification(alerts);
    }
    
    // 7. 完了レスポンス
    res.status(200).json({
      success: true,
      message: '在庫切れアラートチェック完了',
      summary: {
        total_skus_checked: salesResults.length,
        alerts_count: alerts.length,
        critical: alerts.filter(a => a.alert_level === 'CRITICAL').length,
        warning: alerts.filter(a => a.alert_level === 'WARNING').length
      },
      alerts: alerts.slice(0, 10) // 最初の10件のみレスポンスに含める
    });
    
  } catch (error) {
    console.error('❌ エラー:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
};

/**
 * アラートをBigQueryに保存
 */
async function saveAlertsToBigQuery(alerts) {
  const records = alerts.map(alert => ({
    sku: alert.master_sku,  // stockout_alertテーブルのskuカラムにmaster_skuを保存
    location: 'ALL', // 全拠点合計
    predicted_stockout_date: calculateStockoutDate(alert.days_until_stockout),
    current_stock: alert.current_stock,
    daily_sales_rate: alert.daily_sales_rate,
    days_until_stockout: alert.days_until_stockout,
    alert_level: alert.alert_level,
    suggested_order_qty: Math.max(0, alert.suggested_order_qty),
    calculated_at: new Date().toISOString()
  }));
  
  // バッチinsert
  const batchSize = 500;
  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize);
    await bigquery.dataset(datasetId).table('stockout_alert').insert(batch);
  }
  
  console.log(`✅ BigQueryに${records.length}件保存完了`);
}

/**
 * Slack通知送信
 */
async function sendSlackNotification(alerts) {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  
  if (!webhookUrl) {
    console.warn('⚠️ SLACK_WEBHOOK_URLが設定されていません');
    return;
  }
  
  // Critical のみ通知（多すぎる場合は上位10件）
  const criticalAlerts = alerts
    .filter(a => a.alert_level === 'CRITICAL')
    .slice(0, 10);
  
  const warningCount = alerts.filter(a => a.alert_level === 'WARNING').length;
  
  if (criticalAlerts.length === 0 && warningCount === 0) {
    return;
  }
  
  // Slackメッセージ作成
  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: '🚨 在庫切れアラート'
      }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*サマリー*\n🔴 Critical: ${criticalAlerts.length}件\n⚠️ Warning: ${warningCount}件`
      }
    },
    {
      type: 'divider'
    }
  ];
  
  // Critical アラート詳細
  criticalAlerts.forEach(alert => {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${alert.product_name}*\n` +
              `Master SKU: \`${alert.master_sku}\`\n` +
              `${alert.message}\n` +
              `現在庫: ${alert.current_stock}個 | 入庫予定: ${alert.inbound_stock}個\n` +
              `日次平均販売: ${alert.daily_sales_rate}個/日\n` +
              `📦 推奨発注数: ${Math.max(0, alert.suggested_order_qty)}個`
      }
    });
  });
  
  // Slack送信
  try {
    await axios.post(webhookUrl, {
      blocks: blocks
    });
    console.log('✅ Slack通知送信完了');
  } catch (error) {
    console.error('❌ Slack通知送信エラー:', error.message);
  }
}

/**
 * 在庫切れ予測日を計算
 */
function calculateStockoutDate(daysUntilStockout) {
  const date = new Date();
  date.setDate(date.getDate() + daysUntilStockout);
  return date.toISOString().split('T')[0]; // YYYY-MM-DD形式
}