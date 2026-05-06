import { describe, expect, it } from 'vitest';
import { extractJSON } from '../json/extract-json';

describe('extractJSON', () => {
  it('parses valid JSON directly', () => {
    expect(extractJSON('{"foo": 1}')).toEqual({ foo: 1 });
  });

  it('parses a JSON array', () => {
    expect(extractJSON('[1, 2, 3]')).toEqual([1, 2, 3]);
  });

  it('strips ```json fences', () => {
    const text = '```json\n{"bar": 2}\n```';
    expect(extractJSON(text)).toEqual({ bar: 2 });
  });

  it('strips generic ``` fences', () => {
    const text = '```\n[3, 4]\n```';
    expect(extractJSON(text)).toEqual([3, 4]);
  });

  it('extracts JSON from prose', () => {
    const text = 'Here is the data:\n{"key": "val"}\nAnd some trailing text.';
    expect(extractJSON(text)).toEqual({ key: 'val' });
  });

  it('repairs trailing commas in objects', () => {
    const text = '{"a": 1, "b": 2,}';
    expect(extractJSON(text)).toEqual({ a: 1, b: 2 });
  });

  it('repairs trailing commas in arrays', () => {
    const text = '[1, 2, 3,]';
    expect(extractJSON(text)).toEqual([1, 2, 3]);
  });

  it('repairs trailing commas in fenced blocks', () => {
    const text = '```json\n{"x": 10,}\n```';
    expect(extractJSON(text)).toEqual({ x: 10 });
  });

  it('returns null for non-JSON text', () => {
    expect(extractJSON('hello world')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractJSON('')).toBeNull();
  });

  it('handles nested brackets in strings', () => {
    const obj = { pattern: 'a { b } c' };
    expect(extractJSON(JSON.stringify(obj))).toEqual(obj);
  });

  it('finds JSON after leading whitespace', () => {
    expect(extractJSON('   \n  {"z": 9}')).toEqual({ z: 9 });
  });
});