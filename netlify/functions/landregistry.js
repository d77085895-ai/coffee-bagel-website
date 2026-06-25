const https = require('https');

function sparqlQuery(query) {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(query);
    const path = '/landregistry/query?query=' + encoded + '&output=json';
    const options = {
      hostname: 'landregistry.data.gov.uk',
      path: path,
      method: 'GET',
      headers: {
        'Accept': 'application/sparql-results+json',
        'User-Agent': 'Mozilla/5.0 (compatible; CoffeeAndBagelEstates/1.0)'
      },
      timeout: 15000
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data), raw: data.substring(0, 200) });
        } catch(e) {
          resolve({ status: res.statusCode, body: null, raw: data.substring(0, 200), error: e.message });
        }
      });
    });
    req.on('error', (e) => resolve({ status: 0, body: null, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null, error: 'Timeout' }); });
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

  const debug = [];

  try {
    const params = event.queryStringParameters || {};
    const rawPostcode = (params.postcode || '').trim();
    const house = (params.house || '').toUpperCase().trim();

    if (!rawPostcode) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Postcode required' }) };
    }

    const formattedPC = formatPostcode(rawPostcode);
    const outward = formattedPC.replace(/\s*[0-9][A-Z]{2}$/, '').trim();
    debug.push('Postcode: ' + formattedPC + ', House: ' + house + ', Outward: ' + outward);

    let level = 'none';
    let baseEstimate = 0;
    let recentSales = [];
    let salesCount = 0;
    let avgSalePrice = 0;

    // LEVEL 1: Specific property
    if (house) {
      const q1 = `PREFIX lrppi: <http://landregistry.data.gov.uk/def/ppi/>
PREFIX lrcommon: <http://landregistry.data.gov.uk/def/common/>
SELECT ?amount ?date WHERE {
  ?t lrppi:pricePaid ?amount ; lrppi:transactionDate ?date ; lrppi:propertyAddress ?addr .
  ?addr lrcommon:paon "${house}" ; lrcommon:postcode "${formattedPC}" .
  FILTER(?date > "2015-01-01"^^xsd:date)
} ORDER BY DESC(?date) LIMIT 5`;

      const r1 = await sparqlQuery(q1);
      debug.push('L1 status: ' + r1.status + ', error: ' + (r1.error || 'none') + ', results: ' + (r1.body && r1.body.results ? r1.body.results.bindings.length : 0));

      if (r1.status === 200 && r1.body && r1.body.results && r1.body.results.bindings.length > 0) {
        const lastSale = r1.body.results.bindings[0];
        const price = parseInt(lastSale.amount.value);
        const year = lastSale.date.value.substring(0, 4);
        if (price > 10000) {
          baseEstimate = Math.round(price * growthMultiplier(year));
          level = 'property';
          debug.push('L1 found: price=' + price + ' year=' + year + ' estimate=' + baseEstimate);
        }
      }
    }

    // LEVEL 2: Full postcode
    const q2 = `PREFIX lrppi: <http://landregistry.data.gov.uk/def/ppi/>
PREFIX lrcommon: <http://landregistry.data.gov.uk/def/common/>
SELECT ?amount ?date ?paon ?street WHERE {
  ?t lrppi:pricePaid ?amount ; lrppi:transactionDate ?date ; lrppi:propertyAddress ?addr .
  ?addr lrcommon:postcode "${formattedPC}" ; lrcommon:paon ?paon ; lrcommon:street ?street .
  FILTER(?date > "2015-01-01"^^xsd:date)
} ORDER BY DESC(?date) LIMIT 25`;

    const r2 = await sparqlQuery(q2);
    debug.push('L2 status: ' + r2.status + ', error: ' + (r2.error || 'none') + ', results: ' + (r2.body && r2.body.results ? r2.body.results.bindings.length : 0));

    if (r2.status === 200 && r2.body && r2.body.results && r2.body.results.bindings.length > 0) {
      const prices = [];
      r2.body.results.bindings.forEach(b => {
        const price = parseInt(b.amount.value);
        if (price > 10000 && price < 10000000) {
          prices.push(price);
          recentSales.push({
            address: (b.paon ? b.paon.value + ' ' : '') + (b.street ? b.street.value : ''),
            amount: price,
            date: b.date ? b.date.value : null
          });
        }
      });
      if (prices.length > 0) {
        avgSalePrice = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
        salesCount = prices.length;
        if (level !== 'property') {
          baseEstimate = avgSalePrice;
          level = 'postcode';
        }
        debug.push('L2 found: ' + prices.length + ' prices, avg=' + avgSalePrice);
      }
    }

    // LEVEL 3: Outward code
    if (baseEstimate === 0) {
      const q3 = `PREFIX lrppi: <http://landregistry.data.gov.uk/def/ppi/>
PREFIX lrcommon: <http://landregistry.data.gov.uk/def/common/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?amount ?date ?paon ?street WHERE {
  ?t lrppi:pricePaid ?amount ; lrppi:transactionDate ?date ; lrppi:propertyAddress ?addr .
  ?addr lrcommon:postcode ?pc ; lrcommon:paon ?paon ; lrcommon:street ?street .
  FILTER(STRSTARTS(str(?pc), "${outward}"))
  FILTER(?date > "2021-01-01"^^xsd:date)
} ORDER BY DESC(?date) LIMIT 20`;

      const r3 = await sparqlQuery(q3);
      debug.push('L3 status: ' + r3.status + ', error: ' + (r3.error || 'none') + ', results: ' + (r3.body && r3.body.results ? r3.body.results.bindings.length : 0));

      if (r3.status === 200 && r3.body && r3.body.results && r3.body.results.bindings.length > 0) {
        const prices = [];
        r3.body.results.bindings.forEach(b => {
          const price = parseInt(b.amount.value);
          if (price > 10000 && price < 10000000) {
            prices.push(price);
            if (recentSales.length < 10) {
              recentSales.push({
                address: (b.paon ? b.paon.value + ' ' : '') + (b.street ? b.street.value : ''),
                amount: price,
                date: b.date ? b.date.value : null
              });
            }
          }
        });
        if (prices.length > 0) {
          avgSalePrice = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
          salesCount = prices.length;
          baseEstimate = avgSalePrice;
          level = 'area';
          debug.push('L3 found: ' + prices.length + ' prices, avg=' + avgSalePrice);
        }
      }
    }

    if (baseEstimate === 0) {
      baseEstimate = 350000;
      level = 'none';
      debug.push('All levels failed - using fallback');
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
        recentSales: recentSales.slice(0, 10),
        outward,
        debug
      })
    };

  } catch(err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server error', message: err.message, debug })
    };
  }
};
