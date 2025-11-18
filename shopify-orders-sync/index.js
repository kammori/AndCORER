const { BigQuery } = require('@google-cloud/bigquery');
const fetch = require('node-fetch');
const bigquery = new BigQuery();

/**
 * Shopify注文データ同期（全期間対応 + ストリーミングバッファ回避 + 配送先情報）
 */
exports.syncShopifyOrders = async (req, res) => {
  try {
    const accountNum = req.query.account || '1';
    
    const SHOPIFY_STORE = process.env[`SHOPIFY_STORE_${accountNum}`] || process.env.SHOPIFY_STORE;
    const SHOPIFY_ACCESS_TOKEN = process.env[`SHOPIFY_ACCESS_TOKEN_${accountNum}`] || process.env.SHOPIFY_ACCESS_TOKEN;
    const ACCOUNT_NAME = process.env[`ACCOUNT_NAME_${accountNum}`] || process.env.ACCOUNT_NAME || 'Shopify-1';
    
    // リクエストパラメータ
    const daysBack = parseInt(req.query.days_back) || 30;
    const isFullSync = req.query.full_sync === 'true';
    
    if (!SHOPIFY_STORE || !SHOPIFY_ACCESS_TOKEN) {
      throw new Error('環境変数が設定されていません');
    }
    
    const projectId = await bigquery.getProjectId();
    let allOrders = [];
    let pageInfo = null;
    let pageCount = 0;
    const maxPages = isFullSync ? 200 : 20;
    
    console.log(`📡 Starting sync: ${isFullSync ? 'FULL' : 'INCREMENTAL'} (${daysBack} days)`);
    
    // =====================================
    // Step 1: Shopify APIからデータ取得
    // =====================================
    while (pageCount < maxPages) {
      pageCount++;
      
      const baseUrl = `https://${SHOPIFY_STORE}.myshopify.com/admin/api/2024-10/orders.json`;
      const params = new URLSearchParams({
        status: 'any',
        limit: '250',
        created_at_min: new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString()
      });
      
      if (pageInfo) {
        params.set('page_info', pageInfo);
        params.delete('created_at_min');
        params.delete('status');
        params.delete('limit');
      }
      
      const url = pageInfo ? 
        `${baseUrl}?page_info=${pageInfo}&limit=250` : 
        `${baseUrl}?${params}`;
      
      console.log(`📄 Fetching page ${pageCount}...`);
      
      const response = await fetch(url, {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
          'Content-Type': 'application/json'
        }
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Shopify API Error: ${response.status} - ${errorText}`);
      }
      
      const data = await response.json();
      const orders = data.orders || [];
      
      console.log(`✅ Page ${pageCount}: ${orders.length} orders`);
      allOrders = allOrders.concat(orders);
      
      // 次のページ確認
      const linkHeader = response.headers.get('Link');
      if (!linkHeader || !linkHeader.includes('rel="next"')) {
        console.log('📋 No more pages. Finished fetching!');
        break;
      }
      
      const nextLinkMatch = linkHeader.match(/<[^>]*page_info=([^&>]+)[^>]*>;\s*rel="next"/);
      if (nextLinkMatch) {
        pageInfo = nextLinkMatch[1];
      } else {
        break;
      }
      
      // レート制限対策
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
    console.log(`🎉 Total orders retrieved: ${allOrders.length}`);
    
    if (allOrders.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No orders found',
        count: 0,
        pages: pageCount
      });
    }
    
    // =====================================
    // Step 2: データ変換（配送先情報追加）
    // =====================================
    const ordersForBQ = allOrders.map(order => {
      const fulfillmentDate = order.fulfillments && order.fulfillments.length > 0 
        ? order.fulfillments[0].created_at 
        : null;
      
      // 配送先情報の取得
      const shippingAddress = order.shipping_address || {};
      const shipState = shippingAddress.province || shippingAddress.province_code || '';
      const shipCity = shippingAddress.city || '';
      const shipPostalCode = shippingAddress.zip || '';

      return {
        order_id: `SHOPIFY-${ACCOUNT_NAME}-${order.id}`,
        channel: 'Shopify',
        account_name: ACCOUNT_NAME,
        order_number: order.name || order.order_number?.toString() || order.id.toString(),
        order_date: order.created_at,
        fulfillment_date: fulfillmentDate,
        customer_name: order.customer ? 
          `${order.customer.first_name || ''} ${order.customer.last_name || ''}`.trim() : 
          'Guest',
        ship_state: shipState,           // ← 追加
        ship_city: shipCity,             // ← 追加
        ship_postal_code: shipPostalCode, // ← 追加
        subtotal_amount: parseFloat(order.subtotal_price || 0),
        tax_amount: parseFloat(order.total_tax || 0),
        shipping_amount: parseFloat(order.total_shipping_price_set?.shop_money?.amount || 0),
        total_amount: parseFloat(order.total_price || 0),
        currency: order.currency || 'JPY',
        payment_status: order.financial_status || 'unknown',
        fulfillment_status: order.fulfillment_status || 'unfulfilled',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
    });
    
    const orderItemsForBQ = [];
    allOrders.forEach(order => {
      (order.line_items || []).forEach(item => {
        orderItemsForBQ.push({
          order_id: `SHOPIFY-${ACCOUNT_NAME}-${order.id}`,
          channel: 'Shopify',
          line_item_id: item.id.toString(),
          sku: item.sku || `SHOPIFY-${item.product_id}-${item.variant_id}`,
          product_name: item.name || item.title,
          quantity: item.quantity,
          unit_price: parseFloat(item.price || 0),
          line_total: parseFloat(item.price || 0) * item.quantity,
          currency: order.currency || 'JPY',
          quantity_fulfilled: item.fulfillment_status === 'fulfilled' ? item.quantity : 0,
          quantity_unfulfilled: item.fulfillment_status === 'fulfilled' ? 0 : item.quantity,
          created_at: new Date().toISOString()
        });
      });
    });
    
    // デバッグ: サンプル配送先データを表示
    if (ordersForBQ.length > 0) {
      console.log(`📍 Sample shipping address: ${ordersForBQ[0].ship_state} ${ordersForBQ[0].ship_city}`);
    }
    
    // =====================================
    // Step 3: 一時テーブル作成 & データ投入
    // =====================================
    const timestamp = Date.now();
    const tempTableOrders = `orders_temp_${timestamp}`;
    const tempTableItems = `order_items_temp_${timestamp}`;
    
    console.log(`💾 Creating temp table: ${tempTableOrders}...`);
    
    // 一時テーブル作成（orders）
    const [ordersTable] = await bigquery.dataset('andcore_main').createTable(tempTableOrders, {
      schema: [
        { name: 'order_id', type: 'STRING' },
        { name: 'channel', type: 'STRING' },
        { name: 'account_name', type: 'STRING' },
        { name: 'order_number', type: 'STRING' },
        { name: 'order_date', type: 'TIMESTAMP' },
        { name: 'fulfillment_date', type: 'TIMESTAMP' },
        { name: 'customer_name', type: 'STRING' },
        { name: 'ship_state', type: 'STRING' },        // ← 追加
        { name: 'ship_city', type: 'STRING' },         // ← 追加
        { name: 'ship_postal_code', type: 'STRING' },  // ← 追加
        { name: 'subtotal_amount', type: 'FLOAT' },
        { name: 'tax_amount', type: 'FLOAT' },
        { name: 'shipping_amount', type: 'FLOAT' },
        { name: 'total_amount', type: 'FLOAT' },
        { name: 'currency', type: 'STRING' },
        { name: 'payment_status', type: 'STRING' },
        { name: 'fulfillment_status', type: 'STRING' },
        { name: 'created_at', type: 'TIMESTAMP' },
        { name: 'updated_at', type: 'TIMESTAMP' }
      ]
    });
    
    console.log(`💾 Inserting ${ordersForBQ.length} orders to temp table...`);
    const chunkSize = 500;
    for (let i = 0; i < ordersForBQ.length; i += chunkSize) {
      const chunk = ordersForBQ.slice(i, i + chunkSize);
      await ordersTable.insert(chunk);
      console.log(`   Inserted ${i + 1} - ${Math.min(i + chunkSize, ordersForBQ.length)} orders`);
    }
    
    // 一時テーブル作成（order_items）
    console.log(`💾 Creating temp table: ${tempTableItems}...`);
    const [itemsTable] = await bigquery.dataset('andcore_main').createTable(tempTableItems, {
      schema: [
        { name: 'order_id', type: 'STRING' },
        { name: 'channel', type: 'STRING' },
        { name: 'line_item_id', type: 'STRING' },
        { name: 'sku', type: 'STRING' },
        { name: 'product_name', type: 'STRING' },
        { name: 'quantity', type: 'INTEGER' },
        { name: 'unit_price', type: 'FLOAT' },
        { name: 'line_total', type: 'FLOAT' },
        { name: 'currency', type: 'STRING' },
        { name: 'quantity_fulfilled', type: 'INTEGER' },
        { name: 'quantity_unfulfilled', type: 'INTEGER' },
        { name: 'created_at', type: 'TIMESTAMP' }
      ]
    });
    
    console.log(`💾 Inserting ${orderItemsForBQ.length} order items to temp table...`);
    for (let i = 0; i < orderItemsForBQ.length; i += chunkSize) {
      const chunk = orderItemsForBQ.slice(i, i + chunkSize);
      await itemsTable.insert(chunk);
      console.log(`   Inserted ${i + 1} - ${Math.min(i + chunkSize, orderItemsForBQ.length)} items`);
    }
    
    // =====================================
    // Step 4: ストリーミングバッファ待機
    // =====================================
    console.log('⏳ Waiting 90 seconds for streaming buffer to flush...');
    await new Promise(resolve => setTimeout(resolve, 90000));
    
    // =====================================
    // Step 5: MERGE実行（重複回避）
    // =====================================
    console.log('💾 MERGE: orders...');
    const mergeOrdersQuery = `
      MERGE \`${projectId}.andcore_main.orders\` T
      USING \`${projectId}.andcore_main.${tempTableOrders}\` S
      ON T.order_id = S.order_id AND T.channel = S.channel
      WHEN MATCHED THEN
        UPDATE SET
          order_number = S.order_number,
          order_date = S.order_date,
          fulfillment_date = S.fulfillment_date,
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
          updated_at = S.updated_at
      WHEN NOT MATCHED THEN
        INSERT (order_id, channel, account_name, order_number, order_date, 
                fulfillment_date, customer_name, ship_state, ship_city, ship_postal_code,
                subtotal_amount, tax_amount, shipping_amount, total_amount, currency,
                payment_status, fulfillment_status, created_at, updated_at)
        VALUES (S.order_id, S.channel, S.account_name, S.order_number, S.order_date,
                S.fulfillment_date, S.customer_name, S.ship_state, S.ship_city, S.ship_postal_code,
                S.subtotal_amount, S.tax_amount, S.shipping_amount,
                S.total_amount, S.currency, S.payment_status, S.fulfillment_status,
                S.created_at, S.updated_at)
    `;
    await bigquery.query(mergeOrdersQuery);
    console.log('✅ Orders merged successfully!');
    
    console.log('💾 MERGE: order_items...');
    const mergeItemsQuery = `
      MERGE \`${projectId}.andcore_main.order_items\` T
      USING \`${projectId}.andcore_main.${tempTableItems}\` S
      ON T.order_id = S.order_id AND T.channel = S.channel AND T.line_item_id = S.line_item_id
      WHEN MATCHED THEN
        UPDATE SET
          sku = S.sku,
          product_name = S.product_name,
          quantity = S.quantity,
          unit_price = S.unit_price,
          line_total = S.line_total,
          currency = S.currency,
          quantity_fulfilled = S.quantity_fulfilled,
          quantity_unfulfilled = S.quantity_unfulfilled
      WHEN NOT MATCHED THEN
        INSERT (order_id, channel, line_item_id, sku, product_name, quantity,
                unit_price, line_total, currency, quantity_fulfilled, quantity_unfulfilled, created_at)
        VALUES (S.order_id, S.channel, S.line_item_id, S.sku, S.product_name, S.quantity,
                S.unit_price, S.line_total, S.currency, S.quantity_fulfilled, 
                S.quantity_unfulfilled, S.created_at)
    `;
    await bigquery.query(mergeItemsQuery);
    console.log('✅ Order items merged successfully!');
    
    // =====================================
    // Step 6: 一時テーブル削除
    // =====================================
    console.log('🧹 Cleaning up temp tables...');
    await bigquery.dataset('andcore_main').table(tempTableOrders).delete();
    await bigquery.dataset('andcore_main').table(tempTableItems).delete();
    console.log('✅ Cleanup complete!');
    
    // =====================================
    // 完了レスポンス
    // =====================================
    res.status(200).json({
      success: true,
      message: 'Shopify orders synced successfully (no duplicates, with shipping info)',
      sync_type: isFullSync ? 'FULL' : 'INCREMENTAL',
      days_back: daysBack,
      orders_processed: ordersForBQ.length,
      items_processed: orderItemsForBQ.length,
      pages_fetched: pageCount,
      note: 'Data merged with deduplication and shipping address'
    });
    
  } catch (error) {
    console.error('❌ Error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
};