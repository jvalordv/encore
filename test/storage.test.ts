/**
 * Unit tests for the key-value stores: the memory store's basic contract and
 * the localStorage store's prefixing and its fallback to memory when storage
 * is missing or throws. A fake Storage stands in for the browser's.
 */
import { describe, expect, it } from 'vitest';
import { localStorageStore, memoryStore } from '../src/app/storage';
import type { StorageLike } from '../src/app/storage';

/** Map-backed Storage whose methods can be told to throw. */
function fakeStorage(): StorageLike & { data: Map<string, string>; broken: boolean } {
  const data = new Map<string, string>();
  const fake = {
    data,
    broken: false,
    getItem(key: string) {
      if (fake.broken) throw new Error('blocked');
      return data.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (fake.broken) throw new Error('quota');
      data.set(key, value);
    },
    removeItem(key: string) {
      if (fake.broken) throw new Error('blocked');
      data.delete(key);
    },
  };
  return fake;
}

describe('memoryStore', () => {
  it('returns null for missing keys and round-trips values', () => {
    const store = memoryStore();
    expect(store.get('a')).toBeNull();
    store.set('a', '1');
    expect(store.get('a')).toBe('1');
    store.set('a', '2');
    expect(store.get('a')).toBe('2');
    store.remove('a');
    expect(store.get('a')).toBeNull();
  });

  it('keeps stores independent', () => {
    const [one, two] = [memoryStore(), memoryStore()];
    one.set('k', 'v');
    expect(two.get('k')).toBeNull();
  });
});

describe('localStorageStore', () => {
  it('prefixes keys in the underlying storage', () => {
    const fake = fakeStorage();
    const store = localStorageStore('encore.', () => fake);
    store.set('skin', 'arcade');
    expect(fake.data.get('encore.skin')).toBe('arcade');
    expect(store.get('skin')).toBe('arcade');
    store.remove('skin');
    expect(fake.data.size).toBe(0);
    expect(store.get('skin')).toBeNull();
  });

  it('defaults to the encore. prefix', () => {
    const fake = fakeStorage();
    localStorageStore(undefined, () => fake).set('skin', 'studio');
    expect(fake.data.get('encore.skin')).toBe('studio');
  });

  it('works as a memory store when storage is unavailable', () => {
    const store = localStorageStore('x.', () => null);
    expect(store.get('a')).toBeNull();
    store.set('a', '1');
    expect(store.get('a')).toBe('1');
    store.remove('a');
    expect(store.get('a')).toBeNull();
  });

  it('survives storage that throws on every call', () => {
    const fake = fakeStorage();
    fake.broken = true;
    const store = localStorageStore('x.', () => fake);
    expect(store.get('a')).toBeNull();
    expect(() => store.set('a', '1')).not.toThrow();
    expect(store.get('a')).toBe('1');
    expect(() => store.remove('a')).not.toThrow();
    expect(store.get('a')).toBeNull();
  });

  it('survives a storage accessor that throws', () => {
    const store = localStorageStore('x.', () => {
      throw new Error('SecurityError');
    });
    expect(() => store.set('a', '1')).not.toThrow();
    expect(store.get('a')).toBe('1');
  });

  it('prefers the last value set over an older persisted one', () => {
    const fake = fakeStorage();
    const store = localStorageStore('x.', () => fake);
    store.set('a', 'old');
    fake.broken = true;
    store.set('a', 'new');
    expect(store.get('a')).toBe('new');
    store.remove('a');
    expect(store.get('a')).toBeNull();
    fake.broken = false;
    // The delete never reached storage, so the tombstone still hides 'old'.
    expect(store.get('a')).toBeNull();
    store.set('a', 'again');
    expect(fake.data.get('x.a')).toBe('again');
    expect(store.get('a')).toBe('again');
  });
});
