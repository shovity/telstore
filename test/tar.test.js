import test from 'node:test'
import assert from 'node:assert/strict'

import { archiveName, isGzipName } from '../src/tar.js'

test('a name that already claims gzip is left exactly as it is', () => {
  assert.equal(archiveName('a.tar.gz'), 'a.tar.gz')
  assert.equal(archiveName('a.tgz'), 'a.tgz')
  assert.equal(archiveName('./backups/march.tar.gz'), './backups/march.tar.gz')
})

// Upper case is a name someone typed, not a different intention. A.TAR.tar.gz would be
// telstore being clever at the expense of the person reading `list` later.
test('the suffix check ignores case, and what it appends is lower case', () => {
  assert.equal(archiveName('A.TGZ'), 'A.TGZ')
  assert.equal(archiveName('A.TAR'), 'A.TAR.gz')
})

test('a plain tar name gains only the .gz it was missing', () => {
  assert.equal(archiveName('a.tar'), 'a.tar.gz')
})

test('anything else gains the whole suffix', () => {
  assert.equal(archiveName('a'), 'a.tar.gz')
  assert.equal(archiveName('march'), 'march.tar.gz')
  // .zip is not tar's business and telstore does not argue with the name it was given
  // beyond making it honest about the gzip.
  assert.equal(archiveName('a.zip'), 'a.zip.tar.gz')
})

test('isGzipName answers for the same spellings archiveName accepts', () => {
  assert.ok(isGzipName('a.tar.gz'))
  assert.ok(isGzipName('a.tgz'))
  assert.ok(isGzipName('A.TAR.GZ'))
  assert.ok(!isGzipName('a.tar'))
  assert.ok(!isGzipName('a'))
})
