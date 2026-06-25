const https = require('https');

const API_KEY = 'ielkyvGF.XXmcvBWuMLWLtFpEOLR065wStIWFhgt1';
const BASE = 'api.homedata.co.uk';

function apiGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BASE,
      path: path,
      method: 'GET',
      headers: {
        'Authorization': 'Api-Key ' + API_KEY,
        'Accept': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch(e) {
          reject(new Error('JSON parse error: ' + data.substring(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function growthMultiplier(soldYear) {
  const years = new Date().getFullYear() - parseInt(soldYear);
  if (years <= 0) return 1.0;
  return Math.pow(1.045, Math.min(years, 25));
}

function formatPostcode(pc) {
  const clean = pc.toUpperCase().replace(/\s+/g, '');
  return clean.replace(/([A-Z]{1,2}[0-9]{1,2}[A-Z]?)([0-9][A-Z]{2})$/, '$1 $2');
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const params = event.queryStringParameters || {};
    const rawPostcode = (params.postcode || '').trim();
    const house = (params.house || '').trim();
    const street = (params.street || '').trim();

    if (!rawPostcode) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Postcode required' }) };
    }

    const formattedPC = formatPostcode(rawPostcode);
    const outward = formattedPC.replace(/\s*[0-9][A-Z]{2}$/, '').trim();

    let uprn = null;
    let propertyData = null;
    let level = 'area';
    let baseEstimate = 0;
    let recentSales = [];
    let salesCount = 0;
    let avgSalePrice = 0;
    let propertyDetails = null;

    // STEP 1: Find address -> get UPRN
    if (house) {
      const query = encodeURIComponent(house + ' ' + (street ? street + ' ' : '') + formattedPC);
      try {
        const findResult = await apiGet('/api/address/find/?q=' + query);
        if (findResult.status === 200 && findResult.body) {
          // Try different response shapes
          const suggestions = findResult.body.suggestions || findResult.body.data || findResult.body.results || [];
          if (suggestions.length > 0) {
            uprn = suggestions[0].uprn;
          }
        }
      } catch(e) { /* continue without UPRN */ }
    }

    // STEP 2: Get property details + sale history using UPRN
    if (uprn) {
      try {
        const propResult = await apiGet('/api/properties/' + uprn + '/');
        if (propResult.status === 200 && propResult.body) {
          const prop = propResult.body;
          propertyDetails = {
            bedrooms: prop.bedrooms || null,
            propertyType: prop.property_type || null,
            tenure: prop.tenure || null,
            floorArea: prop.floor_area_sqm || null,
            epc: prop.epc_rating || null
          };
        }
      } catch(e) { /* continue */ }

      // Get sale history for this specific property
      try {
        const salesResult = await apiGet('/api/property_sales/?uprn=' + uprn);
        if (salesResult.status === 200 && salesResult.body && salesResult.body.results && salesResult.body.results.length > 0) {
          const prop = salesResult.body.results[0];
          const events = prop.property_sale_events || [];
          // Find the most recent completed sale
          const completedSales = events.filter(e => e.event_type === 'Completed' && e.price);
          if (completedSales.length > 0) {
            const lastSale = completedSales[completedSales.length - 1];
            const soldYear = lastSale.date ? lastSale.date.substring(0, 4) : '2018';
            baseEstimate = Math.round(lastSale.price * growthMultiplier(soldYear));
            level = 'property';
          }
        }
      } catch(e) { /* continue */ }
    }

    // STEP 3: Get postcode-level sold prices for comparables and table
    try {
      const pcEncoded = encodeURIComponent(formattedPC);
      const soldResult = await apiGet('/api/property_sales/?postcode=' + pcEncoded + '&limit=20');
      if (soldResult.status === 200 && soldResult.body && soldResult.body.results) {
        const results = soldResult.body.results;
        const allPrices = [];
        results.forEach(prop => {
          const events = prop.property_sale_events || [];
          events.filter(e => e.event_type === 'Completed' && e.price).forEach(e => {
            allPrices.push(e.price);
            recentSales.push({
              address: prop.address || '',
              amount: e.price,
              date: e.date
            });
          });
        });
        if (allPrices.length > 0) {
          avgSalePrice = Math.round(allPrices.reduce((a, b) => a + b, 0) / allPrices.length);
          salesCount = allPrices.length;
          if (level !== 'property') {
            baseEstimate = avgSalePrice;
            level = 'postcode';
          }
        }
        recentSales = recentSales.slice(0, 10);
      }
    } catch(e) { /* continue */ }

    // STEP 4: Fallback to price trends for outward code
    if (baseEstimate === 0) {
      try {
        const trendResult = await apiGet('/api/price_trends/' + encodeURIComponent(outward) + '/');
        if (trendResult.status === 200 && trendResult.body && trendResult.body.trends) {
          const trends = trendResult.body.trends;
          if (trends.length > 0) {
            const latest = trends[trends.length - 1];
            baseEstimate = latest.median_price || 0;
            level = 'area';
          }
        }
      } catch(e) { /* continue */ }
    }

    // Final fallback
    if (baseEstimate === 0) {
      baseEstimate = 350000;
      level = 'none';
    }

    const margin = level === 'property' ? 0.06 : level === 'postcode' ? 0.09 : 0.13;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        level,
        formattedPostcode: formattedPC,
        baseEstimate,
        saleLow: Math.round(baseEstimate * (1 - margin)),
        saleHigh: Math.round(baseEstimate * (1 + margin)),
        rentLow: Math.round((baseEstimate * 0.045 * 0.92) / 12),
        rentHigh: Math.round((baseEstimate * 0.045 * 1.08) / 12),
        averageSalePrice: avgSalePrice,
        salesCount,
        recentSales,
        propertyDetails,
        outward
      })
    };

  } catch(err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server error', message: err.message })
    };
  }
};
