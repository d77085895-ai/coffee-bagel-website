const https = require('https');

const API_KEY = process.env.MAILCHIMP_API_KEY;
const AUDIENCE_ID = process.env.MAILCHIMP_AUDIENCE_ID;
const DC = (process.env.MAILCHIMP_API_KEY || '').split('-')[1] || 'us13';

function mcRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : '';
    const options = {
      hostname: DC + '.api.mailchimp.com',
      path: '/3.0' + path,
      method: method,
      headers: {
        'Authorization': 'Basic ' + Buffer.from('anystring:' + API_KEY).toString('base64'),
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 10000
    };
    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(responseData) });
        } catch(e) {
          resolve({ status: res.statusCode, body: null });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (data) req.write(data);
    req.end();
  });
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
    const body = JSON.parse(event.body || '{}');
    const { email, firstName, lastName, interest, source, optSMS } = body;

    if (!email) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email required' }) };
    }

    // Build tags based on source and interest
    const tags = [];
    if (source) tags.push(source);
    if (interest) tags.push(interest);
    if (optSMS) tags.push('SMS Opt-in');

    // Add/update member in Mailchimp
    const memberData = {
      email_address: email,
      status_if_new: 'subscribed',
      status: 'subscribed',
      merge_fields: {
        FNAME: firstName || '',
        LNAME: lastName || ''
      },
      tags: tags
    };

    // Use MD5 hash of email for the member ID
    const crypto = require('crypto');
    const emailHash = crypto.createHash('md5').update(email.toLowerCase()).digest('hex');

    const result = await mcRequest('PUT', '/lists/' + AUDIENCE_ID + '/members/' + emailHash, memberData);

    if (result.status === 200 || result.status === 201) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, message: 'Successfully subscribed' })
      };
    } else {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: result.body && result.body.detail ? result.body.detail : 'Subscription failed' })
      };
    }

  } catch(err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Server error', message: err.message })
    };
  }
};
