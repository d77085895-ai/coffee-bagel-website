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
        'Accept': 'application/sparql-results+json,application/json',
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Cache-Control': 'no-cache'
      },
      timeout: 20000
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch(e) {
          resolve({ status: res.statusCode, body: null, raw: data.substring(0, 300) });
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
  // Use real UK house price growth by period
  // 2000-2007: ~10%/yr, 2007-2012: flat/decline, 2012-2016: ~5%/yr
  // 2016-2021: ~3%/yr, 2021-2023: ~8%/yr, 2023-2025: ~2%/yr
  const growthByYear = {
    2000:0.10, 2001:0.10, 2002:0.10, 2003:0.10, 2004:0.10,
    2005:0.05, 2006:0.08, 2007:0.10, 2008:-0.05, 2009:-0.02,
    2010:0.03, 2011:0.01, 2012:0.02, 2013:0.05, 2014:0.07,
    2015:0.06, 2016:0.04, 2017:0.03, 2018:0.02, 2019:0.02,
    2020:0.05, 2021:0.10, 2022:0.08, 2023:0.02, 2024:0.02
  };
  let multiplier = 1.0;
  const startYear = parseInt(soldYear);
  const endYear = new Date().getFullYear();
  for (let y = startYear; y < endYear; y++) {
    const growth = growthByYear[y] !== undefined ? growthByYear[y] : 0.03;
    multiplier *= (1 + growth);
  }
  return multiplier;
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
    debug.push('PC: ' + formattedPC + ' House: ' + house);

    let level = 'none';
    let baseEstimate = 0;
    let recentSales = [];
    let salesCount = 0;
    let avgSalePrice = 0;

    // LEVEL 1: Specific property - any date, apply growth multiplier
    if (house) {
      const q1 = `PREFIX lrppi: <http://landregistry.data.gov.uk/def/ppi/>
PREFIX lrcommon: <http://landregistry.data.gov.uk/def/common/>
SELECT ?amount ?date WHERE {
  ?t lrppi:pricePaid ?amount ; lrppi:transactionDate ?date ; lrppi:propertyAddress ?addr .
  ?addr lrcommon:paon "${house}" ; lrcommon:postcode "${formattedPC}" .
} ORDER BY DESC(?date) LIMIT 1`;

      const r1 = await sparqlQuery(q1);
      debug.push('L1: status=' + r1.status + ' results=' + (r1.body && r1.body.results ? r1.body.results.bindings.length : 0) + (r1.error ? ' err=' + r1.error : '') + (r1.raw ? ' raw=' + r1.raw.substring(0,50) : ''));

      if (r1.status === 200 && r1.body && r1.body.results && r1.body.results.bindings.length > 0) {
        const sale = r1.body.results.bindings[0];
        const price = parseInt(sale.amount.value);
        const year = sale.date.value.substring(0, 4);
        if (price > 10000) {
          baseEstimate = Math.round(price * growthMultiplier(year));
          level = 'property';
          debug.push('L1 found: ' + price + ' in ' + year + ' -> ' + baseEstimate);
        }
      }
    }

    // LEVEL 2: All sales in this postcode - NO date filter, apply growth to each
    const q2 = `PREFIX lrppi: <http://landregistry.data.gov.uk/def/ppi/>
PREFIX lrcommon: <http://landregistry.data.gov.uk/def/common/>
SELECT ?amount ?date ?paon ?street WHERE {
  ?t lrppi:pricePaid ?amount ; lrppi:transactionDate ?date ; lrppi:propertyAddress ?addr .
  ?addr lrcommon:postcode "${formattedPC}" ; lrcommon:paon ?paon ; lrcommon:street ?street .
} ORDER BY DESC(?date) LIMIT 30`;

    const r2 = await sparqlQuery(q2);
    debug.push('L2: status=' + r2.status + ' results=' + (r2.body && r2.body.results ? r2.body.results.bindings.length : 0) + (r2.error ? ' err=' + r2.error : '') + (r2.raw ? ' raw=' + r2.raw.substring(0,50) : ''));

    if (r2.status === 200 && r2.body && r2.body.results && r2.body.results.bindings.length > 0) {
      const adjustedPrices = [];
      r2.body.results.bindings.forEach(b => {
        const price = parseInt(b.amount.value);
        const year = b.date && b.date.value ? b.date.value.substring(0, 4) : '2018';
        if (price > 10000 && price < 10000000) {
          // Apply growth multiplier to bring historical prices to today
          const todayPrice = Math.round(price * growthMultiplier(year));
          adjustedPrices.push(todayPrice);
          // Only show recent sales (last 5 years) in the table
          const saleYear = parseInt(year);
          if (saleYear >= 2018) {
            recentSales.push({
              address: (b.paon ? b.paon.value + ' ' : '') + (b.street ? b.street.value : ''),
              amount: price,
              date: b.date ? b.date.value : null
            });
          }
        }
      });
      if (adjustedPrices.length > 0) {
        // Use median instead of average to reduce outlier impact
        adjustedPrices.sort((a, b) => a - b);
        const mid = Math.floor(adjustedPrices.length / 2);
        const median = adjustedPrices.length % 2 === 0
          ? Math.round((adjustedPrices[mid-1] + adjustedPrices[mid]) / 2)
          : adjustedPrices[mid];
        avgSalePrice = median;
        salesCount = adjustedPrices.length;
        if (level !== 'property') {
          baseEstimate = median;
          level = 'postcode';
        }
        debug.push('L2: ' + adjustedPrices.length + ' prices, median=' + median);
      }
    }

    // LEVEL 3: Outward code, recent sales only
    if (baseEstimate === 0) {
      const q3 = `PREFIX lrppi: <http://landregistry.data.gov.uk/def/ppi/>
PREFIX lrcommon: <http://landregistry.data.gov.uk/def/common/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?amount ?date ?paon ?street WHERE {
  ?t lrppi:pricePaid ?amount ; lrppi:transactionDate ?date ; lrppi:propertyAddress ?addr .
  ?addr lrcommon:postcode ?pc ; lrcommon:paon ?paon ; lrcommon:street ?street .
  FILTER(STRSTARTS(str(?pc), "${outward}"))
  FILTER(?date > "2020-01-01"^^xsd:date)
} ORDER BY DESC(?date) LIMIT 25`;

      const r3 = await sparqlQuery(q3);
      debug.push('L3: status=' + r3.status + ' results=' + (r3.body && r3.body.results ? r3.body.results.bindings.length : 0) + (r3.error ? ' err=' + r3.error : '') + (r3.raw ? ' raw=' + r3.raw.substring(0,50) : ''));

      if (r3.status === 200 && r3.body && r3.body.results && r3.body.results.bindings.length > 0) {
        const prices = [];
        r3.body.results.bindings.forEach(b => {
          const price = parseInt(b.amount.value);
          const year = b.date && b.date.value ? b.date.value.substring(0, 4) : '2022';
          if (price > 10000 && price < 10000000) {
            prices.push(Math.round(price * growthMultiplier(year)));
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
          prices.sort((a, b) => a - b);
          const mid = Math.floor(prices.length / 2);
          const median = prices.length % 2 === 0
            ? Math.round((prices[mid-1] + prices[mid]) / 2)
            : prices[mid];
          avgSalePrice = median;
          salesCount = prices.length;
          baseEstimate = median;
          level = 'area';
          debug.push('L3: ' + prices.length + ' prices, median=' + median);
        }
      }
    }

    if (baseEstimate === 0) {
      baseEstimate = 380000;
      level = 'none';
      debug.push('All failed - fallback');
    }

    const margin = level === 'property' ? 0.06 : level === 'postcode' ? 0.08 : 0.12;

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
