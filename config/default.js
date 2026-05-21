module.exports = {
  // Server configuration
  server: {
    port: parseInt(process.env.PORT) || 80,
    host: process.env.HOST || '127.0.0.1'
  },

  // Browser configuration
  browsers: {
    // WebKit configuration
    webkit: {
      startPort: parseInt(process.env.WEBKIT_START_PORT) || 20000,
      enabled: process.env.WEBKIT_ENABLED !== 'false',
      ttl: parseInt(process.env.WEBKIT_TTL) || 6 * 60 * 1000,
      launchOptions: {
        headless: true,
        args: [
          '--disable-web-security',
          // 移除 VizDisplayCompositor 禁用，Mac Studio GPU 性能强大
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-field-trial-config',
          '--disable-ipc-flooding-protection',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          // 移除 --disable-dev-shm-usage，Mac Studio 内存充足
          // 移除 --disable-accelerated-2d-canvas，启用硬件加速
          // 移除 --disable-gpu，启用 GPU 加速
          '--no-first-run',
          '--no-zygote',
          // Mac Studio 优化参数
          '--enable-features=Metal',  // 启用 Metal API (macOS GPU 加速)
          '--use-angle=metal',        // 使用 Metal 作为 ANGLE 后端
          '--enable-gpu-rasterization', // 启用 GPU 光栅化
          '--enable-zero-copy',       // 启用零拷贝
          '--disable-software-rasterizer' // 禁用软件光栅化
        ]
      }
    },

    // Chrome configuration
    chrome: {
      startPort: parseInt(process.env.CHROME_START_PORT) || 30000,
      enabled: process.env.CHROME_ENABLED !== 'false',
      ttl: parseInt(process.env.WEBKIT_TTL) || 6 * 60 * 1000,
      launchOptions: {
        headless: true,
        args: [
          '--disable-web-security',
          // 移除 VizDisplayCompositor 禁用，Mac Studio GPU 性能强大
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-renderer-backgrounding',
          '--disable-field-trial-config',
          '--disable-ipc-flooding-protection',
          '--no-sandbox',
          '--disable-setuid-sandbox',
          // 移除 --disable-dev-shm-usage，Mac Studio 内存充足
          // 移除 --disable-accelerated-2d-canvas，启用硬件加速
          // 移除 --disable-gpu，启用 GPU 加速
          '--no-first-run',
          '--no-zygote',
          '--disable-extensions',
          '--disable-default-apps',
          // Mac Studio 优化参数
          '--enable-features=Metal',  // 启用 Metal API (macOS GPU 加速)
          '--use-angle=metal',        // 使用 Metal 作为 ANGLE 后端
          '--enable-gpu-rasterization', // 启用 GPU 光栅化
          '--enable-zero-copy',       // 启用零拷贝
          '--disable-software-rasterizer', // 禁用软件光栅化
          '--force-color-profile=srgb', // 强制使用 sRGB 色彩配置
          '--enable-accelerated-video-decode' // 启用硬件视频解码
        ]
      }
    }
  },

  // Proxy configuration
  proxy: {
    timeout: 30000,
    proxyTimeout: 30000,
    changeOrigin: true
  },

  // Cleanup configuration
  cleanup: {
    interval: parseInt(process.env.CLEANUP_INTERVAL) || 5 * 60 * 1000, // 5 minutes
    enabled: process.env.CLEANUP_ENABLED !== 'false'
  },

  // Local browser proxy configuration
  localBrowserProxy: {
    baseUrl: process.env.LOCAL_BROWSER_PROXY_URL,
    apiKey: process.env.LOCAL_BROWSER_PROXY_API_KEY,
    ttl: 6 * 60 * 1000
  }
};
