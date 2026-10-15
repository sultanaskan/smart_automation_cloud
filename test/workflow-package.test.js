'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { unzipSync, zipSync, strFromU8, strToU8 } = require('fflate');
const { sanitizeWorkflowPackage } = require('../src/workflow-package');

function packageFile(workflow, extras = {}) {
  return Buffer.from(zipSync({
    'workflow.json': strToU8(JSON.stringify({ kind: 'smart-automation-workflow', workflow, ...extras })),
    'uploads/credential.pdf': strToU8('local private data')
  }));
}

test('published package keeps definition and recorded options but removes batch inputs and assets', () => {
  const source = packageFile({
    name: 'Flight check-in', description: 'Record a passenger check-in workflow', actions: [{ type: 'SELECT', optionListId: 'saved-list-01' }],
    selectorOptions: [{ id: 'saved-list-01', options: [{ text: 'Window', value: 'W' }, { text: 'Aisle', value: 'A' }] }]
  }, { batchItems: [{ passport: 'LOCAL-SECRET' }], assets: [{ path: 'uploads/credential.pdf' }] });
  const result = sanitizeWorkflowPackage(source, { description: 'Published description' });
  const parsed = JSON.parse(strFromU8(unzipSync(new Uint8Array(result.bytes))['workflow.json']));
  assert.equal(result.name, 'Flight check-in');
  assert.equal(result.description, 'Published description');
  assert.deepEqual(parsed.batchItems, []);
  assert.deepEqual(parsed.assets, []);
  assert.deepEqual(parsed.workflow.selectorOptions[0].options.map(item => item.text), ['Window', 'Aisle']);
  assert.deepEqual(Object.keys(unzipSync(new Uint8Array(result.bytes))), ['workflow.json']);
  assert.equal(strFromU8(unzipSync(new Uint8Array(result.bytes))['workflow.json']).includes('LOCAL-SECRET'), false);
});

test('invalid, unsupported, missing, and oversized workflow definitions are rejected', () => {
  assert.throws(() => sanitizeWorkflowPackage(Buffer.from('not a zip')));
  const missing = Buffer.from(zipSync({ 'other.json': strToU8('{}') }));
  assert.throws(() => sanitizeWorkflowPackage(missing), /not a Smart Automation workflow/);
  const wrongKind = Buffer.from(zipSync({ 'workflow.json': strToU8(JSON.stringify({ kind: 'other', workflow: { actions: [] } })) }));
  assert.throws(() => sanitizeWorkflowPackage(wrongKind), /invalid or unsupported/);
});

test('server sets its own published name and never includes non-definition files', () => {
  const result = sanitizeWorkflowPackage(packageFile({ name: 'Private local name', actions: [] }), { name: 'Marketplace title' });
  const files = unzipSync(new Uint8Array(result.bytes));
  const parsed = JSON.parse(strFromU8(files['workflow.json']));
  assert.equal(parsed.workflow.name, 'Marketplace title');
  assert.deepEqual(Object.keys(files), ['workflow.json']);
});
