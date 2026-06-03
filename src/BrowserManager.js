const { webkit, chromium } = require('playwright');
const config = require('../config/default');
const dbg = require('debug');

const debug = dbg('debug:browser-manager');
const info = dbg('info:browser-manager');

class BrowserManager {
  constructor() {
    this.servers = new Map(); // Map<string, ServerInfo>
    this.nextServerIndex = 0;
    this.cleanupInterval = null;

    // Start cleanup process
    if (config.cleanup.enabled) {
      this.startCleanupProcess();
    }
  }

  /**
   * Get or create a browser server
   * @param {string} browserType - 'webkit' or 'chrome'
   * @param {number} serverIndex - Optional server index, if not provided, will use next available
   * @returns {Promise<Object>} Server info object
   */
  async getOrCreateServer(browserType, serverIndex = null, options = {}) {
    if (!config.browsers[browserType] || !config.browsers[browserType].enabled) {
      throw new Error(`Browser type ${browserType} is not enabled`);
    }

    // 没有指定 index 时，自动选下一个可用的
    if (serverIndex === null) {
      serverIndex = this.getNextServerIndex(browserType);
    }

    const serverKey = `${browserType}-${serverIndex}`;

    // 检查 server 是否已存在
    if (this.servers.has(serverKey)) {
      const serverInfo = this.servers.get(serverKey);
      const incomingProxy = options.proxyString || null;
      const proxyChanged = serverInfo.proxyString !== incomingProxy;

      // TTL 未过期且 proxy 没变，直接复用
      if (this.isServerValid(serverInfo) && !proxyChanged) {
        debug(`♻️  Reusing existing ${browserType} server ${serverIndex} on port ${serverInfo.port}`);
        return serverInfo;
      }

      // proxy 变了或者过期了，先销毁再重建
      if (proxyChanged) {
        debug(`🔄 Proxy changed for ${serverKey}, rebuilding server`);
      }
      await this.cleanupServer(serverKey);
    }

    // 创建新 server
    return await this.createServer(browserType, serverIndex, options);
  }

  /**
   * Create a new browser server
   * @param {string} browserType - 'webkit' or 'chrome'
   * @param {number} serverIndex - Server index
   * @returns {Promise<Object>} Server info object
   */
  async createServer(browserType, serverIndex, options = {}) {
    const browserConfig = config.browsers[browserType];
    const port = browserConfig.startPort + serverIndex;
    const serverKey = `${browserType}-${serverIndex}`;

    try {
      info(`🔄 Creating ${browserType} server ${serverIndex} on port ${port}...`);

      let browser;
      if (browserType === 'webkit') {
        browser = webkit;
      } else if (browserType === 'chrome') {
        browser = chromium;
      } else {
        throw new Error(`Unsupported browser type: ${browserType}`);
      }

      // 构建启动参数，不修改全局 config 对象
      const launchOptions = { ...browserConfig.launchOptions };

      // Chrome 且传入了 proxyString 时，解析并注入 proxy 配置
      const proxyString = options.proxyString || null;
      if (browserType === 'chrome' && proxyString) {
        const proxyUrl = new URL(proxyString);
        launchOptions.proxy = {
          server: `${proxyUrl.protocol}//${proxyUrl.host}`
        };
        // 如果 proxy 带有认证信息，单独提取（Playwright proxy 选项原生支持）
        if (proxyUrl.username) {
          launchOptions.proxy.username = decodeURIComponent(proxyUrl.username);
          launchOptions.proxy.password = decodeURIComponent(proxyUrl.password);
        }
        info(`   Proxy: ${proxyUrl.protocol}//${proxyUrl.host}`);
      }

      const server = await browser.launchServer({
        port: port,
        host: '0.0.0.0',
        wsPath: `/${browserType}-${serverIndex}`,
        ...launchOptions
      });

      const serverInfo = {
        type: browserType,
        index: serverIndex,
        port: port,
        server: server,
        wsPath: `/${browserType}-${serverIndex}`,
        proxyString: proxyString,
        createdAt: Date.now(),
        lastAccessedAt: Date.now()
      };

      this.servers.set(serverKey, serverInfo);

      info(`✅ ${browserType} server ${serverIndex} started on port ${port}`);
      info(`   WebSocket path: /${browserType}-${serverIndex}`);

      return serverInfo;

    } catch (error) {
      debug(`❌ Failed to start ${browserType} server ${serverIndex} on port ${port}:`, error.message);
      throw error;
    }
  }

  /**
   * Get next available server index for a browser type
   * @param {string} browserType - Browser type
   * @returns {number} Next server index
   */
  getNextServerIndex(browserType) {
    let index = 0;
    while (this.servers.has(`${browserType}-${index}`)) {
      index++;
    }
    return index;
  }

  /**
   * Check if server is still valid (not expired)
   * @param {Object} serverInfo - Server info object
   * @returns {boolean} True if server is valid
   */
  isServerValid(serverInfo) {
    const now = Date.now();
    const ttl = config.browsers[serverInfo.type].ttl;
    return (now - serverInfo.createdAt) < ttl;
  }

  /**
   * Update last accessed time for a server
   * @param {string} serverKey - Server key
   */
  updateLastAccessed(serverKey) {
    if (this.servers.has(serverKey)) {
      const serverInfo = this.servers.get(serverKey);
      serverInfo.lastAccessedAt = Date.now();
    }
  }

  /**
   * Get server by path
   * @param {string} path - WebSocket path
   * @returns {Object|null} Server info or null if not found
   */
  getServerByPath(path) {
    for (const [serverKey, serverInfo] of this.servers) {
      if (serverInfo.wsPath === path) {
        this.updateLastAccessed(serverKey);
        return serverInfo;
      }
    }
    return null;
  }

  /**
   * Start cleanup process for expired servers
   */
  startCleanupProcess() {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredServers();
    }, config.cleanup.interval);

    info(`🧹 Cleanup process started (interval: ${config.cleanup.interval}ms)`);
  }

  /**
   * Cleanup expired servers
   */
  async cleanupExpiredServers() {
    const now = Date.now();
    const expiredServers = [];

    for (const [serverKey, serverInfo] of this.servers) {
      const ttl = config.browsers[serverInfo.type].ttl;
      if ((now - serverInfo.createdAt) >= ttl) {
        expiredServers.push(serverKey);
      }
    }

    if (expiredServers.length > 0) {
      info(`🧹 Cleaning up ${expiredServers.length} expired servers...`);
      for (const serverKey of expiredServers) {
        await this.cleanupServer(serverKey);
      }
    }
  }

  /**
   * Cleanup a specific server
   * @param {string} serverKey - Server key to cleanup
   */
  async cleanupServer(serverKey) {
    if (!this.servers.has(serverKey)) {
      return;
    }

    const serverInfo = this.servers.get(serverKey);
    try {
      if (serverInfo.server) {
        await serverInfo.server.close();
        info(`✅ ${serverInfo.type} server ${serverInfo.index} (port ${serverInfo.port}) closed`);
      }
    } catch (error) {
      debug(`❌ Error closing ${serverInfo.type} server ${serverInfo.index}:`, error.message);
    }

    this.servers.delete(serverKey);
  }

  /**
   * Cleanup all servers
   */
  async cleanup() {
    info('\n🧹 Cleaning up all servers...');

    // Stop cleanup interval
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    // Close all servers
    const serverKeys = Array.from(this.servers.keys());
    for (const serverKey of serverKeys) {
      await this.cleanupServer(serverKey);
    }

    info(`✅ All servers cleaned up`);
  }

  /**
   * Get server statistics
   * @returns {Object} Server statistics
   */
  getStats() {
    const stats = {
      total: this.servers.size,
      byType: {},
      servers: []
    };

    for (const [serverKey, serverInfo] of this.servers) {
      if (!stats.byType[serverInfo.type]) {
        stats.byType[serverInfo.type] = 0;
      }
      stats.byType[serverInfo.type]++;

      stats.servers.push({
        key: serverKey,
        type: serverInfo.type,
        index: serverInfo.index,
        port: serverInfo.port,
        wsPath: serverInfo.wsPath,
        proxyServer: serverInfo.proxyString || null,
        createdAt: new Date(serverInfo.createdAt).toISOString(),
        lastAccessedAt: new Date(serverInfo.lastAccessedAt).toISOString(),
        age: Date.now() - serverInfo.createdAt,
        ttl: config.browsers[serverInfo.type].ttl,
        expired: !this.isServerValid(serverInfo)
      });
    }

    return stats;
  }
}

module.exports = BrowserManager;
