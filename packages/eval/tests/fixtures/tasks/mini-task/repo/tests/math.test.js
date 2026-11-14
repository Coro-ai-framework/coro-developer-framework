'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { mul } = require('../src/math')

test('mul multiplies', () => {
  assert.strictEqual(mul(3, 4), 12)
})
