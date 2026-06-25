const https = require('https');

function httpsGet(url, apiKey) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'Authorization': 'Api-Key ' + apiKey,
        'Accept': 'application/json',
        'User-Agent': 'CoffeeAndBagelEstates/1.0'
      }
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(new Error('Invalid JSON: ' + data.substring(0, 100))); }
      });
    }).on('error', reject);
  });
}

function formatPostcode(pc) {
  const clean = pc.toUpperCase().replace(/\s+/g, '');
  return clean.replace(/([A-Z]{1,2}[0-9]{1,2}[A-Z]?)([0-9][A-Z]{2})$/, '$1 $2');
}

function growthMultiplier(soldYear) {
  const years = new Date().getFullYear() - soldYear;
  if (years <= 0) return 1.0;
  return Math.pow(1.045, Math.min(years, 25));
}

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const API_KEY = 'ielkyvGF.XXmcvBWuMLWLtFpEOLR065wStIWFhgt1';

  try {
    const params = event.queryStringParameters || {};
    const rawPostcode = (params.postcode || '').trim();
    const houseNumber = (params.house || '').trim();
    const streetName = (params.street || '').trim().toUpperCase();

    if (!rawPostcode) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Postcode required' }) };
    }

    const formattedPC = formatPostcode(rawPostcode);
    const outward = formattedPC.replace(/\s*[0-9][A-Z]{2}$/, '').trim();

    // STEP 1: Try to find specific property using address search
    let uprn = null;
    let propertyRecord = null;

    if (houseNumber) {
      const searchQuery = encodeURIComponent(houseNumber + ' ' + (streetName || '') + ' ' + formattedPC);
      const searchUrl = 'https://api.homedata.co.uk/api/address/find/?q=' + searchQuery + '&limit=5';

      try {
        const searchResult = await httpsGet(searchUrl, API_KEY);
        if (searchResult.status === 200 && searchResult.body && searchResult.body.results && searchResult.body.results.length > 0) {
          const match = searchResult.body.results[0];
          uprn = match.uprn;
        }
      } catch(e) { /* continue */ }
    }

    // STEP 2: If we have a UPRN, get full property details
    if (uprn) {
      const detailUrl = 'https://api.homedata.co.uk/api/uprn/' + uprn + '/';
      try {
        const detailResult = await httpsGet(detailUrl, API_KEY);
        if (detailResult.status === 200 && detailResult.body) {
          propertyRecord = detailResult.body;
        }
      } catch(e) { /* continue */ }
    }

    // STEP 3: Get sold prices for the postcode area
    const soldUrl = 'https://api.homedata.co.uk/api/sold-prices/?postcode=' + encodeURIComponent(formattedPC) + '&limit=20';
    let soldPrices = [];
    try {
      const soldResult = await httpsGet(soldUrl, API_KEY);
      if (soldResult.status === 200 && soldResult.body && soldResult.body.results) {
        soldPrices = soldResult.body.results;
      }
    } catch(e) { /* continue */ }

    // STEP 4: Calculate estimate
    let baseEstimate = 0;
    let level = 'area';
    let salesCount = soldPrices.length;

    if (propertyRecord && propertyRecord.last_sale_price && propertyRecord.last_sale_date) {
      // Best case: specific property found with last sale price
      const soldYear = parseInt(propertyRecord.last_sale_date.substring(0, 4));
      baseEstimate = Math.round(propertyRecord.last_sale_price * growthMultiplier(soldYear));
      level = 'property';
    } else if (soldPrices.length > 0) {
      // Use postcode sold prices
      const amounts = soldPrices
        .map(s => s.price)
        .filter(p => p && p > 30000 && p < 10000000);
      if (amounts.length > 0) {
        baseEstimate = Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length);
        level = 'postcode';
        salesCount = amounts.length;
      }
    }

    // Fallback
    if (baseEstimate === 0) {
      baseEstimate = 350000;
      level = 'none';
      salesCount = 0;
    }

    const margin = level === 'property' ? 0.06 : level === 'postcode' ? 0.09 : 0.13;
    const avgSalePrice = soldPrices.length > 0
      ? Math.round(soldPrices.filter(s => s.price > 0).reduce((a, s) => a + s.price, 0) / soldPrices.filter(s => s.price > 0).length)
      : 0;

    // Build recent sales list
    const recentSales = soldPrices.slice(0, 10).map(s => ({
      address: s.address || '',
      amount: s.price || 0,
      date: s.date || null
    }));

    // Property details if available
    const propertyDetails = propertyRecord ? {
      bedrooms: propertyRecord.bedrooms || null,
      propertyType: propertyRecord.property_type || null,
      tenure: propertyRecord.tenure || null,
      epc: propertyRecord.epc_rating || null
    } : null;

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

  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server error', message: err.message })
    };
  }
};
