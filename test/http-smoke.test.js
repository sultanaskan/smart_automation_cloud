'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../src/server');

test('cloud health endpoint and portal shell are served by Express', async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok', service: 'smart-automation-cloud', runtime: 'node' });

    const portal = await fetch(`${base}/admin`);
    assert.equal(portal.status, 200);
    assert.match(portal.headers.get('content-type'), /text\/html/);
    assert.match(await portal.text(), /Admin console/);

    const unknown = await fetch(`${base}/api/not-a-route`);
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { error: 'API route was not found.' });

    const denied = await fetch(`${base}/api/workflows`);
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { error: 'Please sign in.' });

    const publicRegistration = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'member', password: 'A-strong-password-2026' })
    });
    assert.equal(publicRegistration.status, 404);
    assert.deepEqual(await publicRegistration.json(), { error: 'API route was not found.' });
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
