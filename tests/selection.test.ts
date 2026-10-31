import test from 'node:test';
import assert from 'node:assert/strict';
import { selectionKind } from '../src/model';

test('single words, complete short sentences and passages use distinct explanation scopes', () => {
  for (const value of ['dominant', 'hello', 'self-attention', "isn’t", '  wonderful  ']) assert.equal(selectionKind(value), 'word', value);
  for (const value of ['I am tired', 'Time flies', 'Go home.', 'Are you ready?', 'end up', 'I was tired, but I went out.']) assert.equal(selectionKind(value), 'sentence', value);
  assert.equal(selectionKind('I was tired. I went home.'), 'passage');
  assert.equal(selectionKind('First paragraph\n\nSecond paragraph'), 'passage');
});
