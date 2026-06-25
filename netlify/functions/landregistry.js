const https = require('https');

// Helper: make HTTPS request
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'Accept': 'application/sparql-results+json',
        'User-Agent': 'CoffeeAndBagelEstates/1.0'
      }
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Invalid JSON response')); }
      });
    }).on('error', reject);
  });
}

// Format postcode properly (e.g. N98JS -> N9 8JS)
function formatPostcode(pc) {
  const clean = pc.toUpperCase().replace(/\s+/g, '');
  return clean.replace(/([A-Z]{1,2}[0-9]{1,2}[A-Z]?)([0-9][A-Z]{2})$/, '$1 $2');
}

// Get outward code (e.g. N9 8JS -> N9)
function getOutward(pc) {
  return pc.replace(/\s*[0-9][A-Z]{2}$/, '').trim();
}

// Build SPARQL query
function buildQuery(filter) {
  return encodeURIComponent(
    `SELECT ?amount ?date ?propertyType ?paon ?street WHERE {
      ?t lrppi:pricePaid ?amount ;
         lrppi:transactionDate ?date ;
         lrppi:propertyAddress ?addr .
      ?addr lrcommon:paon ?paon ;
            lrcommon:street ?street ;
            ${filter}
    } ORDER BY DESC(?date) LIMIT 20`
  );
}

// Calculate annual growth multiplier (North London avg ~4.5%/yr)
function growthMultiplier(soldYear) {
  const years = new Date().getFullYear() - soldYear;
  if (years <= 0) return 1.0;
  return Math.pow(1.045, Math.min(years, 25));
}

exports.handler = async function(event) {
  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const params = event.queryStringParameters || {};
    const rawPostcode = params.postcode || '';
    const houseNumber = (params.house || '').toUpperCase().trim();

    if (!rawPostcode) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Postcode is required' })
      };
    }

    const formattedPC = formatPostcode(rawPostcode);
    const outward = getOutward(formattedPC);
    const BASE_URL = 'https://landregistry.data.gov.uk/landregistry/query?output=json&query=';

    let results = [];
    let level = 'area';

    // LEVEL 1: Try specific property (house number + exact postcode)
    if (houseNumber) {
      const q1 = buildQuery(`lrcommon:postcode "${formattedPC}" ; lrcommon:paon "${houseNumber}" .`);
      try {
        const data1 = await httpsGet(BASE_URL + q1);
        const bindings1 = data1.results && data1.results.bindings ? data1.results.bindings : [];
        if (bindings1.length > 0) {
          results = bindings1;
          level = 'property';
        }
      } catch(e) { /* fall through */ }
    }

    // LEVEL 2: Same full postcode, any property
    if (results.length === 0) {
      const q2 = buildQuery(`lrcommon:postcode "${formattedPC}" .`);
      try {
        const data2 = await httpsGet(BASE_URL + q2);
        const bindings2 = data2.results && data2.results.bindings ? data2.results.bindings : [];
        if (bindings2.length > 0) {
          results = bindings2;
          level = 'postcode';
        }
      } catch(e) { /* fall through */ }
    }

    // LEVEL 3: Outward code (e.g. N9), last 5 years
    if (results.length === 0) {
      const q3 = encodeURIComponent(
        `SELECT ?amount ?date ?paon ?street WHERE {
          ?t lrppi:pricePaid ?amount ;
             lrppi:transactionDate ?date ;
             lrppi:propertyAddress ?addr .
          ?addr lrcommon:postcode ?pc ;
                lrcommon:paon ?paon ;
                lrcommon:street ?street .
          FILTER(STRSTARTS(str(?pc), "${outward}"))
          FILTER(?date > "2020-01-01"^^xsd:date)
        } ORDER BY DESC(?date) LIMIT 25`
      );
      try {
        const data3 = await httpsGet(BASE_URL + q3);
        const bindings3 = data3.results && data3.results.bindings ? data3.results.bindings : [];
        if (bindings3.length > 0) {
          results = bindings3;
          level = 'area';
        }
      } catch(e) { /* fall through */ }
    }

    // Process results
    const sales = results
      .map(r => ({
        amount: parseInt(r.amount && r.amount.value),
        date: r.date && r.date.value ? r.date.value : null,
        address: (r.paon && r.paon.value ? r.paon.value + ' ' : '') +
                 (r.street && r.street.value ? r.street.value : '')
      }))
      .filter(s => s.amount > 30000 && s.amount < 10000000);

    // Calculate estimate
    let baseEstimate = 0;
    if (level === 'property' && sales.length > 0) {
      // Use most recent sale of this specific property + growth
      const lastSale = sales[0];
      const soldYear = lastSale.date ? parseInt(lastSale.date.substring(0, 4)) : 2018;
      baseEstimate = Math.round(lastSale.amount * growthMultiplier(soldYear));
    } else if (sales.length > 0) {
      // Average of comparable sales
      const total = sales.reduce((sum, s) => sum + s.amount, 0);
      baseEstimate = Math.round(total / sales.length);
    } else {
      // No data — North London default
      baseEstimate = 380000;
      level = 'none';
    }

    // Range margin depends on confidence
    const margin = level === 'property' ? 0.06 : level === 'postcode' ? 0.09 : 0.13;
    const avgSales = sales.length > 0
      ? Math.round(sales.reduce((s, a) => s + a.amount, 0) / sales.length)
      : 0;

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
        averageSalePrice: avgSales,
        salesCount: sales.length,
        recentSales: sales.slice(0, 10),
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
