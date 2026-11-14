import { describe, expect, it } from 'vitest'
import { capitalize, slugify, truncate } from '../src/index'

describe('slugify', () => {
  it('lower-cases and joins words with a dash', () => {
    expect(slugify('Hello World')).toBe('hello-world')
  })

  it('turns accented letters into their base letter', () => {
    expect(slugify('Crème Brûlée')).toBe('creme-brulee')
    expect(slugify('Ünïcödé Tëxt')).toBe('unicode-text')
  })

  it('collapses runs of other characters into one separator', () => {
    expect(slugify('Hello,   World!!')).toBe('hello-world')
    expect(slugify('a -- b __ c')).toBe('a-b-c')
  })

  it('never starts or ends with the separator', () => {
    expect(slugify('  --Hello World--  ')).toBe('hello-world')
  })

  it('keeps digits', () => {
    expect(slugify('Top 10 Tips for 2024')).toBe('top-10-tips-for-2024')
  })

  it('uses a custom separator', () => {
    expect(slugify('Hello World', { separator: '_' })).toBe('hello_world')
    expect(slugify('Tom & Jerry', { separator: '_' })).toBe('tom_jerry')
  })

  it('treats an underscore in the input as a non-alphanumeric character', () => {
    expect(slugify('snake_case_name')).toBe('snake-case-name')
  })

  it('limits the length', () => {
    expect(slugify('hello wonderful world', { maxLength: 9 })).toBe('hello-won')
  })

  it('does not leave a trailing separator after cutting', () => {
    expect(slugify('hello world', { maxLength: 6 })).toBe('hello')
    expect(slugify('hello world', { maxLength: 5 })).toBe('hello')
  })

  it('leaves text shorter than maxLength alone', () => {
    expect(slugify('hello world', { maxLength: 50 })).toBe('hello-world')
  })

  it('returns an empty string when there is nothing to keep', () => {
    expect(slugify('')).toBe('')
    expect(slugify('!!! ???')).toBe('')
  })

  it('is exported from the package entry point alongside the existing helpers', () => {
    expect(typeof slugify).toBe('function')
    expect(capitalize('a')).toBe('A')
    expect(truncate('abc', 5)).toBe('abc')
  })
})
