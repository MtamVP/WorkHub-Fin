// Enterprise-readiness mục 4. environment: 'node' vì lib/pure-helpers.js không đụng DOM --
// không cần jsdom. tests/unit chạy trong CI (npm test); tests/rls chỉ chạy tay
// (npm run test:rls, cần WORKHUB_TEST_DB_URL cục bộ), không nằm trong "npm test".
// .mjs (không phải .js) để scripts/check-syntax.mjs (node --check kiểu CommonJS mặc định
// vì package.json "type":"commonjs") không báo lỗi cú pháp trên "export default".
export default {
  test: {
    environment: 'node',
  },
};
