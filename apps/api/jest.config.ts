import type { Config } from 'jest';

const common = {
  rootDir: '.',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@acc/contracts$': '<rootDir>/../../packages/contracts/src/index.ts',
    '^@acc/db$': '<rootDir>/../../packages/db/src/index.ts',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
} satisfies Partial<Config>;

const config: Config = {
  projects: [
    {
      ...common,
      displayName: 'unit',
      testMatch: ['<rootDir>/src/**/*.spec.ts'],
    },
    {
      ...common,
      displayName: 'integration',
      testMatch: ['<rootDir>/test/**/*.int-spec.ts'],
      setupFiles: ['<rootDir>/test/setup-env.ts'],
      testTimeout: 30_000,
    },
    {
      ...common,
      displayName: 'security',
      testMatch: ['<rootDir>/test/**/*.sec-spec.ts'],
      setupFiles: ['<rootDir>/test/setup-env.ts'],
      testTimeout: 30_000,
    },
  ],
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/**/index.ts'],
};

export default config;
