const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 60000,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:8000', browserName: 'chromium' },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
    { name: 'firefox', grep: /@antialias/, use: { browserName: 'firefox' } },
    { name: 'webkit', grep: /@antialias|@phone/, use: { browserName: 'webkit' } },
  ],
  webServer: {
    command: 'python3 -m http.server 8000 --bind 127.0.0.1',
    url: 'http://127.0.0.1:8000',
    reuseExistingServer: false,
  },
});
