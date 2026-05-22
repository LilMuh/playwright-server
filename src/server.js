#!/usr/bin/env node
require('dotenv').config(); // Load .env into process.env before any config is read

const http = require('http');
const httpProxy = require('http-proxy');
const BrowserManager = require('./BrowserManager');
const config = require('../config/default');
const dbg = require('debug');

/**
 * Collect and parse JSON body from an incoming HTTP request stream
 */
function parseBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => { resolve(JSON.parse(data || '{}')); });
    req.on('error', () => { resolve({}); });
  });
}

const debug = dbg('debug:server');
const info = dbg('info:server');

class PlaywrightServer {
  constructor() {
    this.browserManager = new BrowserManager();
    this.proxyServer = null;
    this.proxy = null;
  }

  /**
   * Create and start the proxy server
   */
  async start() {
    info('🚀 Starting Playwright proxy server...\n');

    try {
      // Create HTTP proxy
      this.proxy = httpProxy.createProxyServer({
        ws: true,
        changeOrigin: config.proxy.changeOrigin,
        timeout: config.proxy.timeout,
        proxyTimeout: config.proxy.proxyTimeout
      });

      // Create HTTP server
      this.proxyServer = http.createServer((req, res) => {
        this.handleHttpRequest(req, res);
      });

      // Handle WebSocket upgrade requests
      this.proxyServer.on('upgrade', async (req, socket, head) => {
        await this.handleWebSocketUpgrade(req, socket, head);
      });

      // Start server
      this.proxyServer.listen(config.server.port, config.server.host, () => {
        info(`✅ Playwright proxy server started successfully!`);
        info(`   Server listening on ${config.server.host}:${config.server.port}`);
        info(`   Config host: ${config.server.host}`);
        info(`   WebKit servers will be created on-demand (starting from port ${config.browsers.webkit.startPort})`);
        info(`   Chrome servers will be created on-demand (starting from port ${config.browsers.chrome.startPort})`);
        info(`   Server TTL: ${config.browsers.webkit.ttl / 1000 / 60} minutes`);
        info(`   Available WebSocket paths:`);
        info(`     ws://${config.server.host}:${config.server.port}/webkit-<index> → WebKit Server (on-demand)`);
        info(`     ws://${config.server.host}:${config.server.port}/chrome-<index> → Chrome Server (on-demand)`);
        info('\n⚠️  Server will keep running...');
      });

      this.proxyServer.on('error', (error) => {
        debug(`❌ Proxy server error:`, error.message);
      });

      // Setup graceful shutdown
      this.setupGracefulShutdown();

    } catch (error) {
      debug('\n❌ Failed to start server:', error.message);
      await this.cleanup();
      process.exit(1);
    }
  }

  /**
   * Handle HTTP requests
   */
  async handleHttpRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    
    // Health check endpoint
    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
      return;
    }

    // Stats endpoint
    if (url.pathname === '/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.browserManager.getStats(), null, 2));
      return;
    }

    // POST /browser/local - start a local browser
    if (url.pathname === '/browser/local' && req.method === 'POST') {
      const body = await parseBody(req);
      const { taskId, proxy } = body;
      if (!taskId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'taskId is required' }));
        return;
      }
      if (!proxy) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'proxy is required' }));
        return;
      }
      try {
        const ws_endpoint = await this.browserManager.startLocalBrowser(taskId, proxy);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, taskId, ws_endpoint }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    // DELETE /browser/local/:taskId - stop a local browser
    const deleteMatch = url.pathname.match(/^\/browser\/local\/([^/]+)$/);
    if (deleteMatch && req.method === 'DELETE') {
      const taskId = deleteMatch[1];
      try {
        await this.browserManager.stopLocalBrowser(taskId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, taskId }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }

    // Default response
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Playwright Proxy Server\n\nAvailable endpoints:\n- GET /health - Health check\n- GET /stats - Server statistics\n- WebSocket paths: /webkit-<index>, /chrome-<index>');
  }

  /**
   * Handle WebSocket upgrade requests
   */
  async handleWebSocketUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    try {
      // Parse browser type and index from path
      const match = path.match(/^\/(webkit|chrome)-(\d+)$/);
      if (!match) {
        debug(`❌ Invalid WebSocket path: ${path}`);
        socket.destroy();
        return;
      }

      const [, browserType, indexStr] = match;
      const serverIndex = parseInt(indexStr);

      if (isNaN(serverIndex) || serverIndex < 0) {
        debug(`❌ Invalid server index: ${indexStr}`);
        socket.destroy();
        return;
      }

      // Get or create browser server
      const serverInfo = await this.browserManager.getOrCreateServer(browserType, serverIndex);
      const target = `http://127.0.0.1:${serverInfo.port}`;

      // Proxy the WebSocket connection
      this.proxy.ws(req, socket, head, { target }, (error) => {
        debug(`❌ WebSocket proxy error for ${path}:`, error.message);
        socket.destroy();
      });

    } catch (error) {
      debug(`❌ Failed to handle WebSocket upgrade for ${path}:`, error.message);
      socket.destroy();
    }
  }

  /**
   * Setup graceful shutdown handlers
   */
  setupGracefulShutdown() {
    // Handle process exit signals
    process.on('SIGINT', async () => {
      info('\n\n🛑 Received SIGINT, shutting down gracefully...');
      await this.cleanup();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      info('\n\n🛑 Received SIGTERM, shutting down gracefully...');
      await this.cleanup();
      process.exit(0);
    });

    process.on('uncaughtException', async (error) => {
      debug('\n❌ Uncaught Exception:', error);
      await this.cleanup();
      process.exit(1);
    });

    process.on('unhandledRejection', async (reason, promise) => {
      debug('\n❌ Unhandled Rejection at:', promise, 'reason:', reason);
      await this.cleanup();
      process.exit(1);
    });
  }

  /**
   * Cleanup resources
   */
  async cleanup() {
    info('\n🧹 Cleaning up server resources...');

    try {
      // Close proxy server
      if (this.proxyServer) {
        this.proxyServer.close();
        info(`✅ Proxy server closed`);
        this.proxyServer = null;
      }

      // Cleanup browser manager
      if (this.browserManager) {
        await this.browserManager.cleanup();
      }

      info(`✅ All resources cleaned up`);

    } catch (error) {
      debug(`❌ Error during cleanup:`, error.message);
    }
  }
}

// Start server if this file is run directly
if (require.main === module) {
  const server = new PlaywrightServer();
  server.start().catch(async (error) => {
    debug('❌ Startup failed:', error);
    await server.cleanup();
    process.exit(1);
  });
}

module.exports = PlaywrightServer;
