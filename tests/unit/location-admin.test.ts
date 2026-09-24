import { describe, expect, it } from 'vitest';
import { resolveTownContext, townFilter } from '../../src/lib/location';
import { writeFailure, humanError } from '../../src/lib/admin';
import type { Town } from '../../src/lib/types';

const town = (slug: string, name: string): Town => ({
  id: slug, slug, name, state_code: 'OH', latitude: null, longitude: null, seo_title: null, seo_description: null,
});
const towns = [town('carrollton', 'Carrollton'), town('malvern', 'Malvern')];
const cookies = (value?: string) => ({ get: () => (value === undefined ? undefined : { value }) }) as any;
const url = (path: string) => new URL(`https://yourpocketperks.com${path}`);

describe('which town a visitor is viewing', () => {
  it('asks a first-time visitor to choose when there are several towns', () => {
    const ctx = resolveTownContext(url('/'), cookies(), towns);
    expect(ctx.isDefault).toBe(true);
  });
  it('never asks when there is only one town', () => {
    const ctx = resolveTownContext(url('/'), cookies(), [towns[0]!]);
    expect(ctx.isDefault).toBe(false);
    expect(ctx.town?.slug).toBe('carrollton');
  });
  it('remembers a chosen town', () => {
    const ctx = resolveTownContext(url('/'), cookies('malvern'), towns);
    expect(ctx.isDefault).toBe(false);
    expect(townFilter(ctx)).toBe('malvern');
  });
  it('remembers "every town" as a choice too', () => {
    const ctx = resolveTownContext(url('/'), cookies('all'), towns);
    expect(ctx.showingAll).toBe(true);
    expect(ctx.isDefault).toBe(false);
    expect(townFilter(ctx)).toBeUndefined();
  });
  it('lets a shared link win over the cookie', () => {
    expect(townFilter(resolveTownContext(url('/deals?town=carrollton'), cookies('malvern'), towns))).toBe('carrollton');
    expect(townFilter(resolveTownContext(url('/'), cookies('malvern'), towns, 'carrollton'))).toBe('carrollton');
  });
  it('ignores a cookie naming a town that no longer exists', () => {
    expect(resolveTownContext(url('/'), cookies('atlantis'), towns).isDefault).toBe(true);
  });
});

describe('admin saves report failure honestly', () => {
  it('treats an update that changed no rows as a failure, not "Saved"', () => {
    expect(writeFailure({ error: null, data: [] })).toMatch(/Nothing was saved/);
    expect(writeFailure({ error: null, data: null })).toMatch(/Nothing was saved/);
  });
  it('passes a real success', () => {
    expect(writeFailure({ error: null, data: [{ id: 'x' }] })).toBeNull();
    expect(writeFailure({ error: null, data: { id: 'x' } })).toBeNull();
    expect(writeFailure({ error: null, data: [] }, false)).toBeNull();
  });
  it('turns database constraint names into instructions', () => {
    expect(humanError({ message: 'violates check constraint "merchants_website_url"' })).toMatch(/https:\/\//);
    expect(humanError({ message: 'violates check constraint "deals_restrictions_len"' })).toMatch(/120/);
    expect(humanError({ code: '23505', message: 'dup' })).toMatch(/already exists/);
  });
  it('passes through the plan-limit message written for people', () => {
    const message = 'Crossroads Pizza is on the standard plan, which includes 2 active deal(s). Pause an existing deal or upgrade the plan.';
    expect(humanError({ code: 'P0001', message })).toBe(message);
  });
  it('never leaks unknown database text', () => {
    expect(humanError({ message: 'relation "secret_table" does not exist' })).not.toContain('secret_table');
  });
});
