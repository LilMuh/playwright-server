const { webkit, chromium } = require('playwright');
const config = require('../config/default');
const dbg = require('debug');

const debug = dbg('debug:browser-manager');
const info = dbg('info:browser-manager');

class BrowserManager {
  constructor() {
    this.servers = new Map(); // Map<string, ServerInfo>
    this.localSessions = new Map(); // Map<taskId, { ws_endpoint, createdAt }>
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
  async getOrCreateServer(browserType, serverIndex = null) {
    if (!config.browsers[browserType] || !config.browsers[browserType].enabled) {
      throw new Error(`Browser type ${browserType} is not enabled`);
    }

    // If no server index provided, use next available
    if (serverIndex === null) {
      serverIndex = this.getNextServerIndex(browserType);
    }

    const serverKey = `${browserType}-${serverIndex}`;
    
    // Check if server already exists and is still valid
    if (this.servers.has(serverKey)) {
      const serverInfo = this.servers.get(serverKey);
      if (this.isServerValid(serverInfo)) {
        debug(`♻️  Reusing existing ${browserType} server ${serverIndex} on port ${serverInfo.port}`);
        return serverInfo;
      } else {
        // Server expired, clean it up
        await this.cleanupServer(serverKey);
      }
    }

    // Create new server
    return await this.createServer(browserType, serverIndex);
  }

  /**
   * Create a new browser server
   * @param {string} browserType - 'webkit' or 'chrome'
   * @param {number} serverIndex - Server index
   * @returns {Promise<Object>} Server info object
   */
  async createServer(browserType, serverIndex) {
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

      const server = await browser.launchServer({
        port: port,
        host: '0.0.0.0',
        wsPath: `/${browserType}-${serverIndex}`,
        ...browserConfig.launchOptions
      });

      const serverInfo = {
        type: browserType,
        index: serverIndex,
        port: port,
        server: server,
        wsPath: `/${browserType}-${serverIndex}`,
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
   * Generic HTTP helper for local-browser-proxy REST API; throws on non-2xx responses
   */
  async _localProxyFetch(method, path, body) {
    const { baseUrl, apiKey } = config.localBrowserProxy;
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `local-browser-proxy error ${res.status}`);
      err.statusCode = res.status;
      throw err;
    }
    return data;
  }

  /**
   * Create a browser profile via local-browser-proxy, start it, and cache the WS endpoint keyed by taskId
   */
  async startLocalBrowser(taskId, proxy) {
    await this._localProxyFetch('POST', '/browser/create', { profile_name: taskId, proxy });
    const result = await this._localProxyFetch('POST', '/browser/start', { profile_name: taskId });
    const { ws_endpoint } = result;
    this.localSessions.set(taskId, { taskId, ws_endpoint, createdAt: Date.now() });
    info(`✅ Local browser started for task ${taskId}`);
    return ws_endpoint;
  }

  /**
   * Stop local browser via proxy and evict from session map; stop errors are suppressed so cleanup always proceeds
   */
  async stopLocalBrowser(taskId) {
    try {
      await this._localProxyFetch('POST', '/browser/stop', { profile_name: taskId });
      await this._localProxyFetch('DELETE', `/open-api/profiles/by-name/${taskId}`);
    } catch (error) {
      debug(`❌ Error stopping local browser ${taskId}:`, error.message);
    }
    this.localSessions.delete(taskId);
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

    // Expire local browser sessions past their TTL
    const { ttl } = config.localBrowserProxy;
    for (const [taskId, session] of this.localSessions) {
      if ((now - session.createdAt) >= ttl) {
        await this.stopLocalBrowser(taskId);
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

    // Stop all active local browser sessions
    for (const taskId of Array.from(this.localSessions.keys())) {
      await this.stopLocalBrowser(taskId);
    }

    info(`✅ All servers cleaned up`);
  }

  /**
   * Get server statistics
   * @returns {Object} Server statistics
   */
  getStats() {
    const now = Date.now();
    const stats = {
      total: this.servers.size + this.localSessions.size,
      byType: {},
      servers: [],
      localSessions: []
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
        createdAt: new Date(serverInfo.createdAt).toISOString(),
        lastAccessedAt: new Date(serverInfo.lastAccessedAt).toISOString(),
        age: now - serverInfo.createdAt,
        ttl: config.browsers[serverInfo.type].ttl,
        expired: !this.isServerValid(serverInfo)
      });
    }

    // Append local browser session stats
    const { ttl } = config.localBrowserProxy;
    for (const [taskId, session] of this.localSessions) {
      stats.localSessions.push({
        taskId,
        ws_endpoint: session.ws_endpoint,
        createdAt: new Date(session.createdAt).toISOString(),
        age: now - session.createdAt,
        ttl,
        expired: (now - session.createdAt) >= ttl
      });
    }

    return stats;
  }
}

module.exports = BrowserManager;
