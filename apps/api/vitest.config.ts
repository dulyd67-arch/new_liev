export default {
  test: {
    include: ['test/**/*.spec.ts'],
    environment: 'node',
    testTimeout: 10_000,
    restoreMocks: true,
  },
};
