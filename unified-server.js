// final-corrected-unified-server.js

const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const { EventEmitter } = require('events');
const fs =require('fs');
const path = require('path');
const { firefox } = require('playwright');
const os = require('os');


// ===================================================================================
// 认证源管理模块 (已升级：融合B方案的预验证 和 A方案的动态管理)
// ===================================================================================

class AuthSource {
  constructor(logger) {
    this.logger = logger;
    this.authMode = 'file'; // 默认模式
    this.initialIndices = []; // 启动时发现的【所有】索引
    this.validInitialIndices = []; // 启动时发现的【有效】索引
    this.runtimeAuths = new Map(); // 用于动态添加的账号

    if (process.env.AUTH_JSON_1) {
      this.authMode = 'env';
      this.logger.info('[认证] 检测到 AUTH_JSON_1 环境变量，切换到环境变量认证模式。');
    } else {
      this.logger.info('[认证] 未检测到环境变量认证，将使用 "auth/" 目录下的文件。');
    }

    this._discoverAvailableIndices();
    this._preValidateAndFilter(); // B方案特性：预检验

    if (this.getAvailableIndices().length === 0) {
      this.logger.error(`[认证] 致命错误：在 '${this.authMode}' 模式下未找到任何有效的认证源。`);
      throw new Error("未找到有效的认证源。");
    }
  }

  _discoverAvailableIndices() {
    let indices = [];
    if (this.authMode === 'env') {
      const regex = /^AUTH_JSON_(\d+)$/;
      for (const key in process.env) {
        const match = key.match(regex);
        if (match && match[1]) {
          indices.push(parseInt(match[1], 10));
        }
      }
    } else { // 'file' 模式
      const authDir = path.join(__dirname, 'auth');
      if (!fs.existsSync(authDir)) {
        this.logger.warn('[认证] "auth/" 目录不存在。');
        this.initialIndices = [];
        return;
      }
      try {
        const files = fs.readdirSync(authDir);
        const authFiles = files.filter(file => /^auth-\d+\.json$/.test(file));
        indices = authFiles.map(file => {
          const match = file.match(/^auth-(\d+)\.json$/);
          return parseInt(match[1], 10);
        });
      } catch (error) {
        this.logger.error(`[认证] 扫描 "auth/" 目录失败: ${error.message}`);
        this.initialIndices = [];
        return;
      }
    }
    this.initialIndices = [...new Set(indices)].sort((a, b) => a - b);
    this.logger.info(`[认证] 在 '${this.authMode}' 模式下，初步发现 ${this.initialIndices.length} 个认证源。`);
  }

  // B方案特性：预检验并过滤掉格式错误的源
  _preValidateAndFilter() {
    if (this.initialIndices.length === 0) return;

    this.logger.info("[认证] 开始预检验所有永久认证源的JSON格式...");
    const validIndices = [];
    const invalidSourceDescriptions = [];

    for (const index of this.initialIndices) {
      const authContent = this._getAuthContent(index);
      if (authContent) {
        try {
          JSON.parse(authContent);
          validIndices.push(index);
        } catch (e) {
          invalidSourceDescriptions.push(`源 #${index}`);
        }
      } else {
        invalidSourceDescriptions.push(`源 #${index} (无法读取)`);
      }
    }

    if (invalidSourceDescriptions.length > 0) {
      this.logger.warn(`⚠️ [认证] 预检验发现 ${invalidSourceDescriptions.length} 个格式错误或无法读取的认证源: [${invalidSourceDescriptions.join(", ")}]，将从可用列表中忽略。`);
    }
    
    this.validInitialIndices = validIndices;
    this.logger.info(`[认证] 预检验完成，有效永久认证源: [${this.validInitialIndices.join(', ')}]`);
  }
  
  // 内部辅助函数，仅用于预检验，避免日志污染
  _getAuthContent(index) {
    if (this.authMode === 'env') {
      return process.env[`AUTH_JSON_${index}`];
    } else {
      const authFilePath = path.join(__dirname, 'auth', `auth-${index}.json`);
      if (!fs.existsSync(authFilePath)) return null;
      try {
        return fs.readFileSync(authFilePath, 'utf-8');
      } catch (e) {
        return null;
      }
    }
  }

  getAvailableIndices() {
    const runtimeIndices = Array.from(this.runtimeAuths.keys());
    // 合并有效的永久索引和运行时索引
    const allIndices = [...new Set([...this.validInitialIndices, ...runtimeIndices])].sort((a, b) => a - b);
    return allIndices;
  }

  // A方案特性：为仪表盘获取详细信息
  getAccountDetails() {
    const allIndices = this.getAvailableIndices();
    return allIndices.map(index => ({
      index,
      source: this.runtimeAuths.has(index) ? 'temporary' : this.authMode
    }));
  }

  // 【已修正】确保此方法返回的是单个数字或null，而不是数组
  getFirstAvailableIndex() {
    const indices = this.getAvailableIndices();
    return indices.length > 0 ? indices[0] : null; 
  }

  getAuth(index) {
    if (!this.getAvailableIndices().includes(index)) {
      this.logger.error(`[认证] 请求了无效或不存在的认证索引: ${index}`);
      return null;
    }

    // 优先使用运行时（临时）的认证信息
    if (this.runtimeAuths.has(index)) {
      this.logger.info(`[认证] 使用索引 ${index} 的临时认证源。`);
      return this.runtimeAuths.get(index);
    }

    let jsonString;
    let sourceDescription;

    if (this.authMode === 'env') {
      jsonString = process.env[`AUTH_JSON_${index}`];
      sourceDescription = `环境变量 AUTH_JSON_${index}`;
    } else {
      const authFilePath = path.join(__dirname, 'auth', `auth-${index}.json`);
      sourceDescription = `文件 ${authFilePath}`;
      try {
        jsonString = fs.readFileSync(authFilePath, 'utf-8');
      } catch (e) {
        this.logger.error(`[认证] 读取 ${sourceDescription} 失败: ${e.message}`);
        return null;
      }
    }

    try {
      return JSON.parse(jsonString);
    } catch (e) {
      this.logger.error(`[认证] 解析来自 ${sourceDescription} 的JSON内容失败: ${e.message}`);
      return null;
    }
  }

  // A方案特性：动态添加账号
  addAccount(index, authData) {
    if (typeof index !== 'number' || index <= 0) {
      return { success: false, message: "索引必须是一个正数。" };
    }
    if (this.initialIndices.includes(index)) {
      return { success: false, message: `索引 ${index} 已作为永久账号存在。` };
    }
    try {
      if (typeof authData !== 'object' || authData === null) {
        throw new Error("提供的数据不是一个有效的对象。");
      }
      this.runtimeAuths.set(index, authData);
      this.logger.info(`[认证] 成功添加索引为 ${index} 的临时账号。`);
      return { success: true, message: `账号 ${index} 已临时添加。` };
    } catch (e) {
      this.logger.error(`[认证] 添加临时账号 ${index} 失败: ${e.message}`);
      return { success: false, message: `添加账号失败: ${e.message}` };
    }
  }

  // A方案特性：动态删除账号
  removeAccount(index) {
    if (!this.runtimeAuths.has(index)) {
      return { success: false, message: `索引 ${index} 不是一个临时账号，无法移除。` };
    }
    this.runtimeAuths.delete(index);
    this.logger.info(`[认证] 成功移除索引为 ${index} 的临时账号。`);
    return { success: true, message: `账号 ${index} 已移除。` };
  }
}


// ===================================================================================
// 浏览器管理模块 (已升级：B方案的持久化浏览器 + A方案的健壮加载逻辑)
// ===================================================================================

class BrowserManager {
  constructor(logger, config, authSource) {
    this.logger = logger;
    this.config = config;
    this.authSource = authSource;
    this.browser = null; // B方案特性：持久化浏览器实例
    this.context = null; // B方案特性：可切换的上下文
    this.page = null;
    this.currentAuthIndex = 0;
    this.scriptFileName = 'dark-browser.js'; // A方案的文件名

    if (this.config.browserExecutablePath) {
      this.browserExecutablePath = this.config.browserExecutablePath;
      this.logger.info(`[系统] 使用环境变量 CAMOUFOX_EXECUTABLE_PATH 指定的浏览器路径。`);
    } else {
      const platform = os.platform();
      if (platform === 'win32') {
        this.browserExecutablePath = path.join(__dirname, 'camoufox', 'camoufox.exe');
        this.logger.info(`[系统] 检测到操作系统: Windows. 将使用 'camoufox' 目录下的浏览器。`);
      } else if (platform === 'linux') {
        this.browserExecutablePath = path.join(__dirname, 'camoufox-linux', 'camoufox');
        this.logger.info(`[系统] 检测到操作系统: Linux. 将使用 'camoufox-linux' 目录下的浏览器。`);
      } else {
        this.logger.error(`[系统] 不支持的操作系统: ${platform}.`);
        throw new Error(`不支持的操作系统: ${platform}`);
      }
    }
  }

  // B方案特性：启动或切换上下文，而不是重启整个浏览器
  async launchOrSwitchContext(authIndex) {
    // 1. 如果浏览器实例不存在，则进行首次启动
    if (!this.browser) {
      this.logger.info('🚀 [浏览器] 浏览器实例未运行，正在进行首次启动...');
      if (!fs.existsSync(this.browserExecutablePath)) {
        this.logger.error(`❌ [浏览器] 找不到浏览器可执行文件: ${this.browserExecutablePath}`);
        throw new Error(`找不到浏览器可执行文件路径: ${this.browserExecutablePath}`);
      }

      this.browser = await firefox.launch({
        headless: true,
        executablePath: this.browserExecutablePath,
      });

      this.browser.on('disconnected', () => {
        this.logger.error('❌ [浏览器] 浏览器意外断开连接！服务可能需要重启。');
        this.browser = null; this.context = null; this.page = null;
      });
      this.logger.info('✅ [浏览器] 浏览器实例已成功启动，并将在服务生命周期内保持运行。');
    }

    // 2. 如果已存在一个旧的上下文，先优雅地关闭它
    if (this.context) {
      this.logger.info('[浏览器] 正在关闭旧的浏览器上下文...');
      await this.context.close();
      this.context = null; this.page = null;
      this.logger.info('[浏览器] 旧上下文已关闭。');
    }

    // 3. 开始为新账号创建全新的上下文
    const sourceDescription = this.authSource.authMode === 'env' ? `环境变量 AUTH_JSON_${authIndex}` : `文件 auth-${authIndex}.json`;
    this.logger.info('==================================================');
    this.logger.info(`🔄 [浏览器] 正在为账号 #${authIndex} 创建新的浏览器上下文`);
    this.logger.info(`   • 认证源: ${sourceDescription}`);
    this.logger.info('==================================================');

    const storageStateObject = this.authSource.getAuth(authIndex);
    if (!storageStateObject) {
      this.logger.error(`❌ [浏览器] 无法获取或解析索引为 ${authIndex} 的认证信息。`);
      throw new Error(`获取或解析索引 ${authIndex} 的认证源失败。`);
    }

    // A方案特性：自动修正Cookie
    if (storageStateObject.cookies && Array.isArray(storageStateObject.cookies)) {
      let fixedCount = 0;
      const validSameSiteValues = ['Lax', 'Strict', 'None'];
      storageStateObject.cookies.forEach(cookie => {
        if (!validSameSiteValues.includes(cookie.sameSite)) {
          this.logger.warn(`[认证] 发现无效的 sameSite 值: '${cookie.sameSite}'，正在自动修正为 'None'。`);
          cookie.sameSite = 'None';
          fixedCount++;
        }
      });
      if (fixedCount > 0) {
        this.logger.info(`[认证] 自动修正了 ${fixedCount} 个无效的 Cookie 'sameSite' 属性。`);
      }
    }

    let buildScriptContent;
    try {
      const scriptFilePath = path.join(__dirname, this.scriptFileName);
      if (fs.existsSync(scriptFilePath)) {
        buildScriptContent = fs.readFileSync(scriptFilePath, 'utf-8');
        this.logger.info(`✅ [浏览器] 成功读取注入脚本 "${this.scriptFileName}"`);
      } else {
        this.logger.warn(`[浏览器] 未找到注入脚本 "${this.scriptFileName}"。将无注入继续运行。`);
        buildScriptContent = "console.log('dark-browser.js not found, running without injection.');";
      }
    } catch (error) {
      this.logger.error(`❌ [浏览器] 无法读取注入脚本 "${this.scriptFileName}"！`);
      throw error;
    }

    try {
      this.context = await this.browser.newContext({
        storageState: storageStateObject,
        viewport: { width: 1280, height: 720 },
      });

      this.page = await this.context.newPage();
      this.logger.info(`[浏览器] 正在加载账号 ${authIndex} 并访问目标网页...`);
      const targetUrl = 'https://aistudio.google.com/u/0/apps/bundled/blank?showAssistant=true&showCode=true';
      const debugFolder = path.resolve(__dirname, 'debug-screenshots');
      if (!fs.existsSync(debugFolder)) {
        fs.mkdirSync(debugFolder, { recursive: true });
      }

      // ======================================================
      // A方案特性：页面加载带重试 + 失败截图
      // ======================================================
      let pageLoadedSuccessfully = false;
      const maxNavRetries = 3;
      for (let attempt = 1; attempt <= maxNavRetries; attempt++) {
        try {
          this.logger.info(`[浏览器] 页面加载尝试 #${attempt}/${maxNavRetries}...`);
          await this.page.goto(targetUrl, { timeout: 120000, waitUntil: 'networkidle' });

          const internalErrorLocator = this.page.locator('text=An internal error occurred');
          if (await internalErrorLocator.isVisible({ timeout: 5000 }).catch(() => false)) {
            throw new Error('"An internal error occurred"，视为加载失败');
          }

          pageLoadedSuccessfully = true;
          this.logger.info('[浏览器] 网页加载成功，且内容正确。');
          const successPath = path.join(debugFolder, `success-load-${authIndex}-${Date.now()}.png`);
          await this.page.screenshot({ path: successPath, fullPage: true });
          this.logger.info(`[调试] 成功加载的页面截图已保存: ${successPath}`);
          break;
        } catch (error) {
          this.logger.warn(`[浏览器] 页面加载尝试 #${attempt} 失败: ${error.message}`);
          const errorScreenshotPath = path.join(debugFolder, `failed-nav-${authIndex}-${attempt}-${Date.now()}.png`);
          await this.page.screenshot({ path: errorScreenshotPath, fullPage: true }).catch(() => {});
          this.logger.info(`[浏览器] 失败截图已保存: ${errorScreenshotPath}`);

          if (attempt < maxNavRetries) {
            this.logger.info('[浏览器] 等待 5 秒后重试...');
            await new Promise(resolve => setTimeout(resolve, 5000));
          } else {
            this.logger.error('❌ 达到最大页面加载重试次数，启动失败。');
            throw error;
          }
        }
      }

      if (!pageLoadedSuccessfully) throw new Error('所有页面加载尝试均失败，无法继续。');

      // ======================================================
      // A方案特性：【V10 - 终局方案：简单、耐心、重复】
      // ======================================================
      this.logger.info('[浏览器] 页面加载完成，无条件等待10秒，确保UI完全稳定...');
      await this.page.waitForTimeout(10000);
      this.logger.info('[浏览器] 开始在15秒内，持续清理所有弹窗...');
      const cleanupTimeout = Date.now() + 15000;
      const closeButtonLocator = this.page.locator("button:has-text('Got it'), button:has-text('✕')");
      while (Date.now() < cleanupTimeout) {
        const buttons = await closeButtonLocator.all();
        for (const button of buttons) {
          await button.click({ force: true }).catch(() => {});
        }
        await this.page.waitForTimeout(1000);
      }
      this.logger.info('[浏览器] 15秒的持续清理阶段结束。');
      
      // ======================================================
      // A方案特性：【V12 - 带前后截图的智能判断】
      // ======================================================
      try {
        const editorLocator = this.page.locator('div.monaco-editor').first();
        const codeButton = this.page.getByRole('button', { name: 'Code' });
        const isEditorVisible = await editorLocator.isVisible({ timeout: 5000 }).catch(() => false);

        if (isEditorVisible) {
          this.logger.info('[浏览器] 编辑器已默认可见，跳过点击 "Code" 按钮。');
        } else {
          this.logger.info('[浏览器] 编辑器不可见，正在点击 "Code" 按钮以显示它...');
          await codeButton.waitFor({ timeout: 10000 });
          await codeButton.click({ force: true });
          await editorLocator.waitFor({ state: 'visible', timeout: 15000 });
          this.logger.info('[浏览器] 点击 "Code" 后，编辑器已成功加载并显示。');
        }
      } catch (err) {
          this.logger.error('[浏览器] 在判断或切换至Code视图过程中遭遇致命错误。', err);
          const failurePath = path.join(debugFolder, `FAILURE_at_code_click_logic_${Date.now()}.png`);
          await this.page.screenshot({ path: failurePath, fullPage: true }).catch(e => this.logger.error(`[调试] 截取失败截图时出错: ${e.message}`));
          this.logger.info(`[调试] 失败时的截图已保存: ${failurePath}`);
          throw err;
      }
      
      const editorContainerLocator = this.page.locator('div.monaco-editor').first();
      await editorContainerLocator.waitFor({ state: 'attached', timeout: 120000 });
      await editorContainerLocator.click({ force: true, timeout: 120000 });
      await this.page.evaluate(text => navigator.clipboard.writeText(text), buildScriptContent);
      const isMac = os.platform() === 'darwin';
      const pasteKey = isMac ? 'Meta+V' : 'Control+V';
      await this.page.keyboard.press(pasteKey);
      this.logger.info('[浏览器] 脚本已粘贴。');

      await this.page.getByRole('button', { name: 'Preview' }).click();
      this.logger.info('[浏览器] 已切换到预览视图。浏览器端初始化完成。');

      this.currentAuthIndex = authIndex;
      this.logger.info('==================================================');
      this.logger.info(`✅ [浏览器] 账号 ${authIndex} 初始化成功！`);
      this.logger.info('✅ [浏览器] 浏览器客户端已准备就绪。');
      this.logger.info('==================================================');
    } catch (error) {
      this.logger.error(`❌ [浏览器] 账号 ${authIndex} 初始化失败: ${error.message}`);
      // B方案特性：失败时不关闭整个浏览器，只清理上下文
      if (this.context) {
        await this.context.close().catch(e => this.logger.error(`[浏览器] 关闭失败的上下文时出错: ${e.message}`));
        this.context = null; this.page = null;
      }
      throw error;
    }
  }

  async closeBrowser() {
    if (this.browser) {
      this.logger.info('[浏览器] 正在关闭整个浏览器实例...');
      await this.browser.close();
      this.browser = null; this.context = null; this.page = null;
      this.logger.info('[浏览器] 浏览器实例已关闭。');
    }
  }

  // B方案特性：切换账号现在只切换上下文
  async switchAccount(newAuthIndex) {
    this.logger.info(`🔄 [浏览器] 开始账号切换: 从 ${this.currentAuthIndex} 到 ${newAuthIndex}`);
    await this.launchOrSwitchContext(newAuthIndex);
    this.logger.info(`✅ [浏览器] 账号切换完成，当前账号: ${this.currentAuthIndex}`);
  }
}

// ===================================================================================
// 代理服务模块 (已升级：B方案的连接断开缓冲期)
// ===================================================================================

class LoggingService {
  constructor(serviceName = 'ProxyServer') {
    this.serviceName = serviceName;
  }
  _getFormattedTime() { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }
  _formatMessage(level, message) { return `[${level}] ${this._getFormattedTime()} [${this.serviceName}] - ${message}`; }
  info(message) { console.log(`${this._getFormattedTime()} [${this.serviceName}] - ${message}`); }
  error(message) { console.error(this._formatMessage('ERROR', message)); }
  warn(message) { console.warn(this._formatMessage('WARN', message)); }
  debug(message) { console.debug(this._formatMessage('DEBUG', message)); }
}

class MessageQueue extends EventEmitter {
  constructor(timeoutMs = 1200000) {
    super();
    this.messages = []; this.waitingResolvers = []; this.defaultTimeout = timeoutMs; this.closed = false;
  }
  enqueue(message) {
    if (this.closed) return;
    if (this.waitingResolvers.length > 0) { this.waitingResolvers.shift().resolve(message); } 
    else { this.messages.push(message); }
  }
  async dequeue(timeoutMs = this.defaultTimeout) {
    if (this.closed) { throw new Error('队列已关闭'); }
    return new Promise((resolve, reject) => {
      if (this.messages.length > 0) { resolve(this.messages.shift()); return; }
      const resolver = { resolve, reject };
      this.waitingResolvers.push(resolver);
      const timeoutId = setTimeout(() => {
        const index = this.waitingResolvers.indexOf(resolver);
        if (index !== -1) { this.waitingResolvers.splice(index, 1); reject(new Error('队列超时')); }
      }, timeoutMs);
      resolver.timeoutId = timeoutId;
    });
  }
  close() {
    this.closed = true;
    this.waitingResolvers.forEach(resolver => { clearTimeout(resolver.timeoutId); resolver.reject(new Error('队列已关闭')); });
    this.waitingResolvers = []; this.messages = [];
  }
}

class ConnectionRegistry extends EventEmitter {
  constructor(logger) {
    super();
    this.logger = logger;
    this.connections = new Set();
    this.messageQueues = new Map();
    this.reconnectGraceTimer = null; // B方案特性：重连缓冲计时器
  }
  addConnection(websocket, clientInfo) {
    // B方案特性：新连接建立时，清除“断开”警报
    if (this.reconnectGraceTimer) {
      clearTimeout(this.reconnectGraceTimer);
      this.reconnectGraceTimer = null;
      this.logger.info("[服务器] 在缓冲期内检测到新连接，已取消断开处理。");
    }
    this.connections.add(websocket);
    this.logger.info(`[服务器] 内部WebSocket客户端已连接 (来自: ${clientInfo.address})`);
    websocket.on('message', (data) => this._handleIncomingMessage(data.toString()));
    websocket.on('close', () => this._removeConnection(websocket));
    websocket.on('error', (error) => this.logger.error(`[服务器] 内部WebSocket连接错误: ${error.message}`));
    this.emit('connectionAdded', websocket);
  }
  _removeConnection(websocket) {
    this.connections.delete(websocket);
    this.logger.warn('[服务器] 内部WebSocket客户端连接断开。');
    
    // B方案特性：不立即清理队列，而是启动一个缓冲期
    this.logger.info("[服务器] 启动5秒重连缓冲期...");
    this.reconnectGraceTimer = setTimeout(() => {
      this.logger.error("[服务器] 缓冲期结束，未检测到重连。确认连接丢失，正在清理所有待处理请求...");
      this.messageQueues.forEach(queue => queue.close());
      this.messageQueues.clear();
      this.emit('connectionLost'); // 使用新事件名表示确认丢失
    }, 5000); // 5秒缓冲

    this.emit('connectionRemoved', websocket);
  }
  _handleIncomingMessage(messageData) {
    try {
      const parsedMessage = JSON.parse(messageData);
      const requestId = parsedMessage.request_id;
      if (!requestId) { this.logger.warn('[服务器] 收到无效消息：缺少request_id'); return; }
      const queue = this.messageQueues.get(requestId);
      if (queue) { this._routeMessage(parsedMessage, queue); }
    } catch (error) { this.logger.error('[服务器] 解析内部WebSocket消息失败'); }
  }
  _routeMessage(message, queue) {
    const { event_type } = message;
    switch (event_type) {
      case 'response_headers': case 'chunk': case 'error': queue.enqueue(message); break;
      case 'stream_close': queue.enqueue({ type: 'STREAM_END' }); break;
      default: this.logger.warn(`[服务器] 未知的内部事件类型: ${event_type}`);
    }
  }
  hasActiveConnections() { return this.connections.size > 0; }
  getFirstConnection() { return this.connections.values().next().value; }
  createMessageQueue(requestId) {
    const queue = new MessageQueue(); this.messageQueues.set(requestId, queue); return queue;
  }
  removeMessageQueue(requestId) {
    const queue = this.messageQueues.get(requestId);
    if (queue) { queue.close(); this.messageQueues.delete(requestId); }
  }
}

// ===================================================================================
// 请求处理模块 (已升级：融合A和B方案的切换逻辑)
// ===================================================================================
class RequestHandler {
  constructor(serverSystem, connectionRegistry, logger, browserManager, config, authSource) {
    this.serverSystem = serverSystem;
    this.connectionRegistry = connectionRegistry;
    this.logger = logger;
    this.browserManager = browserManager;
    this.config = config;
    this.authSource = authSource;
    this.maxRetries = this.config.maxRetries;
    this.retryDelay = this.config.retryDelay;
    this.failureCount = 0;
    this.usageCount = 0; // B方案特性：使用次数计数
    this.isAuthSwitching = false;
    this.isSystemBusy = false; // B方案特性：系统繁忙锁
    this.needsSwitchingAfterRequest = false; // B方案特性：请求后切换标志
    this.fullCycleFailure = false; // A方案特性：全循环失败标志
    this.startOfFailureCycleIndex = null; // A方案特性：记录失败循环的起始账号
  }

  get currentAuthIndex() { return this.browserManager.currentAuthIndex; }

  _getNextAuthIndex() {
    const available = this.authSource.getAvailableIndices();
    if (available.length === 0) return null;
    if (available.length === 1) return available[0];
    const currentIndexInArray = available.indexOf(this.currentAuthIndex);
    if (currentIndexInArray === -1) {
      this.logger.warn(`[认证] 当前索引 ${this.currentAuthIndex} 不在可用列表中，将切换到第一个可用索引。`);
      return available[0];
    }
    const nextIndexInArray = (currentIndexInArray + 1) % available.length;
    return available[nextIndexInArray];
  }

  // 融合A和B的切换逻辑
  async _switchToNextAuth() {
    if (this.authSource.getAvailableIndices().length <= 1) {
      this.logger.warn("[认证] 😕 检测到只有一个可用账号，拒绝切换操作。");
      throw new Error("只有一个可用账号，无法切换。");
    }
    if (this.isAuthSwitching) {
      this.logger.info('🔄 [认证] 正在切换账号，跳过重复切换');
      throw new Error("切换已在进行中。");
    }

    this.isSystemBusy = true; // B方案特性：加锁
    this.isAuthSwitching = true;

    const nextAuthIndex = this._getNextAuthIndex();
    const totalAuthCount = this.authSource.getAvailableIndices().length;

    // A方案特性：熔断检查
    if (this.fullCycleFailure) {
        this.logger.error('🔴 [认证] 已检测到全账号循环失败，将暂停自动切换以防止资源过载。');
        this.isAuthSwitching = false; this.isSystemBusy = false;
        throw new Error('全账号循环失败，自动切换已熔断。');
    }
    if (this.startOfFailureCycleIndex !== null && nextAuthIndex === this.startOfFailureCycleIndex) {
        this.logger.error('🔴 [认证] 已完成一整轮账号切换但问题依旧，触发全循环失败熔断机制！');
        this.fullCycleFailure = true;
    }

    this.logger.info('==================================================');
    this.logger.info(`🔄 [认证] 开始账号切换流程`);
    this.logger.info(`   • 失败次数: ${this.failureCount}/${this.config.failureThreshold > 0 ? this.config.failureThreshold : 'N/A'}`);
    this.logger.info(`   • 当前账号索引: ${this.currentAuthIndex}`);
    this.logger.info(`   • 目标账号索引: ${nextAuthIndex}`);
    this.logger.info(`   • 可用账号总数: ${totalAuthCount}`);
    this.logger.info('==================================================');

    try {
      await this.browserManager.switchAccount(nextAuthIndex);
      this.failureCount = 0;
      this.usageCount = 0; // B方案特性：重置使用次数
      this.fullCycleFailure = false; // A方案特性：重置熔断
      this.startOfFailureCycleIndex = null;
      this.logger.info('==================================================');
      this.logger.info(`✅ [认证] 成功切换到账号索引 ${this.currentAuthIndex}`);
      this.logger.info(`✅ [认证] 失败和使用计数已重置，熔断机制已重置。`);
      this.logger.info('==================================================');
    } catch (error) {
      this.logger.error('==================================================');
      this.logger.error(`❌ [认证] 切换账号失败: ${error.message}`);
      this.logger.error('==================================================');
      // B方案特性：这里可以增加回退逻辑，但为简化，暂时只抛出错误
      throw error;
    } finally {
      this.isAuthSwitching = false;
      this.isSystemBusy = false; // B方案特性：解锁
    }
  }

  _parseAndCorrectErrorDetails(errorDetails) {
    const correctedDetails = { ...errorDetails };
    if (this.config.debugMode) {
      this.logger.debug(`[错误解析器] 原始错误详情: ${JSON.stringify(correctedDetails, null, 2)}`);
    }
    if (correctedDetails.message && typeof correctedDetails.message === 'string') {
      const regex = /(?:HTTP|status code)\s*(\d{3})|"code"\s*:\s*(\d{3})/;
      const match = correctedDetails.message.match(regex);
      const parsedStatusString = match ? (match[1] || match[2]) : null;
      if (parsedStatusString) {
        const parsedStatus = parseInt(parsedStatusString, 10);
        if (parsedStatus >= 400 && parsedStatus <= 599 && correctedDetails.status !== parsedStatus) {
          this.logger.warn(`[错误解析器] 修正了错误状态码！原始: ${correctedDetails.status}, 从消息中解析得到: ${parsedStatus}`);
          correctedDetails.status = parsedStatus;
        }
      }
    }
    return correctedDetails;
  }

  async _handleRequestFailureAndSwitch(errorDetails, res) {
    const correctedDetails = this._parseAndCorrectErrorDetails(errorDetails);

    if (this.fullCycleFailure) {
        this.logger.warn('[认证] 熔断已触发，跳过失败计数和切换逻辑。');
        return;
    }
    
    const isImmediateSwitch = this.config.immediateSwitchStatusCodes.includes(correctedDetails.status);
    const isThresholdReached = this.config.failureThreshold > 0 && (this.failureCount + 1) >= this.config.failureThreshold;

    if (isImmediateSwitch) {
      this.logger.warn(`🔴 [认证] 收到状态码 ${correctedDetails.status}，触发立即切换账号...`);
      if (res) this._sendErrorChunkToClient(res, `收到状态码 ${correctedDetails.status}，正在尝试切换账号...`);
      try {
        await this._switchToNextAuth();
        if (res) this._sendErrorChunkToClient(res, `已切换到账号索引 ${this.currentAuthIndex}，请重试`);
      } catch (switchError) {
        this.logger.error(`🔴 [认证] 账号切换失败: ${switchError.message}`);
        if (res) this._sendErrorChunkToClient(res, `切换账号失败: ${switchError.message}`);
      }
      return;
    }

    if (this.config.failureThreshold > 0) {
      this.failureCount++;
      this.logger.warn(`⚠️ [认证] 请求失败 - 失败计数: ${this.failureCount}/${this.config.failureThreshold} (当前账号索引: ${this.currentAuthIndex}, 状态码: ${correctedDetails.status})`);

      if (this.failureCount >= this.config.failureThreshold && this.startOfFailureCycleIndex === null) {
          this.logger.info(`[认证] 启动失败循环检测，起始账号索引为: ${this.currentAuthIndex}`);
          this.startOfFailureCycleIndex = this.currentAuthIndex;
      }
      
      if (this.failureCount >= this.config.failureThreshold) {
        this.logger.warn(`🔴 [认证] 达到失败阈值！准备切换账号...`);
        if (res) this._sendErrorChunkToClient(res, `连续失败${this.failureCount}次，正在尝试切换账号...`);
        try {
          await this._switchToNextAuth();
          if (res) this._sendErrorChunkToClient(res, `已切换到账号索引 ${this.currentAuthIndex}，请重试`);
        } catch (switchError) {
          this.logger.error(`🔴 [认证] 账号切换失败: ${switchError.message}`);
          if (res) this._sendErrorChunkToClient(res, `切换账号失败: ${switchError.message}`);
        }
      }
    }
  }

  _getModelFromRequest(req) {
    let body = req.body;
    if (Buffer.isBuffer(body)) { try { body = JSON.parse(body.toString('utf-8')); } catch (e) { body = {}; } }
    else if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    if (body && typeof body === 'object') {
      if (body.model) return body.model;
      if (body.generation_config && body.generation_config.model) return body.generation_config.model;
    }
    const match = req.path.match(/\/models\/([^/:]+)/);
    if (match && match[1]) { return match[1]; }
    return 'unknown_model';
  }

  async processRequest(req, res) {
    if (this.isSystemBusy) {
      this.logger.warn("[系统] 收到新请求，但系统正在进行切换/恢复，拒绝新请求。");
      return this._sendErrorResponse(res, 503, "服务器正在进行内部维护（账号切换/恢复），请稍后重试。");
    }
    
    if ((!this.config.apiKeys || this.config.apiKeys.length === 0) && req.query && req.query.hasOwnProperty('key')) {
      delete req.query.key;
    }

    const modelName = this._getModelFromRequest(req);
    const currentAccount = this.currentAuthIndex;
    this.logger.info(`[请求] ${req.method} ${req.path} | 账号: ${currentAccount} | 模型: 🤖 ${modelName}`);

    this.serverSystem.stats.totalCalls++;
    if (!this.serverSystem.stats.accountCalls[currentAccount]) {
      this.serverSystem.stats.accountCalls[currentAccount] = { total: 0, models: {} };
    }
    this.serverSystem.stats.accountCalls[currentAccount].total++;
    this.serverSystem.stats.accountCalls[currentAccount].models[modelName] = (this.serverSystem.stats.accountCalls[currentAccount].models[modelName] || 0) + 1;

    // B方案特性：按使用次数切换
    const isGenerativeRequest = req.method === "POST" && (req.path.includes("generateContent") || req.path.includes("streamGenerateContent"));
    if (this.config.switchOnUses > 0 && isGenerativeRequest) {
      this.usageCount++;
      this.logger.info(`[请求] 账号轮换计数: ${this.usageCount}/${this.config.switchOnUses} (当前账号: ${this.currentAuthIndex})`);
      if (this.usageCount >= this.config.switchOnUses) {
        this.needsSwitchingAfterRequest = true;
      }
    }

    if (!this.connectionRegistry.hasActiveConnections()) {
      return this._sendErrorResponse(res, 503, '没有可用的浏览器连接');
    }
    const requestId = this._generateRequestId();
    
    // 【✨ 新增功能：请求中止处理 ✨】
    res.on('close', () => {
      // 检查响应是否已正常结束。如果不是，说明是用户提前关闭了连接。
      if (!res.writableEnded) {
        this.logger.warn(`[请求] 客户端似乎已提前关闭了请求 #${requestId} 的连接。`);
        this.logger.info(`  -> 正在向浏览器发送中止指令以节省资源...`);
        const cancelPayload = {
          event_type: "cancel_request",
          request_id: requestId,
        };
        const connection = this.connectionRegistry.getFirstConnection();
        if (connection) {
          connection.send(JSON.stringify(cancelPayload));
          this.logger.info(`  -> 中止指令已发送。`);
        } else {
          this.logger.warn(`  -> 未能发送中止指令：没有可用的内部WebSocket连接。`);
        }
      }
    });

    const proxyRequest = this._buildProxyRequest(req, requestId);
    const messageQueue = this.connectionRegistry.createMessageQueue(requestId);
    try {
      if (this.serverSystem.streamingMode === 'fake') {
        await this._handlePseudoStreamResponse(proxyRequest, messageQueue, req, res);
      } else {
        await this._handleRealStreamResponse(proxyRequest, messageQueue, res);
      }
    } catch (error) {
      this._handleRequestError(error, res);
    } finally {
      this.connectionRegistry.removeMessageQueue(requestId);
      if (this.needsSwitchingAfterRequest) {
        this.logger.info(`[认证] 轮换计数已达到切换阈值，将在后台自动切换账号...`);
        this._switchToNextAuth().catch((err) => {
          this.logger.error(`[认证] 后台账号切换任务失败: ${err.message}`);
        });
        this.needsSwitchingAfterRequest = false;
      }
    }
  }
  _generateRequestId() { return `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`; }
  _buildProxyRequest(req, requestId) {
    const proxyRequest = {
      path: req.path, method: req.method, headers: req.headers, query_params: req.query,
      request_id: requestId, streaming_mode: this.serverSystem.streamingMode
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      let requestBodyString;
      if (typeof req.body === 'object' && req.body !== null) { requestBodyString = JSON.stringify(req.body); } 
      else if (typeof req.body === 'string') { requestBodyString = req.body; } 
      else if (Buffer.isBuffer(req.body)) { requestBodyString = req.body.toString('utf-8'); } 
      else { requestBodyString = ''; }
      proxyRequest.body = requestBodyString;
    }
    return proxyRequest;
  }
  _forwardRequest(proxyRequest) {
    const connection = this.connectionRegistry.getFirstConnection();
    if (connection) { connection.send(JSON.stringify(proxyRequest)); } 
    else { throw new Error("无法转发请求：没有可用的WebSocket连接。"); }
  }
  _sendErrorChunkToClient(res, errorMessage) {
    const errorPayload = { error: { message: `[代理系统提示] ${errorMessage}`, type: 'proxy_error', code: 'proxy_error' } };
    const chunk = `data: ${JSON.stringify(errorPayload)}\n\n`;
    if (res && !res.writableEnded) { res.write(chunk); }
  }
  _getKeepAliveChunk(req) {
    if (req.path.includes('chat/completions')) {
      const payload = { id: `chatcmpl-${this._generateRequestId()}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "gpt-4", choices: [{ index: 0, delta: {}, finish_reason: null }] };
      return `data: ${JSON.stringify(payload)}\n\n`;
    }
    if (req.path.includes('generateContent') || req.path.includes('streamGenerateContent')) {
      const payload = { candidates: [{ content: { parts: [{ text: "" }], role: "model" }, finishReason: null, index: 0, safetyRatings: [] }] };
      return `data: ${JSON.stringify(payload)}\n\n`;
    }
    return 'data: {}\n\n';
  }
  async _handlePseudoStreamResponse(proxyRequest, messageQueue, req, res) {
    const isStreamRequest = req.path.includes(':stream');
    let connectionMaintainer = null;
    if (isStreamRequest) {
      res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
      const keepAliveChunk = this._getKeepAliveChunk(req);
      connectionMaintainer = setInterval(() => { if (!res.writableEnded) res.write(keepAliveChunk); }, 2000);
    }
    try {
      let lastMessage, requestFailed = false;
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        this._forwardRequest(proxyRequest);
        lastMessage = await messageQueue.dequeue();
        if (lastMessage.event_type === 'error' && lastMessage.status >= 400 && lastMessage.status <= 599) {
          await this._handleRequestFailureAndSwitch(lastMessage, isStreamRequest ? res : null);
          if (attempt < this.maxRetries) { await new Promise(resolve => setTimeout(resolve, this.retryDelay)); continue; }
          requestFailed = true;
        }
        break;
      }
      if (lastMessage.event_type === 'error' || requestFailed) {
        const finalError = this._parseAndCorrectErrorDetails(lastMessage);
        if (!res.headersSent) { this._sendErrorResponse(res, finalError.status, `请求失败: ${finalError.message}`); } 
        else { this._sendErrorChunkToClient(res, `请求最终失败 (状态码: ${finalError.status}): ${finalError.message}`); }
        return;
      }
      if (this.failureCount > 0 || this.startOfFailureCycleIndex !== null) {
        this.logger.info(`✅ [认证] 请求成功 - 失败计数已重置，熔断状态已清除。`);
        this.failureCount = 0; this.fullCycleFailure = false; this.startOfFailureCycleIndex = null;
      }
      const dataMessage = await messageQueue.dequeue();
      await messageQueue.dequeue(); // End message
      if (isStreamRequest) {
        if (dataMessage.data) { res.write(`data: ${dataMessage.data}\n\n`); }
        res.write('data: [DONE]\n\n');
      } else {
        if (dataMessage.data) {
          try { res.status(200).json(JSON.parse(dataMessage.data)); } 
          catch (e) { this._sendErrorResponse(res, 500, '代理内部错误：无法解析来自后端的响应。'); }
        } else { this._sendErrorResponse(res, 500, '代理内部错误：后端未返回有效数据。'); }
      }
    } catch (error) {
      if (!res.headersSent) { this._handleRequestError(error, res); } 
      else { this._sendErrorChunkToClient(res, `处理失败: ${error.message}`); }
    } finally {
      if (connectionMaintainer) clearInterval(connectionMaintainer);
      if (!res.writableEnded) res.end();
    }
  }
  async _handleRealStreamResponse(proxyRequest, messageQueue, res) {
    let headerMessage, requestFailed = false;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      this._forwardRequest(proxyRequest);
      headerMessage = await messageQueue.dequeue();
      if (headerMessage.event_type === 'error' && headerMessage.status >= 400 && headerMessage.status <= 599) {
        await this._handleRequestFailureAndSwitch(headerMessage, null);
        if (attempt < this.maxRetries) { await new Promise(resolve => setTimeout(resolve, this.retryDelay)); continue; }
        requestFailed = true;
      }
      break;
    }
    if (headerMessage.event_type === 'error' || requestFailed) {
      const finalError = this._parseAndCorrectErrorDetails(headerMessage);
      return this._sendErrorResponse(res, finalError.status, finalError.message);
    }
    if (this.failureCount > 0 || this.startOfFailureCycleIndex !== null) {
      this.logger.info(`✅ [认证] 请求成功 - 失败计数已重置，熔断状态已清除。`);
      this.failureCount = 0; this.fullCycleFailure = false; this.startOfFailureCycleIndex = null;
    }
    this._setResponseHeaders(res, headerMessage);
    try {
      while (true) {
        const dataMessage = await messageQueue.dequeue(30000);
        if (dataMessage.type === 'STREAM_END') break;
        if (dataMessage.data) res.write(dataMessage.data);
      }
    } catch (error) {
      if (error.message !== '队列超时') throw error;
    } finally {
      if (!res.writableEnded) res.end();
    }
  }
  _setResponseHeaders(res, headerMessage) {
    res.status(headerMessage.status || 200);
    const headers = headerMessage.headers || {};
    Object.entries(headers).forEach(([name, value]) => { if (name.toLowerCase() !== 'content-length') res.set(name, value); });
  }
  _handleRequestError(error, res) {
    if (res.headersSent) { if (!res.writableEnded) res.end(); } 
    else { const status = error.message.includes('超时') ? 504 : 500; this._sendErrorResponse(res, status, `代理错误: ${error.message}`); }
  }
  _sendErrorResponse(res, status, message) {
    if (!res.headersSent) res.status(status || 500).type('text/plain').send(message);
  }
}

// ===================================================================================
// 主服务器系统 (已升级：B方案的弹性启动和HTTP超时)
// ===================================================================================
class ProxyServerSystem extends EventEmitter {
  constructor() {
    super();
    this.logger = new LoggingService('ProxySystem');
    this._loadConfiguration();
    this.streamingMode = this.config.streamingMode;
    this.stats = { totalCalls: 0, accountCalls: {} };
    this.authSource = new AuthSource(this.logger);
    this.browserManager = new BrowserManager(this.logger, this.config, this.authSource);
    this.connectionRegistry = new ConnectionRegistry(this.logger);
    this.requestHandler = new RequestHandler(this, this.connectionRegistry, this.logger, this.browserManager, this.config, this.authSource);
    this.httpServer = null; this.wsServer = null;
  }

  _loadConfiguration() {
    let config = {
      httpPort: 8889, host: '0.0.0.0', wsPort: 9998, streamingMode: 'real',
      failureThreshold: 0,
      switchOnUses: 0, // B方案特性：新增配置项
      maxRetries: 3, retryDelay: 2000, browserExecutablePath: null,
      apiKeys: [], immediateSwitchStatusCodes: [], initialAuthIndex: null, debugMode: false,
    };
    const configPath = path.join(__dirname, 'config.json');
    try {
      if (fs.existsSync(configPath)) {
        const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        config = { ...config, ...fileConfig };
        this.logger.info('[系统] 已从 config.json 加载配置。');
      }
    } catch (error) { this.logger.warn(`[系统] 无法读取或解析 config.json: ${error.message}`); }

    if (process.env.PORT) config.httpPort = parseInt(process.env.PORT, 10) || config.httpPort;
    if (process.env.HOST) config.host = process.env.HOST;
    if (process.env.STREAMING_MODE) config.streamingMode = process.env.STREAMING_MODE;
    if (process.env.FAILURE_THRESHOLD) config.failureThreshold = parseInt(process.env.FAILURE_THRESHOLD, 10) || config.failureThreshold;
    if (process.env.SWITCH_ON_USES) config.switchOnUses = parseInt(process.env.SWITCH_ON_USES, 10) || config.switchOnUses; // B方案特性
    if (process.env.MAX_RETRIES) config.maxRetries = parseInt(process.env.MAX_RETRIES, 10) || config.maxRetries;
    if (process.env.RETRY_DELAY) config.retryDelay = parseInt(process.env.RETRY_DELAY, 10) || config.retryDelay;
    if (process.env.CAMOUFOX_EXECUTABLE_PATH) config.browserExecutablePath = process.env.CAMOUFOX_EXECUTABLE_PATH;
    if (process.env.API_KEYS) { config.apiKeys = process.env.API_KEYS.split(','); }
    if (process.env.DEBUG_MODE) { config.debugMode = process.env.DEBUG_MODE === 'true'; }
    if (process.env.INITIAL_AUTH_INDEX) {
      const envIndex = parseInt(process.env.INITIAL_AUTH_INDEX, 10);
      if (!isNaN(envIndex) && envIndex > 0) { config.initialAuthIndex = envIndex; }
    }
    let rawCodes = process.env.IMMEDIATE_SWITCH_STATUS_CODES || (config.immediateSwitchStatusCodes || []).join(',');
    if (rawCodes && typeof rawCodes === 'string') {
      config.immediateSwitchStatusCodes = rawCodes.split(',').map(c => parseInt(String(c).trim(), 10)).filter(c => !isNaN(c) && c >= 400 && c <= 599);
    } else { config.immediateSwitchStatusCodes = []; }
    config.apiKeys = (config.apiKeys || []).map(k => String(k).trim()).filter(k => k);
    
    this.config = config;
    this.logger.info('================ [ 生效配置 ] ================');
    this.logger.info(`  HTTP 服务端口: ${this.config.httpPort}`);
    this.logger.info(`  监听地址: ${this.config.host}`);
    this.logger.info(`  流式模式: ${this.config.streamingMode}`);
    this.logger.info(`  调试模式: ${this.config.debugMode ? '已开启' : '已关闭'}`);
    if (this.config.initialAuthIndex) { this.logger.info(`  指定初始认证索引: ${this.config.initialAuthIndex}`); }
    this.logger.info(`  次数轮换切换: ${this.config.switchOnUses > 0 ? `每 ${this.config.switchOnUses} 次生成请求后切换` : '已禁用'}`);
    this.logger.info(`  失败计数切换: ${this.config.failureThreshold > 0 ? `连续 ${this.config.failureThreshold} 次失败后切换` : '已禁用'}`);
    this.logger.info(`  立即切换状态码: ${this.config.immediateSwitchStatusCodes.length > 0 ? this.config.immediateSwitchStatusCodes.join(', ') : '已禁用'}`);
    this.logger.info(`  API 密钥认证: ${this.config.apiKeys.length > 0 ? `已启用 (${this.config.apiKeys.length} 个密钥)` : '已禁用'}`);
    this.logger.info('=============================================================');
  }

  // B方案特性：弹性启动
  async start() {
    this.logger.info("[系统] 开始弹性启动流程...");
    const allAvailableIndices = this.authSource.getAvailableIndices();
    if (allAvailableIndices.length === 0) {
      throw new Error("没有任何可用的认证源，无法启动。");
    }
    
    this.authSource.getAvailableIndices().forEach(index => {
      this.stats.accountCalls[index] = { total: 0, models: {} };
    });

    let startupOrder = [...allAvailableIndices];
    const suggestedIndex = this.config.initialAuthIndex;
    let startupIndex = suggestedIndex && allAvailableIndices.includes(suggestedIndex) ? suggestedIndex : this.authSource.getFirstAvailableIndex();
    
    if (startupIndex && startupIndex !== suggestedIndex) {
         if (suggestedIndex) {
             this.logger.warn(`[系统] 指定的启动索引 #${suggestedIndex} 无效或不可用，将使用第一个可用索引 #${startupIndex}。`);
         } else {
             this.logger.info(`[系统] 未指定有效启动索引，将自动使用第一个可用索引 #${startupIndex}。`);
         }
    } else {
         this.logger.info(`[系统] 将使用指定的启动索引 #${startupIndex}。`);
    }

    let isStarted = false;
    if (startupIndex) {
        startupOrder = [startupIndex, ...allAvailableIndices.filter((i) => i !== startupIndex)];
    }

    for (const index of startupOrder) {
      try {
        this.logger.info(`[系统] 尝试使用账号 #${index} 启动服务...`);
        await this.browserManager.launchOrSwitchContext(index);
        isStarted = true;
        this.logger.info(`[系统] ✅ 使用账号 #${index} 成功启动！`);
        break;
      } catch (error) {
        this.logger.error(`[系统] ❌ 使用账号 #${index} 启动失败。原因: ${error.message}`);
      }
    }

    if (!isStarted) {
      throw new Error("所有认证源均尝试失败，服务器无法启动。");
    }

    await this._startHttpServer();
    await this._startWebSocketServer();
    this.logger.info(`[系统] 代理服务器系统启动完成。`);
    this.emit('started');
  }

  _createDebugLogMiddleware() {
    return (req, res, next) => {
      if (!this.config.debugMode) { return next(); }
      const requestId = this.requestHandler._generateRequestId();
      const log = this.logger.info.bind(this.logger);
      log(`\n--- [调试] 开始处理入站请求 (${requestId}) ---`);
      log(`[调试][${requestId}] 客户端 IP: ${req.ip}, 方法: ${req.method}, URL: ${req.originalUrl}`);
      log(`[调试][${requestId}] 请求头: ${JSON.stringify(req.headers, null, 2)}`);
      let bodyContent = '无或空';
      if (req.body) {
        if (Buffer.isBuffer(req.body) && req.body.length > 0) {
          try { bodyContent = JSON.stringify(JSON.parse(req.body.toString('utf-8')), null, 2); } 
          catch (e) { bodyContent = `[无法解析为JSON的Buffer, 大小: ${req.body.length} 字节]`; }
        } else if (typeof req.body === 'object' && Object.keys(req.body).length > 0) {
          bodyContent = JSON.stringify(req.body, null, 2);
        }
      }
      log(`[调试][${requestId}] 请求体:\n${bodyContent}`);
      log(`--- [调试] 结束处理入站请求 (${requestId}) ---\n`);
      next();
    };
  }

  _createAuthMiddleware() {
    return (req, res, next) => {
      const serverApiKeys = this.config.apiKeys;
      if (!serverApiKeys || serverApiKeys.length === 0) { return next(); }
      let clientKey = null;
      const headers = req.headers;
      if (headers['x-goog-api-key']) { clientKey = headers['x-goog-api-key']; } 
      else if (headers.authorization && headers.authorization.startsWith('Bearer ')) { clientKey = headers.authorization.substring(7); } 
      else if (headers['x-api-key']) { clientKey = headers['x-api-key']; } 
      else if (req.query.key) { clientKey = req.query.key; }
      if (clientKey && serverApiKeys.includes(clientKey)) {
        if (req.query.key) { delete req.query.key; }
        return next();
      }
      this.logger.warn(`[认证] 拒绝受保护的请求: 缺少或无效的API密钥。IP: ${req.ip}, 路径: ${req.path}`);
      return res.status(401).json({ error: { message: "提供了无效的API密钥。" } });
    };
  }

  async _startHttpServer() {
    const app = this._createExpressApp();
    this.httpServer = http.createServer(app);
    // B方案特性：设置服务器超时
    this.httpServer.keepAliveTimeout = 30000;
    this.httpServer.headersTimeout = 35000;
    return new Promise((resolve) => {
      this.httpServer.listen(this.config.httpPort, this.config.host, () => {
        this.logger.info(`[系统] HTTP服务器已在 http://${this.config.host}:${this.config.httpPort} 上监听`);
        this.logger.info(`[系统] 仪表盘可在 http://${this.config.host}:${this.config.httpPort}/dashboard 访问`);
        resolve();
      });
    });
  }

  // A方案特性：保留完整的Express App创建逻辑，特别是仪表盘
  _createExpressApp() {
    const app = express();
    app.use(express.json({ limit: '100mb' }));
    app.use(express.raw({ type: '*/*', limit: '100mb' }));
    app.use((req, res, next) => {
      if (req.is('application/json') && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {} 
      else if (Buffer.isBuffer(req.body)) {
        const bodyStr = req.body.toString('utf-8');
        if (bodyStr) { try { req.body = JSON.parse(bodyStr); } catch (e) {} }
      }
      next();
    });
    app.use(this._createDebugLogMiddleware());
    app.get('/', (req, res) => { res.redirect('/dashboard'); });
    app.get('/dashboard', (req, res) => { res.send(this._getDashboardHtml()); });
    app.post('/dashboard/verify-key', (req, res) => {
      const { key } = req.body;
      const serverApiKeys = this.config.apiKeys;
      if (!serverApiKeys || serverApiKeys.length === 0) { return res.json({ success: true }); }
      if (key && serverApiKeys.includes(key)) { return res.json({ success: true }); }
      res.status(401).json({ success: false, message: '无效的API密钥。' });
    });
    const dashboardApiAuth = (req, res, next) => {
      const serverApiKeys = this.config.apiKeys;
      if (!serverApiKeys || serverApiKeys.length === 0) { return next(); }
      const clientKey = req.headers['x-dashboard-auth'];
      if (clientKey && serverApiKeys.includes(clientKey)) { return next(); }
      res.status(401).json({ error: { message: 'Unauthorized dashboard access' } });
    };
    const dashboardApiRouter = express.Router();
    dashboardApiRouter.use(dashboardApiAuth);
    dashboardApiRouter.get('/data', (req, res) => {
      res.json({
        status: {
          uptime: process.uptime(), streamingMode: this.streamingMode, debugMode: this.config.debugMode,
          authMode: this.authSource.authMode, apiKeyAuth: (this.config.apiKeys.length > 0) ? '已启用' : '已禁用',
          isAuthSwitching: this.requestHandler.isAuthSwitching, browserConnected: !!this.browserManager.browser,
          internalWsClients: this.connectionRegistry.connections.size
        },
        auth: {
          currentAuthIndex: this.requestHandler.currentAuthIndex, accounts: this.authSource.getAccountDetails(),
          failureCount: this.requestHandler.failureCount,
        },
        stats: this.stats, config: this.config
      });
    });
    dashboardApiRouter.post('/config', (req, res) => {
      const newConfig = req.body;
      try {
        if (newConfig.hasOwnProperty('streamingMode')) this.config.streamingMode = newConfig.streamingMode;
        if (newConfig.hasOwnProperty('debugMode')) this.config.debugMode = newConfig.debugMode;
        if (newConfig.hasOwnProperty('failureThreshold')) this.config.failureThreshold = parseInt(newConfig.failureThreshold, 10) || 0;
        if (newConfig.hasOwnProperty('switchOnUses')) this.config.switchOnUses = parseInt(newConfig.switchOnUses, 10) || 0; // B方案特性
        if (newConfig.hasOwnProperty('maxRetries')) this.config.maxRetries = parseInt(newConfig.maxRetries, 10) >= 0 ? parseInt(newConfig.maxRetries, 10) : 3;
        if (newConfig.hasOwnProperty('retryDelay')) this.config.retryDelay = parseInt(newConfig.retryDelay, 10) || 2000;
        if (newConfig.hasOwnProperty('immediateSwitchStatusCodes')) {
          this.config.immediateSwitchStatusCodes = (newConfig.immediateSwitchStatusCodes || []).map(c => parseInt(c, 10)).filter(c => !isNaN(c));
        }
        // 更新依赖于配置的处理器属性
        this.requestHandler.config = this.config;
        this.requestHandler.maxRetries = this.config.maxRetries;
        this.requestHandler.retryDelay = this.config.retryDelay;
        this.streamingMode = this.config.streamingMode;
        this.requestHandler.serverSystem.streamingMode = this.config.streamingMode;
        this.logger.info('[管理] 配置已通过仪表盘动态更新。');
        res.status(200).json({ success: true, message: '配置已临时更新。' });
      } catch (error) { res.status(500).json({ success: false, message: error.message }); }
    });
    dashboardApiRouter.post('/accounts', (req, res) => {
      const { index, authData } = req.body;
      if (!index || !authData) { return res.status(400).json({ success: false, message: "必须提供索引和认证数据。" }); }
      let parsedData;
      try { parsedData = (typeof authData === 'string') ? JSON.parse(authData) : authData; } 
      catch (e) { return res.status(400).json({ success: false, message: "认证数据的JSON格式无效。" }); }
      const result = this.authSource.addAccount(parseInt(index, 10), parsedData);
      if (result.success && !this.stats.accountCalls.hasOwnProperty(index)) {
        this.stats.accountCalls[index] = { total: 0, models: {} };
      }
      res.status(result.success ? 200 : 400).json(result);
    });
    dashboardApiRouter.delete('/accounts/:index', (req, res) => {
      const index = parseInt(req.params.index, 10);
      const result = this.authSource.removeAccount(index);
      res.status(result.success ? 200 : 400).json(result);
    });
    app.use('/dashboard', dashboardApiRouter);
    app.post('/switch', dashboardApiAuth, async (req, res) => {
      this.logger.info('[管理] 接到 /switch 请求，手动触发账号切换。');
      try {
        const oldIndex = this.requestHandler.currentAuthIndex;
        await this.requestHandler._switchToNextAuth();
        const newIndex = this.requestHandler.currentAuthIndex;
        res.status(200).send(`成功将账号从索引 ${oldIndex} 切换到 ${newIndex}。`);
      } catch (error) { res.status(500).send(`切换账号失败: ${error.message}`); }
    });
    app.get('/health', (req, res) => { res.status(200).json({ status: 'healthy', uptime: process.uptime() }); });
    app.use(this._createAuthMiddleware());
    app.all(/(.*)/, (req, res) => {
      if (req.path === '/' || req.path === '/favicon.ico' || req.path.startsWith('/dashboard')) { return res.status(204).send(); }
      this.requestHandler.processRequest(req, res);
    });
    return app;
  }

_getDashboardHtml() {
  return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>服务器仪表盘 (gcli2api Style)</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
:root {
  --bg-color: #111217;
  --card-bg-color: #1f2937;
  --border-color: rgba(139,92,246,0.2);
  --text-color: #f9fafb;
  --text-muted-color: #9ca3af;
  --primary-color: #6d28d9;
  --primary-glow-color: rgba(109,40,217,0.5);
  --primary-hover-color: #7c3aed;
  --success-color: #16a34a;
  --danger-color: #dc2626;
  --border-radius: 0.75rem;
  --transition-speed: 0.25s;
}
* { box-sizing: border-box; }
body {
  font-family: 'Inter', sans-serif;
  margin: 0; padding: 3rem;
  background: linear-gradient(135deg,#111217,#1a1b23);
  color: var(--text-color);
  min-height: 100vh;
}
main.container {
  max-width: 1200px; margin: 0 auto;
  display: none; opacity: 0;
  transform: translateY(20px);
  transition: opacity var(--transition-speed) ease-out, transform var(--transition-speed) ease-out;
}
main.container.visible { display: block; opacity: 1; transform: translateY(0); }
.main-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(400px,1fr));
  grid-auto-rows: minmax(300px, auto);
  gap: 2rem;
}

/* 卡片效果 */
article {
  background: var(--card-bg-color);
  border: 1px solid var(--border-color);
  border-radius: var(--border-radius);
  padding: 2rem;
  box-shadow: 0 0 15px rgba(0,0,0,0.2);
  transition: transform var(--transition-speed), box-shadow var(--transition-speed), border-color var(--transition-speed);
}
article:hover {
  transform: translateY(-6px) scale(1.02);
  box-shadow: 0 0 30px var(--primary-glow-color);
  border-color: var(--primary-color);
}

/* 标题与文字 */
h1 { display:flex; align-items:center; gap:1rem; font-size:2.25rem; font-weight:700; margin-bottom:2.5rem; text-shadow:0 0 10px var(--primary-glow-color);}
h2 { display:flex; align-items:center; gap:0.75rem; margin-top:0; padding-bottom:1rem; margin-bottom:1.5rem; font-size:1.25rem; font-weight:600; border-bottom:1px solid var(--border-color);}
h2 .icon { color: var(--primary-color); }

.status-grid { display:grid; grid-template-columns:1fr 1fr; gap:1rem; }
.status-item { background-color: rgba(255,255,255,0.03); padding:1rem; border-radius:0.5rem; border:1px solid var(--border-color); display:flex; justify-content:space-between; align-items:center; transition: background 0.3s, transform 0.3s; }
.status-item span { font-weight:600; transition: color 0.3s; }
.status-text-info { color:#60a5fa; }
.status-text-red { color:#f87171; }
.status-text-yellow { color:#facc15; }

/* 表单和按钮 */
button,input,select {
  background-color: transparent; border: 1px solid var(--border-color);
  color: var(--text-color); padding:0.75rem 1rem;
  border-radius:0.5rem; font-family: inherit; font-size:1rem;
  transition: all var(--transition-speed);
  width:100%;
}
input:focus, select:focus { outline:none; border-color: var(--primary-color); box-shadow:0 0 0 3px var(--primary-glow-color); }
button { cursor:pointer; font-weight:600; background-color: var(--primary-color); border:none; color: var(--text-color); box-shadow:0 0 15px var(--primary-glow-color);}
button:hover { background-color: var(--primary-hover-color); transform: scale(1.05); }
.btn-success { background-color: var(--success-color); box-shadow: 0 0 15px rgba(22,163,74,0.5);}
.btn-success:hover { background-color:#22c55e; }
.btn-danger { background-color: var(--danger-color); border:none; color:#fff; box-shadow:none; font-size:0.8rem; padding:0.4rem 0.8rem; font-weight:500;}
.btn-danger:hover { background-color:#ef4444; transform: scale(1.05); }

.form-group { margin-bottom:1.5rem; }
form label { display:block; margin-bottom:0.5rem; font-weight:500; color: var(--text-muted-color); }

.account-list { list-style:none; padding:0; margin:0; display:grid; gap:0.75rem; }
.account-list li {
  display:flex; justify-content:space-between; align-items:center;
  padding:0.75rem 1rem;
  background-color: rgba(255,255,255,0.03);
  border:1px solid var(--border-color); border-radius:0.5rem;
  transition: all var(--transition-speed);
}
.account-list li:hover { border-color: var(--primary-color); background-color: rgba(109,40,217,0.1);}
.account-list li.current { border-color: var(--primary-color); box-shadow: inset 0 0 10px var(--primary-glow-color); font-weight:600; }

.tag { padding:0.25em 0.75em; font-size:0.8em; font-weight:500; border-radius:999px; border:1px solid; }
.tag-permanent { color:#60a5fa; border-color:#60a5fa; }
.tag-temporary { color:#facc15; border-color:#facc15; }

/* toast 动画 */
.toast { position: fixed; bottom: 20px; right: 20px; background-color:#282a36; color:white; padding:1rem 1.5rem; border-radius:var(--border-radius); border-left:4px solid var(--primary-color); z-index:1000; opacity:0; transform: translateY(20px) scale(0.95); transition: all 0.4s cubic-bezier(0.215,0.610,0.355,1); box-shadow:0 10px 30px rgba(0,0,0,0.3);}
.toast.show { opacity:1; transform:translateY(0) scale(1); }
.toast.error { border-left-color: var(--danger-color);}
.toast.success { border-left-color: var(--success-color);}
</style>
</head>
<body>
<main class="container">
<h1>
  <svg class="icon" width="40" height="40" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M16.42 7.45L12 2L7.58 7.45L12 12.87L16.42 7.45ZM17.97 14.39L12 22L6.03 14.39L12 8.42L17.97 14.39Z" stroke="var(--primary-color)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
  <span>服务器仪表盘</span>
</h1>

<div class="main-grid">
  <article>
    <h2><span class="icon">🕹️</span> 账号管理</h2>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1.5rem;">
      <button id="switchAccountBtn">切换下一个账号</button>
      <button id="addAccountBtn">添加临时账号</button>
    </div>
    <div id="accountPool" class="account-list"></div>
  </article>

  <article>
    <h2><span class="icon">📊🖥️</span> 调用统计 & 服务器状态</h2>
    <div id="accountStats" class="account-list" style="margin-bottom:1.5rem;"></div>
    <div class="status-grid">
      <div class="status-item"><strong>运行时间</strong> <span id="uptime">--</span></div>
      <div class="status-item"><strong>浏览器</strong> <span id="browserConnected">--</span></div>
      <div class="status-item"><strong>认证模式</strong> <span id="authMode">--</span></div>
      <div class="status-item"><strong>API密钥认证</strong> <span id="apiKeyAuth">--</span></div>
      <div class="status-item"><strong>调试模式</strong> <span id="debugMode">--</span></div>
      <div class="status-item"><strong>API总调用次数</strong> <span id="totalCalls">--</span></div>
    </div>
  </article>

  <article style="grid-column: 1 / -1;">
    <h2><span class="icon">⚙️</span> 实时配置</h2>
    <form id="configForm">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;">
        <div class="form-group"><label for="configStreamingMode">流式模式</label><select id="configStreamingMode" name="streamingMode"><option value="real">Real</option><option value="fake">Fake</option></select></div>
        <div class="form-group"><label for="configSwitchOnUses">N次请求后轮换</label><input type="number" id="configSwitchOnUses" name="switchOnUses"></div>
        <div class="form-group"><label for="configFailureThreshold">N次失败后切换</label><input type="number" id="configFailureThreshold" name="failureThreshold"></div>
        <div class="form-group"><label for="configMaxRetries">内部重试次数</label><input type="number" id="configMaxRetries" name="maxRetries"></div>
        <div class="form-group"><label for="configRetryDelay">重试间隔(ms)</label><input type="number" id="configRetryDelay" name="retryDelay"></div>
      </div>
      <div class="form-group"><label for="configImmediateSwitchStatusCodes">立即切换的状态码 (逗号分隔)</label><input type="text" id="configImmediateSwitchStatusCodes" name="immediateSwitchStatusCodes"></div>
      <button type="submit" class="btn-success">应用临时更改</button>
    </form>
  </article>
</div>
</main>

<div id="toast" class="toast"></div>
<script>
document.addEventListener('DOMContentLoaded', () => {
  const API_KEY_SESSION_STORAGE = 'dashboard_api_key';
  const API_BASE = '/dashboard';
  const mainContainer = document.querySelector('main.container');

  function getAuthHeaders(hasBody = false) {
    const headers = { 'X-Dashboard-Auth': sessionStorage.getItem(API_KEY_SESSION_STORAGE) || '' };
    if (hasBody) headers['Content-Type'] = 'application/json';
    return headers;
  }

  function showToast(message, type = 'info') {
    const toastEl = document.getElementById('toast');
    toastEl.textContent = message;
    toastEl.className = 'toast show ' + type;
    setTimeout(() => { toastEl.className = 'toast'; }, 3000);
  }

  function formatUptime(seconds) {
    const d = Math.floor(seconds / (3600*24));
    const h = Math.floor(seconds % (3600*24) / 3600);
    const m = Math.floor(seconds % 3600 / 60);
    const s = Math.floor(seconds % 60);
    return (d ? d+'天 ' : '') + (h || d ? h+'小时 ' : '') + (m || h || d ? m+'分钟 ' : '') + s+'秒';
  }

  async function fetchData() {
    try {
      const response = await fetch(API_BASE + '/data', { headers: getAuthHeaders() });
      if (!response.ok) { sessionStorage.removeItem(API_KEY_SESSION_STORAGE); mainContainer.classList.remove('visible'); document.body.innerHTML = '<h1>认证已过期或无效，请刷新页面重新输入密钥。</h1>'; return; }
      const data = await response.json();

      document.getElementById('uptime').textContent = formatUptime(data.status.uptime);
      document.getElementById('browserConnected').innerHTML = data.status.browserConnected ? '<span class="status-text-info">已连接</span>' : '<span class="status-text-red">已断开</span>';
      document.getElementById('authMode').innerHTML = data.status.authMode === 'env' ? '环境变量' : '文件';
      document.getElementById('apiKeyAuth').innerHTML = data.status.apiKeyAuth === '已启用' ? '<span class="status-text-info">已启用</span>' : '已禁用';
      document.getElementById('debugMode').innerHTML = data.status.debugMode ? '<span class="status-text-yellow">已启用</span>' : '已禁用';
      document.getElementById('totalCalls').textContent = data.stats.totalCalls;

      const accountStatsEl = document.getElementById('accountStats'); accountStatsEl.innerHTML = '';
      const sortedAccountsStat = Object.entries(data.stats.accountCalls).sort((a,b) => parseInt(a[0])-parseInt(b[0]));
      if (!sortedAccountsStat.length) accountStatsEl.innerHTML = '<li>无调用记录</li>';
      else sortedAccountsStat.forEach(([index, stats]) => { const li = document.createElement('li'); li.innerHTML = '<span>账号 '+index+'</span><strong>'+stats.total+' 次</strong>'; if(parseInt(index)===data.auth.currentAuthIndex) li.classList.add('current'); accountStatsEl.appendChild(li); });

      const accountPoolEl = document.getElementById('accountPool'); accountPoolEl.innerHTML = '';
      if (!data.auth.accounts.length) accountPoolEl.innerHTML = '<li>账号池为空</li>';
      else data.auth.accounts.forEach(acc => {
        const li = document.createElement('li');
        const sourceTag = acc.source==='temporary'?'<span class="tag tag-temporary">临时</span>':'<span class="tag tag-permanent">永久</span>';
        let html = '<div style="display:flex;align-items:center;gap:0.75rem;"><span>账号 '+acc.index+'</span> '+sourceTag+'</div>';
        if (acc.source==='temporary') html += '<button class="btn-danger" data-index="'+acc.index+'">删除</button>';
        li.innerHTML = html;
        if (acc.index===data.auth.currentAuthIndex) li.classList.add('current');
        accountPoolEl.appendChild(li);
      });

      const configForm = document.getElementById('configForm');
      configForm.streamingMode.value = data.config.streamingMode;
      configForm.switchOnUses.value = data.config.switchOnUses;
      configForm.failureThreshold.value = data.config.failureThreshold;
      configForm.maxRetries.value = data.config.maxRetries;
      configForm.retryDelay.value = data.config.retryDelay;
      configForm.immediateSwitchStatusCodes.value = (data.config.immediateSwitchStatusCodes || []).join(', ');
    } catch (error) { console.error('获取数据时出错:', error); }
  }

  function initializeListeners() {
    document.getElementById('switchAccountBtn').addEventListener('click', async () => {
      showToast('正在切换账号...', 'info');
      try { const response = await fetch('/switch', { method: 'POST', headers: getAuthHeaders() }); const text = await response.text(); if (!response.ok) throw new Error(text); showToast(text, 'success'); fetchData(); } catch (error) { showToast(error.message,'error'); }
    });

    document.getElementById('addAccountBtn').addEventListener('click', () => {
      const index = prompt("输入新临时账号的数字索引："); if (!index || isNaN(parseInt(index))) return;
      const authDataStr = prompt("输入单行压缩后的Cookie内容:"); if (!authDataStr) return;
      let authData; try { authData = JSON.parse(authDataStr); } catch(e) { alert("Cookie JSON格式无效。"); return; }
      fetch(API_BASE+'/account',{method:'POST',headers:getAuthHeaders(true),body:JSON.stringify({index:parseInt(index),authData})})
      .then(res=>res.json().then(data=>{if(!res.ok) throw new Error(data.message||'操作失败');return data;}))
      .then(()=>{showToast('临时账号已添加','success');fetchData();})
      .catch(err=>showToast(err.message,'error'));
    });

    document.getElementById('accountPool').addEventListener('click', e => {
      if(e.target.classList.contains('btn-danger')) {
        const index = e.target.dataset.index;
        if(!confirm('确定要删除账号 '+index+' 吗？')) return;
        fetch(API_BASE+'/account/'+index,{method:'DELETE',headers:getAuthHeaders()})
        .then(res=>res.json().then(data=>{if(!res.ok)throw new Error(data.message||'操作失败');return data;}))
        .then(()=>{showToast('账号已删除','success');fetchData();})
        .catch(err=>showToast(err.message,'error'));
      }
    });

    document.getElementById('configForm').addEventListener('submit', e => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const data = Object.fromEntries(formData.entries());
      data.switchOnUses=parseInt(data.switchOnUses,10)||0;
      data.failureThreshold=parseInt(data.failureThreshold,10)||0;
      data.maxRetries=parseInt(data.maxRetries,10)||0;
      data.retryDelay=parseInt(data.retryDelay,10)||0;
      data.immediateSwitchStatusCodes=data.immediateSwitchStatusCodes.split(',').map(s=>s.trim()).filter(Boolean);
      fetch(API_BASE+'/config',{method:'POST',headers:getAuthHeaders(true),body:JSON.stringify(data)})
      .then(res=>res.json().then(data=>{if(!res.ok)throw new Error(data.message||'操作失败');return data;}))
      .then(()=>{showToast('配置已应用','success');fetchData();})
      .catch(err=>showToast(err.message,'error'));
    });
  }

  async function checkApiKey() {
    const apiKey=sessionStorage.getItem(API_KEY_SESSION_STORAGE);
    if(!apiKey) {
      const key=prompt('请输入访问仪表盘的API密钥：');
      if(!key){document.body.innerHTML='<h1>需要提供API密钥。</h1>'; return;}
      sessionStorage.setItem(API_KEY_SESSION_STORAGE,key);
    }
    try {
      const response = await fetch(API_BASE+'/data',{headers:getAuthHeaders()});
      if(!response.ok) throw new Error('认证失败');
      mainContainer.classList.add('visible');
      initializeListeners();
      fetchData();
      setInterval(fetchData,5000);
    } catch(error) {
      sessionStorage.removeItem(API_KEY_SESSION_STORAGE);
      document.body.innerHTML='<h1>API密钥无效，请刷新页面重新输入。</h1>';
    }
  }

  checkApiKey();
});
</script>
</body>
</html>
  `;
}

  async _startWebSocketServer() {
    this.wsServer = new WebSocket.Server({ port: this.config.wsPort, host: this.config.host });
    this.wsServer.on('connection', (ws, req) => {
      this.connectionRegistry.addConnection(ws, { address: req.socket.remoteAddress });
    });
  }
}

// ===================================================================================
// 主初始化
// ===================================================================================

async function initializeServer() {
  try {
    const serverSystem = new ProxyServerSystem();
    await serverSystem.start();
  } catch (error) {
    console.error('❌ 服务器启动失败:', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  initializeServer();
}

module.exports = { ProxyServerSystem, BrowserManager, initializeServer };
