const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.cjs',
  workers: 1,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    launchOptions: process.env.BRACE_TEST_CHROMIUM
      ? { executablePath: process.env.BRACE_TEST_CHROMIUM }
      : {},
  },
});
