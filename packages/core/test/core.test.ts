import { describe, expect, it } from 'vitest';

import { CORE_VERSION } from '../src/index';

describe('core 骨架自检', () => {
  it('CORE_VERSION 为合法 semver', () => {
    expect(CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});