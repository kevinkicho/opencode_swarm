import { describe, expect, it } from 'vitest';
import { priceFor, tokensForBudget, withPricing } from '../pricing';
import type { ModelRef } from '../../swarm-types';

// Pricing math powers the budget cap in the routing modal + the topbar
// cost chip. Drift means cost-cap rejects fire at wrong threshold OR
// the displayed-tokens-budget chip lies by orders of magnitude.

describe('priceFor — model name → price lookup', () => {
  it('returns undefined for missing model id', () => {
    expect(priceFor(undefined)).toBeUndefined();
    expect(priceFor('')).toBeUndefined();
  });

  it('returns undefined for unknown models (free / go-subscription)', () => {
    expect(priceFor('unknown-model-xyz')).toBeUndefined();
    expect(priceFor('opencode-go/glm-5.1')).toBeDefined();
    // ↑ matches glm-5-1 pattern; even with opencode-go/ prefix, the
    // lookup is regex-based on the model name.
  });

  it('matches glm-5.1 variants', () => {
    expect(priceFor('glm-5.1:cloud')).toBeDefined();
    expect(priceFor('glm5.1')).toBeDefined();
    expect(priceFor('GLM-5-1')).toBeDefined(); // case-insensitive
  });

  it('matches gpt-5 family', () => {
    expect(priceFor('gpt-5')).toBeDefined();
    expect(priceFor('gpt-5-nano')).toBeDefined();
  });

  it('matches qwen / minimax / kimi pattern variants', () => {
    expect(priceFor('qwen-3.5')).toBeDefined();
    expect(priceFor('minimax-m2-5')).toBeDefined();
    expect(priceFor('kimi-k2-5')).toBeDefined();
  });
});

describe('tokensForBudget', () => {
  it('returns undefined when model has no price', () => {
    expect(tokensForBudget(5, 'unknown-model')).toBeUndefined();
    expect(tokensForBudget(5, undefined)).toBeUndefined();
  });

  it('calculates output tokens budget for a known model', () => {
    // Test with a model that has a non-zero output price.
    const tokens = tokensForBudget(5, 'glm-5.1');
    expect(tokens).toBeDefined();
    expect(tokens).toBeGreaterThan(0);
  });

  it('higher budget yields more tokens (linear)', () => {
    const t1 = tokensForBudget(1, 'glm-5.1') ?? 0;
    const t10 = tokensForBudget(10, 'glm-5.1') ?? 0;
    expect(t10).toBeGreaterThanOrEqual(t1 * 9); // ~10x within rounding
  });

  it('returns rounded integer', () => {
    const tokens = tokensForBudget(1, 'glm-5.1');
    expect(Number.isInteger(tokens)).toBe(true);
  });
});

describe('withPricing — overlays pricing on a ModelRef', () => {
  it('returns original ref when model is unknown', () => {
    const ref: ModelRef = { id: 'unknown-x', label: 'unknown-x' };
    expect(withPricing(ref)).toBe(ref);
  });

  it('overlays pricing.input + pricing.output for known models', () => {
    const ref: ModelRef = { id: 'glm-5.1', label: 'glm-5.1' };
    const out = withPricing(ref);
    expect(out.pricing).toBeDefined();
    expect(typeof out.pricing?.input).toBe('number');
    expect(typeof out.pricing?.output).toBe('number');
  });

  it('preserves original fields when overlaying', () => {
    const ref: ModelRef = { id: 'glm-5.1', label: 'GLM 5.1' };
    const out = withPricing(ref);
    expect(out.id).toBe('glm-5.1');
    expect(out.label).toBe('GLM 5.1');
  });
});
