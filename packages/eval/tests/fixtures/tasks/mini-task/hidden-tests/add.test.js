'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { add } = require('../src/math')

test('add adds', () => {
  assert.strictEqual(add(2, 3), 5)
})

test('add handles negatives', () => {
  assert.strictEqual(add(-1, 1), 0)
})
