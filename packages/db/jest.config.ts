import type { Config } from 'jest';

const common = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  moduleNameMapper: {
    '^@acc/contracts$': '<rootDir>/../contracts/src/index.ts',
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
      testMatch: ['<rootDir>/src/**/*.spec.ts', '!<rootDir>/src/test/**'],
    },
    {
      ...common,
      displayName: 'integration',
      testMatch: ['<rootDir>/src/test/**/*.int-spec.ts'],
      setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts'],
      testTimeout: 30_000,
    },
  ],
};

export default config;
