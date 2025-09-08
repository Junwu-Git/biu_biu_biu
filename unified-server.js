const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { firefox } = require('playwright');
const os = require('os');


// ===================================================================================
// 认证源管理模块 (已升级以支持动态管理)
// ===================================================================================

class AuthSource {
  constructor(logger) {
    this.logger = logger;
    this.authMode = 'file'; // 默认模式
    this.initialIndices = []; // 启动时发现的索引
    this.runtimeAuths = new Map(); // 用于动态添加的账号

    if (process.env.AUTH_JSON_1) {
      this.authMode = 'env';
      this.logger.info('[认证] 检测到 AUTH_JSON_1 环境变量，切换到环境变量认证模式。');
    } else {
      this.logger.info('[认证] 未检测到环境变量认证，将使用 "auth/" 目录下的文件。');
    }

    this._discoverAvailableIndices();

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
        // 修正：正确解析捕获组 (match[1]) 而不是整个匹配对象
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
        // 修正：正确解析文件名中的捕获组 (match[1])
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
    this.logger.info(`[认证] 在 '${this.authMode}' 模式下，检测到 ${this.initialIndices.length} 个认证源。`);
    if (this.initialIndices.length > 0) {
      this.logger.info(`[认证] 可用初始索引: [${this.initialIndices.join(', ')}]`);
    }
  }

  getAvailableIndices() {
    const runtimeIndices = Array.from(this.runtimeAuths.keys());
    const allIndices = [...new Set([...this.initialIndices, ...runtimeIndices])].sort((a, b) => a - b);
    return allIndices;
  }

  // 新增方法：为仪表盘获取详细信息
  getAccountDetails() {
    const allIndices = this.getAvailableIndices();
    return allIndices.map(index => ({
      index,
      source: this.runtimeAuths.has(index) ? 'temporary' : this.authMode
    }));
  }


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
      if (!fs.existsSync(authFilePath)) {
        this.logger.error(`[认证] ${sourceDescription} 在读取时突然消失。`);
        return null;
      }
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

  // 新增方法：动态添加账号
  addAccount(index, authData) {
    if (typeof index !== 'number' || index <= 0) {
      return { success: false, message: "索引必须是一个正数。" };
    }
    if (this.initialIndices.includes(index)) {
      return { success: false, message: `索引 ${index} 已作为永久账号存在。` };
    }
    try {
      // 验证 authData 是否为有效的JSON对象
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

  // 新增方法：动态删除账号
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
// 浏览器管理模块
// ===================================================================================

class BrowserManager {
  constructor(logger, config, authSource) {
    this.logger = logger;
    this.config = config;
    this.authSource = authSource;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.currentAuthIndex = 0;
    this.scriptFileName = 'dark-browser.js';

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

  async launchBrowser(authIndex) {
    if (this.browser) {
      this.logger.warn('尝试启动一个已在运行的浏览器实例，操作已取消。');
      return;
    }

    const sourceDescription = this.authSource.authMode === 'env' ? `环境变量 AUTH_JSON_${authIndex}` : `文件 auth-${authIndex}.json`;
    this.logger.info('==================================================');
    this.logger.info(`🚀 [浏览器] 准备启动浏览器`);
    this.logger.info(`   • 认证源: ${sourceDescription}`);
    this.logger.info(`   • 浏览器路径: ${this.browserExecutablePath}`);
    this.logger.info('==================================================');

    if (!fs.existsSync(this.browserExecutablePath)) {
      this.logger.error(`❌ [浏览器] 找不到浏览器可执行文件: ${this.browserExecutablePath}`);
      throw new Error(`找不到浏览器可执行文件路径: ${this.browserExecutablePath}`);
    }

    const storageStateObject = this.authSource.getAuth(authIndex);
    if (!storageStateObject) {
      this.logger.error(`❌ [浏览器] 无法获取或解析索引为 ${authIndex} 的认证信息。`);
      throw new Error(`获取或解析索引 ${authIndex} 的认证源失败。`);
    }

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
      this.browser = await firefox.launch({
        headless: true,
        executablePath: this.browserExecutablePath,
      });
      this.browser.on('disconnected', () => {
        this.logger.error('❌ [浏览器] 浏览器意外断开连接！服务器可能需要重启。');
        this.browser = null; this.context = null; this.page = null;
      });
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
      // 页面加载带重试 + 失败截图
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

          // 成功截图
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
      // 【V10 - 终局方案：简单、耐心、重复】
      // ======================================================
      
      // 第一步：给予页面充足的“静默”稳定时间
      // 不做任何检查，只是简单地、无条件地等待10秒。
      // 这足以让99%的前端动画和异步加载完成。
      this.logger.info('[浏览器] 页面加载完成，无条件等待10秒，确保UI完全稳定...');
      await this.page.waitForTimeout(10000);

      // 第二步：在一个固定时间内，持续不断地“清扫”页面
      // 这是一个“愚蠢”但极其有效的循环，它会反复尝试关闭所有已知的弹窗。
      this.logger.info('[浏览器] 开始在15秒内，持续清理所有弹窗...');
      const cleanupTimeout = Date.now() + 15000;
      let closedCount = 0;
      
      // 定义所有可能的关闭按钮
      const closeButtonLocator = this.page.locator(
        "button:has-text('Got it'), button:has-text('✕')"
      );

      while (Date.now() < cleanupTimeout) {
        // 尝试找到并点击所有可见的关闭按钮，忽略任何错误
        const buttons = await closeButtonLocator.all();
        for (const button of buttons) {
          await button.click({ force: true }).catch(() => {});
          closedCount++;
          this.logger.info(`[浏览器] 关闭了一个弹窗... (已尝试关闭 ${closedCount} 个)`);
        }
        // 每次清扫后，等待一小段时间
        await this.page.waitForTimeout(1000);
      }
      this.logger.info('[浏览器] 15秒的持续清理阶段结束。');

      // 第三步：截图并调试
      this.logger.info('[调试] 所有清理和等待已完成，记录点击前的最终页面状态...');
      // 为截图文件名添加时间戳，防止文件被覆盖
      const beforeClickPath = path.join(debugFolder, `FINAL_STATE_before_click_${Date.now()}.png`);
      await this.page.screenshot({ path: beforeClickPath, fullPage: true });
      this.logger.info(`[调试] 点击前的截图已保存: ${beforeClickPath}`);
      
      const allButtons = await this.page.locator('button').allTextContents();
      this.logger.info(`[调试] 点击前页面的按钮列表: ${JSON.stringify(allButtons, null, 2)}`);

      // ======================================================
      // 【V12 - 带前后截图的智能判断】
      // ======================================================
      // 第四步：智能判断编辑器状态，在需要时点击 "Code" 按钮，并记录前后状态
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
          
          // ======================================================
          //  新增：截取点击 "Code" 按钮【之后】的屏幕
          // ======================================================
          this.logger.info('[调试] 已点击 "Code" 按钮，正在截取点击后的页面状态...');
          const afterClickPath = path.join(debugFolder, `AFTER_clicking_code_button_${Date.now()}.png`);
          await this.page.screenshot({ path: afterClickPath, fullPage: true });
          this.logger.info(`[调试] 点击后的截图已保存: ${afterClickPath}`);

          // 点击后，等待编辑器真正变为可见状态
          await editorLocator.waitFor({ state: 'visible', timeout: 15000 });
          this.logger.info('[浏览器] 点击 "Code" 后，编辑器已成功加载并显示。');
        }
      } catch (err) {
          this.logger.error('[浏览器] 在判断或切换至Code视图过程中遭遇致命错误。', err);
          // 在错误发生时也进行截图，用于最终诊断
          const failurePath = path.join(debugFolder, `FAILURE_at_code_click_logic_${Date.now()}.png`);
          await this.page.screenshot({ path: failurePath, fullPage: true }).catch(e => this.logger.error(`[调试] 截取失败截图时出错: ${e.message}`));
          this.logger.info(`[调试] 失败时的截图已保存: ${failurePath}`);
          throw err;
      }
      
      // 后续的注入脚本逻辑
      const editorContainerLocator = this.page.locator('div.monaco-editor').first();
                        
      this.logger.info('[浏览器] 等待编辑器附加到DOM，最长120秒...');
      await editorContainerLocator.waitFor({ state: 'attached', timeout: 120000 });
      this.logger.info('[浏览器] 编辑器已附加。');

      this.logger.info('[浏览器] 等待5秒，之后将在页面下方执行一次模拟点击以确保页面激活...');
      await this.page.waitForTimeout(5000);

      const viewport = this.page.viewportSize();
      if (viewport) {
        const clickX = viewport.width / 2;
        const clickY = viewport.height - 120;
        this.logger.info(`[浏览器] 在页面底部中心位置 (x≈${Math.round(clickX)}, y=${clickY}) 执行点击。`);
        await this.page.mouse.click(clickX, clickY);
      } else {
        this.logger.warn('[浏览器] 无法获取视窗大小，跳过页面底部模拟点击。');
      }

      await editorContainerLocator.click({ force: true, timeout: 120000 });
      await this.page.evaluate(text => navigator.clipboard.writeText(text), buildScriptContent);
      const isMac = os.platform() === 'darwin';
      const pasteKey = isMac ? 'Meta+V' : 'Control+V';
      await this.page.keyboard.press(pasteKey);
      this.logger.info('[浏览器] 脚本已粘贴。');

      this.logger.info('[浏览器] 正在点击 "Preview" 按钮以使代码生效...');
      await this.page.getByRole('button', { name: 'Preview' }).click();
      this.logger.info('[浏览器] 已切换到预览视图。浏览器端初始化完成。');


      this.currentAuthIndex = authIndex;
      this.logger.info('==================================================');
      this.logger.info(`✅ [浏览器] 账号 ${authIndex} 初始化成功！`);
      this.logger.info('✅ [浏览器] 浏览器客户端已准备就绪。');
      this.logger.info('==================================================');
    } catch (error) {
      this.logger.error(`❌ [浏览器] 账号 ${authIndex} 初始化失败: ${error.message}`);
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
      throw error;
    }
  }

  async closeBrowser() {
    if (this.browser) {
      this.logger.info('[浏览器] 正在关闭当前浏览器实例...');
      await this.browser.close();
      this.browser = null; this.context = null; this.page = null;
      this.logger.info('[浏览器] 浏览器已关闭。');
    }
  }

  async switchAccount(newAuthIndex) {
    this.logger.info(`🔄 [浏览器] 开始账号切换: 从 ${this.currentAuthIndex} 到 ${newAuthIndex}`);
    await this.closeBrowser();
    await this.launchBrowser(newAuthIndex);
    this.logger.info(`✅ [浏览器] 账号切换完成，当前账号: ${this.currentAuthIndex}`);
  }
}

// ===================================================================================
// 代理服务模块
// ===================================================================================

class LoggingService {
  constructor(serviceName = 'ProxyServer') {
    this.serviceName = serviceName;
  }

  _getFormattedTime() {
    // 使用 toLocaleTimeString 并指定 en-GB 区域来保证输出为 HH:mm:ss 格式
    return new Date().toLocaleTimeString('en-GB', { hour12: false });
  }

  // 用于 ERROR, WARN, DEBUG 等带有级别标签的日志
  _formatMessage(level, message) {
    const time = this._getFormattedTime();
    return `[${level}] ${time} [${this.serviceName}] - ${message}`;
  }

  // info 级别使用特殊格式，不显示 [INFO]
  info(message) {
    const time = this._getFormattedTime();
    console.log(`${time} [${this.serviceName}] - ${message}`);
  }

  error(message) {
    console.error(this._formatMessage('ERROR', message));
  }

  warn(message) {
    console.warn(this._formatMessage('WARN', message));
  }

  debug(message) {
    // 修正：移除内部对环境变量的检查。
    // 现在，只要调用此方法，就会打印日志。
    // 是否调用取决于程序其他部分的 this.config.debugMode 判断。
    console.debug(this._formatMessage('DEBUG', message));
  }
}

class MessageQueue extends EventEmitter {
  constructor(timeoutMs = 1200000) {
    super();
    this.messages = [];
    this.waitingResolvers = [];
    this.defaultTimeout = timeoutMs;
    this.closed = false;
  }
  enqueue(message) {
    if (this.closed) return;
    if (this.waitingResolvers.length > 0) {
      const resolver = this.waitingResolvers.shift();
      resolver.resolve(message);
    } else {
      this.messages.push(message);
    }
  }
  async dequeue(timeoutMs = this.defaultTimeout) {
    if (this.closed) {
      throw new Error('队列已关闭');
    }
    return new Promise((resolve, reject) => {
      if (this.messages.length > 0) {
        resolve(this.messages.shift());
        return;
      }
      const resolver = { resolve, reject };
      this.waitingResolvers.push(resolver);
      const timeoutId = setTimeout(() => {
        const index = this.waitingResolvers.indexOf(resolver);
        if (index !== -1) {
          this.waitingResolvers.splice(index, 1);
          reject(new Error('队列超时'));
        }
      }, timeoutMs);
      resolver.timeoutId = timeoutId;
    });
  }
  close() {
    this.closed = true;
    this.waitingResolvers.forEach(resolver => {
      clearTimeout(resolver.timeoutId);
      resolver.reject(new Error('队列已关闭'));
    });
    this.waitingResolvers = [];
    this.messages = [];
  }
}

class ConnectionRegistry extends EventEmitter {
  constructor(logger) {
    super();
    this.logger = logger;
    this.connections = new Set();
    this.messageQueues = new Map();
  }
  addConnection(websocket, clientInfo) {
    this.connections.add(websocket);
    this.logger.info(`[服务器] 内部WebSocket客户端已连接 (来自: ${clientInfo.address})`);
    websocket.on('message', (data) => this._handleIncomingMessage(data.toString()));
    websocket.on('close', () => this._removeConnection(websocket));
    websocket.on('error', (error) => this.logger.error(`[服务器] 内部WebSocket连接错误: ${error.message}`));
    this.emit('connectionAdded', websocket);
  }
  _removeConnection(websocket) {
    this.connections.delete(websocket);
    this.logger.warn('[服务器] 内部WebSocket客户端连接断开');
    this.messageQueues.forEach(queue => queue.close());
    this.messageQueues.clear();
    this.emit('connectionRemoved', websocket);
  }
  _handleIncomingMessage(messageData) {
    try {
      const parsedMessage = JSON.parse(messageData);
      const requestId = parsedMessage.request_id;
      if (!requestId) {
        this.logger.warn('[服务器] 收到无效消息：缺少request_id');
        return;
      }
      const queue = this.messageQueues.get(requestId);
      if (queue) {
        this._routeMessage(parsedMessage, queue);
      }
    } catch (error) {
      this.logger.error('[服务器] 解析内部WebSocket消息失败');
    }
  }
  _routeMessage(message, queue) {
    const { event_type } = message;
    switch (event_type) {
      case 'response_headers': case 'chunk': case 'error':
        queue.enqueue(message);
        break;
      case 'stream_close':
        queue.enqueue({ type: 'STREAM_END' });
        break;
      default:
        this.logger.warn(`[服务器] 未知的内部事件类型: ${event_type}`);
    }
  }
  hasActiveConnections() { return this.connections.size > 0; }
  getFirstConnection() { return this.connections.values().next().value; }
  createMessageQueue(requestId) {
    const queue = new MessageQueue();
    this.messageQueues.set(requestId, queue);
    return queue;
  }
  removeMessageQueue(requestId) {
    const queue = this.messageQueues.get(requestId);
    if (queue) {
      queue.close();
      this.messageQueues.delete(requestId);
    }
  }
}

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
    this.isAuthSwitching = false;
    this.fullCycleFailure = false; // 【新增】全循环失败标志
    this.startOfFailureCycleIndex = null; // 【新增】记录失败循环的起始账号
  }

  get currentAuthIndex() {
    return this.browserManager.currentAuthIndex;
  }

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

  async _switchToNextAuth() {
    if (this.isAuthSwitching) {
      this.logger.info('🔄 [认证] 正在切换账号，跳过重复切换');
      return;
    }

    this.isAuthSwitching = true;
    const nextAuthIndex = this._getNextAuthIndex();
    const totalAuthCount = this.authSource.getAvailableIndices().length;

    // 【修改】增加熔断检查逻辑
    if (this.fullCycleFailure) {
        this.logger.error('🔴 [认证] 已检测到全账号循环失败，将暂停自动切换以防止资源过载。请检查所有账号有效性或服务状态。');
        this.isAuthSwitching = false;
        throw new Error('全账号循环失败，自动切换已熔断。');
    }
    
    // 【修改】检查是否完成了一个失败的循环
    if (this.startOfFailureCycleIndex !== null && nextAuthIndex === this.startOfFailureCycleIndex) {
        this.logger.error('🔴 [认证] 已完成一整轮账号切换但问题依旧，触发全循环失败熔断机制！');
        this.fullCycleFailure = true;
    }

    if (nextAuthIndex === null) {
      this.logger.error('🔴 [认证] 无法切换账号，因为没有可用的认证源！');
      this.isAuthSwitching = false;
      throw new Error('没有可用的认证源可以切换。');
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
      // 【修改】切换成功后，重置熔断状态
      this.fullCycleFailure = false;
      this.startOfFailureCycleIndex = null;
      this.logger.info('==================================================');
      this.logger.info(`✅ [认证] 成功切换到账号索引 ${this.currentAuthIndex}`);
      this.logger.info(`✅ [认证] 失败计数已重置为0，熔断机制已重置。`);
      this.logger.info('==================================================');
    } catch (error) {
      this.logger.error('==================================================');
      this.logger.error(`❌ [认证] 切换账号失败: ${error.message}`);
      this.logger.error('==================================================');
      throw error;
    } finally {
      this.isAuthSwitching = false;
    }
  }

  _parseAndCorrectErrorDetails(errorDetails) {
    const correctedDetails = { ...errorDetails };
    this.logger.debug(`[错误解析器] 原始错误详情: status=${correctedDetails.status}, message="${correctedDetails.message}"`);

    if (correctedDetails.message && typeof correctedDetails.message === 'string') {
      const regex = /(?:HTTP|status code)\s+(\d{3})/;
      const match = correctedDetails.message.match(regex);

      if (match && match[1]) {
        const parsedStatus = parseInt(match[1], 10);
        if (parsedStatus >= 400 && parsedStatus <= 599) {
          if (correctedDetails.status !== parsedStatus) {
            this.logger.warn(`[错误解析器] 修正了错误状态码！原始: ${correctedDetails.status}, 从消息中解析得到: ${parsedStatus}`);
            correctedDetails.status = parsedStatus;
          } else {
            this.logger.debug(`[错误解析器] 解析的状态码 (${parsedStatus}) 与原始状态码一致，无需修正。`);
          }
        }
      }
    }
    return correctedDetails;
  }

async _handleRequestFailureAndSwitch(errorDetails, res) {
    // 新增：在调试模式下打印完整的原始错误信息
    if (this.config.debugMode) {
      this.logger.debug(`[认证][调试] 收到来自浏览器的完整错误详情:\n${JSON.stringify(errorDetails, null, 2)}`);
    }

    const correctedDetails = { ...errorDetails };
    if (correctedDetails.message && typeof correctedDetails.message === 'string') {
      const regex = /(?:HTTP|status code)\s*(\d{3})|"code"\s*:\s*(\d{3})/;
      const match = correctedDetails.message.match(regex);
      const parsedStatusString = match ? (match[1] || match[2]) : null;

      if (parsedStatusString) {
        const parsedStatus = parseInt(parsedStatusString, 10);
        if (parsedStatus >= 400 && parsedStatus <= 599 && correctedDetails.status !== parsedStatus) {
          this.logger.warn(`[认证] 修正了错误状态码！原始: ${correctedDetails.status}, 从消息中解析得到: ${parsedStatus}`);
          correctedDetails.status = parsedStatus;
        }
      }
    }

    // 【修改】如果熔断已触发，则不再增加失败计数
    if (this.fullCycleFailure) {
        this.logger.warn('[认证] 熔断已触发，跳过失败计数和切换逻辑。');
        return;
    }
    
    const isImmediateSwitch = this.config.immediateSwitchStatusCodes.includes(correctedDetails.status);

    if (isImmediateSwitch) {
      this.logger.warn(`🔴 [认证] 收到状态码 ${correctedDetails.status} (已修正)，触发立即切换账号...`);
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

      // 【修改】在第一次达到阈值时，记录下当前账号作为循环的起点
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
    } else {
      this.logger.warn(`[认证] 请求失败 (状态码: ${correctedDetails.status})。基于计数的自动切换已禁用 (failureThreshold=0)`);
    }
  }



  _getModelFromRequest(req) {
    let body = req.body;

    if (Buffer.isBuffer(body)) {
      try {
        body = JSON.parse(body.toString('utf-8'));
      } catch (e) { body = {}; }
    } else if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) { body = {}; }
    }

    if (body && typeof body === 'object') {
      if (body.model) return body.model;
      if (body.generation_config && body.generation_config.model) return body.generation_config.model;
    }

    const match = req.path.match(/\/models\/([^/:]+)/);
    if (match && match[1]) {
      return match[1];
    }
    return 'unknown_model';
  }

  async processRequest(req, res) {
    // 关键修复 (V2): 使用 hasOwnProperty 来准确判断 'key' 参数是否存在，
    // 无论其值是空字符串还是有内容。
    if ((!this.config.apiKeys || this.config.apiKeys.length === 0) && req.query && req.query.hasOwnProperty('key')) {
      if (this.config.debugMode) {
        this.logger.debug(`[请求预处理] 服务器API密钥认证已禁用。检测到并移除了来自客户端的 'key' 查询参数 (值为: '${req.query.key}')。`);
      }
      delete req.query.key;
    }

    // 提前获取模型名称和当前账号
    const modelName = this._getModelFromRequest(req);
    const currentAccount = this.currentAuthIndex;

    // 新增的合并日志行，报告路径、账号和模型
    this.logger.info(`[请求] ${req.method} ${req.path} | 账号: ${currentAccount} | 模型: 🤖 ${modelName}`);

    // --- 升级的统计逻辑 ---
    this.serverSystem.stats.totalCalls++;
    if (this.serverSystem.stats.accountCalls[currentAccount]) {
      this.serverSystem.stats.accountCalls[currentAccount].total = (this.serverSystem.stats.accountCalls[currentAccount].total || 0) + 1;
      this.serverSystem.stats.accountCalls[currentAccount].models[modelName] = (this.serverSystem.stats.accountCalls[currentAccount].models[modelName] || 0) + 1;
    } else {
      this.serverSystem.stats.accountCalls[currentAccount] = {
        total: 1,
        models: { [modelName]: 1 }
      };
    }

    if (!this.connectionRegistry.hasActiveConnections()) {
      return this._sendErrorResponse(res, 503, '没有可用的浏览器连接');
    }
    const requestId = this._generateRequestId();
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
    }
  }
  _generateRequestId() { return `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`; }
    _buildProxyRequest(req, requestId) {
    const proxyRequest = {
      path: req.path,
      method: req.method,
      headers: req.headers,
      query_params: req.query,
      request_id: requestId,
      streaming_mode: this.serverSystem.streamingMode
    };

    // 关键修正：只在允许有请求体的HTTP方法中添加body字段
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      let requestBodyString;
      if (typeof req.body === 'object' && req.body !== null) {
        requestBodyString = JSON.stringify(req.body);
      } else if (typeof req.body === 'string') {
        requestBodyString = req.body;
      } else if (Buffer.isBuffer(req.body)) {
        requestBodyString = req.body.toString('utf-8');
      } else {
        requestBodyString = '';
      }
      proxyRequest.body = requestBodyString;
    }

    return proxyRequest;
  }
  _forwardRequest(proxyRequest) {
    const connection = this.connectionRegistry.getFirstConnection();
    if (connection) {
      connection.send(JSON.stringify(proxyRequest));
    } else {
      throw new Error("无法转发请求：没有可用的WebSocket连接。");
    }
  }
  _sendErrorChunkToClient(res, errorMessage) {
    const errorPayload = {
      error: { message: `[代理系统提示] ${errorMessage}`, type: 'proxy_error', code: 'proxy_error' }
    };
    const chunk = `data: ${JSON.stringify(errorPayload)}\n\n`;
    if (res && !res.writableEnded) {
      res.write(chunk);
      this.logger.info(`[请求] 已向客户端发送标准错误信号: ${errorMessage}`);
    }
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
    const originalPath = req.path;
    const isStreamRequest = originalPath.includes(':stream');

    this.logger.info(`[请求] 假流式处理流程启动，路径: "${originalPath}"，判定为: ${isStreamRequest ? '流式请求' : '非流式请求'}`);

    let connectionMaintainer = null;

    if (isStreamRequest) {
      res.status(200).set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      const keepAliveChunk = this._getKeepAliveChunk(req);
      connectionMaintainer = setInterval(() => { if (!res.writableEnded) res.write(keepAliveChunk); }, 2000);
    }

    try {
      let lastMessage, requestFailed = false;
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        this.logger.info(`[请求] 请求尝试 #${attempt}/${this.maxRetries}...`);
        this._forwardRequest(proxyRequest);
        lastMessage = await messageQueue.dequeue();

        if (lastMessage.event_type === 'error' && lastMessage.status >= 400 && lastMessage.status <= 599) {
          const correctedMessage = this._parseAndCorrectErrorDetails(lastMessage);
          await this._handleRequestFailureAndSwitch(correctedMessage, isStreamRequest ? res : null);

          const errorText = `收到 ${correctedMessage.status} 错误。${attempt < this.maxRetries ? `将在 ${this.retryDelay / 1000}秒后重试...` : '已达到最大重试次数。'}`;
          this.logger.warn(`[请求] ${errorText}`);

          if (isStreamRequest) {
            this._sendErrorChunkToClient(res, errorText);
          }

          if (attempt < this.maxRetries) {
            await new Promise(resolve => setTimeout(resolve, this.retryDelay));
            continue;
          }
          requestFailed = true;
        }
        break;
      }

      if (lastMessage.event_type === 'error' || requestFailed) {
        const finalError = this._parseAndCorrectErrorDetails(lastMessage);
        if (!res.headersSent) {
          this._sendErrorResponse(res, finalError.status, `请求失败: ${finalError.message}`);
        } else {
          this._sendErrorChunkToClient(res, `请求最终失败 (状态码: ${finalError.status}): ${finalError.message}`);
        }
        return;
      }

      if (this.failureCount > 0) {
        this.logger.info(`✅ [认证] 请求成功 - 失败计数已从 ${this.failureCount} 重置为 0`);
      }
      this.failureCount = 0;
      this.fullCycleFailure = false;
      this.startOfFailureCycleIndex = null;

      const dataMessage = await messageQueue.dequeue();
      const endMessage = await messageQueue.dequeue();
      if (endMessage.type !== 'STREAM_END') this.logger.warn('[请求] 未收到预期的流结束信号。');

      if (isStreamRequest) {
        if (dataMessage.data) {
          res.write(`data: ${dataMessage.data}\n\n`);
        }
        res.write('data: [DONE]\n\n');
        this.logger.info('[请求] 已将完整响应作为模拟SSE事件发送。');
      } else {
        this.logger.info('[请求] 准备发送 application/json 响应。');
        if (dataMessage.data) {
          try {
            const jsonData = JSON.parse(dataMessage.data);
            res.status(200).json(jsonData);
          } catch (e) {
            this.logger.error(`[请求] 无法将来自浏览器的响应解析为JSON: ${e.message}`);
            this._sendErrorResponse(res, 500, '代理内部错误：无法解析来自后端的响应。');
          }
        } else {
          this._sendErrorResponse(res, 500, '代理内部错误：后端未返回有效数据。');
        }
      }

    } catch (error) {
      this.logger.error(`[请求] 假流式处理期间发生意外错误: ${error.message}`);
      if (!res.headersSent) {
        this._handleRequestError(error, res);
      } else {
        this._sendErrorChunkToClient(res, `处理失败: ${error.message}`);
      }
    } finally {
      if (connectionMaintainer) clearInterval(connectionMaintainer);
      if (!res.writableEnded) res.end();
      this.logger.info('[请求] 假流式响应处理结束。');
    }
  }

  async _handleRealStreamResponse(proxyRequest, messageQueue, res) {
    let headerMessage, requestFailed = false;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      this.logger.info(`[请求] 请求尝试 #${attempt}/${this.maxRetries}...`);
      this._forwardRequest(proxyRequest);
      headerMessage = await messageQueue.dequeue();
      if (headerMessage.event_type === 'error' && headerMessage.status >= 400 && headerMessage.status <= 599) {

        const correctedMessage = this._parseAndCorrectErrorDetails(headerMessage);
        await this._handleRequestFailureAndSwitch(correctedMessage, null);
        this.logger.warn(`[请求] 收到 ${correctedMessage.status} 错误，将在 ${this.retryDelay / 1000}秒后重试...`);

        if (attempt < this.maxRetries) {
          await new Promise(resolve => setTimeout(resolve, this.retryDelay));
          continue;
        }
        requestFailed = true;
      }
      break;
    }
    if (headerMessage.event_type === 'error' || requestFailed) {
      const finalError = this._parseAndCorrectErrorDetails(headerMessage);
      return this._sendErrorResponse(res, finalError.status, finalError.message);
    }
    if (this.failureCount > 0) {
      this.logger.info(`✅ [认证] 请求成功 - 失败计数已从 ${this.failureCount} 重置为 0`);
    }
    this.failureCount = 0;
    this.fullCycleFailure = false;
    this.startOfFailureCycleIndex = null;
    this._setResponseHeaders(res, headerMessage);
    this.logger.info('[请求] 已向客户端发送真实响应头，开始流式传输...');
    try {
      while (true) {
        const dataMessage = await messageQueue.dequeue(30000);
        if (dataMessage.type === 'STREAM_END') { this.logger.info('[请求] 收到流结束信号。'); break; }
        if (dataMessage.data) res.write(dataMessage.data);
      }
    } catch (error) {
      if (error.message !== '队列超时') throw error;
      this.logger.warn('[请求] 真流式响应超时，可能流已正常结束。');
    } finally {
      if (!res.writableEnded) res.end();
      this.logger.info('[请求] 真流式响应连接已关闭。');
    }
  }

  _setResponseHeaders(res, headerMessage) {
    res.status(headerMessage.status || 200);
    const headers = headerMessage.headers || {};
    Object.entries(headers).forEach(([name, value]) => {
      if (name.toLowerCase() !== 'content-length') res.set(name, value);
    });
  }
  _handleRequestError(error, res) {
    if (res.headersSent) {
      this.logger.error(`[请求] 请求处理错误 (头已发送): ${error.message}`);
      if (this.serverSystem.streamingMode === 'fake') this._sendErrorChunkToClient(res, `处理失败: ${error.message}`);
      if (!res.writableEnded) res.end();
    } else {
      this.logger.error(`[请求] 请求处理错误: ${error.message}`);
      const status = error.message.includes('超时') ? 504 : 500;
      this._sendErrorResponse(res, status, `代理错误: ${error.message}`);
    }
  }
  _sendErrorResponse(res, status, message) {
    if (!res.headersSent) res.status(status || 500).type('text/plain').send(message);
  }
}

class ProxyServerSystem extends EventEmitter {
  constructor() {
    super();
    this.logger = new LoggingService('ProxySystem');
    this._loadConfiguration();
    this.streamingMode = this.config.streamingMode;

    // 升级后的统计结构
    this.stats = {
      totalCalls: 0,
      accountCalls: {} // e.g., { "1": { total: 10, models: { "gemini-pro": 5, "gpt-4": 5 } } }
    };

    this.authSource = new AuthSource(this.logger);
    this.browserManager = new BrowserManager(this.logger, this.config, this.authSource);
    this.connectionRegistry = new ConnectionRegistry(this.logger);
    this.requestHandler = new RequestHandler(this, this.connectionRegistry, this.logger, this.browserManager, this.config, this.authSource);

    this.httpServer = null;
    this.wsServer = null;
  }

  _loadConfiguration() {
    let config = {
      httpPort: 8889, host: '0.0.0.0', wsPort: 9998, streamingMode: 'real',
      failureThreshold: 0,
      maxRetries: 3, retryDelay: 2000, browserExecutablePath: null,
      apiKeys: [],
      immediateSwitchStatusCodes: [],
      initialAuthIndex: null,
      debugMode: false,
    };

    const configPath = path.join(__dirname, 'config.json');
    try {
      if (fs.existsSync(configPath)) {
        const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        config = { ...config, ...fileConfig };
        this.logger.info('[系统] 已从 config.json 加载配置。');
      }
    } catch (error) {
      this.logger.warn(`[系统] 无法读取或解析 config.json: ${error.message}`);
    }

    if (process.env.PORT) config.httpPort = parseInt(process.env.PORT, 10) || config.httpPort;
    if (process.env.HOST) config.host = process.env.HOST;
    if (process.env.STREAMING_MODE) config.streamingMode = process.env.STREAMING_MODE;
    if (process.env.FAILURE_THRESHOLD) config.failureThreshold = parseInt(process.env.FAILURE_THRESHOLD, 10) || config.failureThreshold;
    if (process.env.MAX_RETRIES) config.maxRetries = parseInt(process.env.MAX_RETRIES, 10) || config.maxRetries;
    if (process.env.RETRY_DELAY) config.retryDelay = parseInt(process.env.RETRY_DELAY, 10) || config.retryDelay;
    if (process.env.CAMOUFOX_EXECUTABLE_PATH) config.browserExecutablePath = process.env.CAMOUFOX_EXECUTABLE_PATH;
    if (process.env.API_KEYS) {
      config.apiKeys = process.env.API_KEYS.split(',');
    }
    if (process.env.DEBUG_MODE) {
      config.debugMode = process.env.DEBUG_MODE === 'true';
    }
    if (process.env.INITIAL_AUTH_INDEX) {
      const envIndex = parseInt(process.env.INITIAL_AUTH_INDEX, 10);
      if (!isNaN(envIndex) && envIndex > 0) {
        config.initialAuthIndex = envIndex;
      }
    }

    let rawCodes = process.env.IMMEDIATE_SWITCH_STATUS_CODES;
    let codesSource = '环境变量';

    if (!rawCodes && config.immediateSwitchStatusCodes && Array.isArray(config.immediateSwitchStatusCodes)) {
      rawCodes = config.immediateSwitchStatusCodes.join(',');
      codesSource = 'config.json 文件';
    }

    if (rawCodes && typeof rawCodes === 'string') {
      config.immediateSwitchStatusCodes = rawCodes
        .split(',')
        .map(code => parseInt(String(code).trim(), 10))
        .filter(code => !isNaN(code) && code >= 400 && code <= 599);
      if (config.immediateSwitchStatusCodes.length > 0) {
        this.logger.info(`[系统] 已从 ${codesSource} 加载“立即切换状态码”。`);
      }
    } else {
      config.immediateSwitchStatusCodes = [];
    }

    if (Array.isArray(config.apiKeys)) {
      config.apiKeys = config.apiKeys.map(k => String(k).trim()).filter(k => k);
    } else {
      config.apiKeys = [];
    }

    this.config = config;
    this.logger.info('================ [ 生效配置 ] ================');
    this.logger.info(`  HTTP 服务端口: ${this.config.httpPort}`);
    this.logger.info(`  监听地址: ${this.config.host}`);
    this.logger.info(`  流式模式: ${this.config.streamingMode}`);
    this.logger.info(`  调试模式: ${this.config.debugMode ? '已开启' : '已关闭'}`);
    if (this.config.initialAuthIndex) {
      this.logger.info(`  指定初始认证索引: ${this.config.initialAuthIndex}`);
    }
    this.logger.info(`  失败计数切换: ${this.config.failureThreshold > 0 ? `连续 ${this.config.failureThreshold} 次失败后切换` : '已禁用'}`);
    this.logger.info(`  立即切换状态码: ${this.config.immediateSwitchStatusCodes.length > 0 ? this.config.immediateSwitchStatusCodes.join(', ') : '已禁用'}`);
    this.logger.info(`  单次请求最大重试: ${this.config.maxRetries}次`);
    this.logger.info(`  重试间隔: ${this.config.retryDelay}ms`);
    if (this.config.apiKeys && this.config.apiKeys.length > 0) {
      this.logger.info(`  API 密钥认证: 已启用 (${this.config.apiKeys.length} 个密钥)`);
    } else {
      this.logger.info(`  API 密钥认证: 已禁用`);
    }
    this.logger.info('=============================================================');
  }

  async start() {
    try {
      // 初始化统计对象
      this.authSource.getAvailableIndices().forEach(index => {
        this.stats.accountCalls[index] = { total: 0, models: {} };
      });

      let startupIndex = this.authSource.getFirstAvailableIndex();
      const suggestedIndex = this.config.initialAuthIndex;

      if (suggestedIndex) {
        if (this.authSource.getAvailableIndices().includes(suggestedIndex)) {
          this.logger.info(`[系统] 使用配置中指定的有效启动索引: ${suggestedIndex}`);
          startupIndex = suggestedIndex;
        } else {
          this.logger.warn(`[系统] 配置中指定的启动索引 ${suggestedIndex} 无效或不存在，将使用第一个可用索引: ${startupIndex}`);
        }
      } else {
        this.logger.info(`[系统] 未指定启动索引，将自动使用第一个可用索引: ${startupIndex}`);
      }

      await this.browserManager.launchBrowser(startupIndex);
      await this._startHttpServer();
      await this._startWebSocketServer();
      this.logger.info(`[系统] 代理服务器系统启动完成。`);
      this.emit('started');
    } catch (error) {
      this.logger.error(`[系统] 启动失败: ${error.message}`);
      this.emit('error', error);
      process.exit(1); // 启动失败时退出
    }
  }

  _createDebugLogMiddleware() {
    return (req, res, next) => {
      if (!this.config.debugMode) {
        return next();
      }

      const requestId = this.requestHandler._generateRequestId();
      const log = this.logger.info.bind(this.logger);

      log(`\n\n--- [调试] 开始处理入站请求 (${requestId}) ---`);
      log(`[调试][${requestId}] 客户端 IP: ${req.ip}`);
      log(`[调试][${requestId}] 方法: ${req.method}`);
      log(`[调试][${requestId}] URL: ${req.originalUrl}`);
      log(`[调试][${requestId}] 请求头: ${JSON.stringify(req.headers, null, 2)}`);

      let bodyContent = '无或空';
      if (req.body) {
        if (Buffer.isBuffer(req.body) && req.body.length > 0) {
          try {
            bodyContent = JSON.stringify(JSON.parse(req.body.toString('utf-8')), null, 2);
          } catch (e) {
            bodyContent = `[无法解析为JSON的Buffer, 大小: ${req.body.length} 字节]`;
          }
        } else if (typeof req.body === 'object' && Object.keys(req.body).length > 0) {
          bodyContent = JSON.stringify(req.body, null, 2);
        }
      }

      log(`[调试][${requestId}] 请求体:\n${bodyContent}`);
      log(`--- [调试] 结束处理入站请求 (${requestId}) ---\n\n`);

      next();
    };
  }


  _createAuthMiddleware() {
    return (req, res, next) => {
      const serverApiKeys = this.config.apiKeys;
      if (!serverApiKeys || serverApiKeys.length === 0) {
        return next();
      }

      let clientKey = null;
      let keySource = null;

      const headers = req.headers;
      const xGoogApiKey = headers['x-goog-api-key'] || headers['x_goog_api_key'];
      const xApiKey = headers['x-api-key'] || headers['x_api_key'];
      const authHeader = headers.authorization;

      if (xGoogApiKey) {
        clientKey = xGoogApiKey;
        keySource = 'x-goog-api-key 请求头';
      } else if (authHeader && authHeader.startsWith('Bearer ')) {
        clientKey = authHeader.substring(7);
        keySource = 'Authorization 请求头';
      } else if (xApiKey) {
        clientKey = xApiKey;
        keySource = 'X-API-Key 请求头';
      } else if (req.query.key) {
        clientKey = req.query.key;
        keySource = '查询参数';
      }

      if (clientKey) {
        if (serverApiKeys.includes(clientKey)) {
          if (this.config.debugMode) {
            this.logger.debug(`[认证][调试] 在 '${keySource}' 中找到API密钥，验证通过。`);
          }
          if (keySource === '查询参数') {
            delete req.query.key;
          }
          return next();
        } else {
          if (this.config.debugMode) {
            this.logger.warn(`[认证][调试] 拒绝请求: 无效的API密钥。IP: ${req.ip}, 路径: ${req.path}`);
            this.logger.debug(`[认证][调试] 来源: ${keySource}`);
            this.logger.debug(`[认证][调试] 提供的错误密钥: '${clientKey}'`);
            this.logger.debug(`[认证][调试] 已加载的有效密钥: [${serverApiKeys.join(', ')}]`);
          } else {
            this.logger.warn(`[认证] 拒绝请求: 无效的API密钥。IP: ${req.ip}, 路径: ${req.path}`);
          }
          return res.status(401).json({ error: { message: "提供了无效的API密钥。" } });
        }
      }

      this.logger.warn(`[认证] 拒绝受保护的请求: 缺少API密钥。IP: ${req.ip}, 路径: ${req.path}`);

      if (this.config.debugMode) {
        this.logger.debug(`[认证][调试] 未在任何标准位置找到API密钥。`);
        this.logger.debug(`[认证][调试] 搜索的请求头: ${JSON.stringify(headers, null, 2)}`);
        this.logger.debug(`[认证][调试] 搜索的查询参数: ${JSON.stringify(req.query)}`);
        this.logger.debug(`[认证][调试] 已加载的有效密钥: [${serverApiKeys.join(', ')}]`);
      }

      return res.status(401).json({ error: { message: "访问被拒绝。未在请求头或查询参数中找到有效的API密钥。" } });
    };
  }

  async _startHttpServer() {
    const app = this._createExpressApp();
    this.httpServer = http.createServer(app);
    return new Promise((resolve) => {
      this.httpServer.listen(this.config.httpPort, this.config.host, () => {
        this.logger.info(`[系统] HTTP服务器已在 http://${this.config.host}:${this.config.httpPort} 上监听`);
        this.logger.info(`[系统] 仪表盘可在 http://${this.config.host}:${this.config.httpPort}/dashboard 访问`);
        resolve();
      });
    });
  }

    _createExpressApp() {
    const app = express();
    app.use(express.json({ limit: '100mb' }));
    app.use(express.raw({ type: '*/*', limit: '100mb' }));
    app.use((req, res, next) => {
      if (req.is('application/json') && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
        // Already parsed correctly by express.json()
      } else if (Buffer.isBuffer(req.body)) {
        const bodyStr = req.body.toString('utf-8');
        if (bodyStr) {
          try {
            req.body = JSON.parse(bodyStr);
          } catch (e) {
            // Not JSON, leave as buffer.
          }
        }
      }
      next();
    });

    app.use(this._createDebugLogMiddleware());

    // --- 仪表盘和API端点 ---

    // 新增: 将根目录重定向到仪表盘
    app.get('/', (req, res) => {
        res.redirect('/dashboard');
    });

    // 公开端点：提供仪表盘HTML
    app.get('/dashboard', (req, res) => {
      res.send(this._getDashboardHtml());
    });

    // 公开端点：用于仪表盘验证API密钥
    app.post('/dashboard/verify-key', (req, res) => {
      const { key } = req.body;
      const serverApiKeys = this.config.apiKeys;

      if (!serverApiKeys || serverApiKeys.length === 0) {
        this.logger.info('[管理] 服务器未配置API密钥，自动授予仪表盘访问权限。');
        return res.json({ success: true });
      }

      if (key && serverApiKeys.includes(key)) {
        this.logger.info('[管理] 仪表盘API密钥验证成功。');
        return res.json({ success: true });
      }

      this.logger.warn(`[管理] 仪表盘API密钥验证失败。`);
      res.status(401).json({ success: false, message: '无效的API密钥。' });
    });

    // 中间件：保护仪表盘API路由
    const dashboardApiAuth = (req, res, next) => {
      const serverApiKeys = this.config.apiKeys;
      if (!serverApiKeys || serverApiKeys.length === 0) {
        return next(); // 未配置密钥，跳过认证
      }

      const clientKey = req.headers['x-dashboard-auth'];
      if (clientKey && serverApiKeys.includes(clientKey)) {
        return next();
      }

      this.logger.warn(`[管理] 拒绝未经授权的仪表盘API请求。IP: ${req.ip}, 路径: ${req.path}`);
      res.status(401).json({ error: { message: 'Unauthorized dashboard access' } });
    };

    const dashboardApiRouter = express.Router();
    dashboardApiRouter.use(dashboardApiAuth);

    dashboardApiRouter.get('/data', (req, res) => {
      res.json({
        status: {
          uptime: process.uptime(),
          streamingMode: this.streamingMode,
          debugMode: this.config.debugMode,
          authMode: this.authSource.authMode,
          apiKeyAuth: (this.config.apiKeys && this.config.apiKeys.length > 0) ? '已启用' : '已禁用',
          isAuthSwitching: this.requestHandler.isAuthSwitching,
          browserConnected: !!this.browserManager.browser,
          internalWsClients: this.connectionRegistry.connections.size
        },
        auth: {
          currentAuthIndex: this.requestHandler.currentAuthIndex,
          accounts: this.authSource.getAccountDetails(),
          failureCount: this.requestHandler.failureCount,
        },
        stats: this.stats,
        config: this.config
      });
    });

    dashboardApiRouter.post('/config', (req, res) => {
      const newConfig = req.body;
      try {
        if (newConfig.hasOwnProperty('streamingMode') && ['real', 'fake'].includes(newConfig.streamingMode)) {
          this.config.streamingMode = newConfig.streamingMode;
          this.streamingMode = newConfig.streamingMode;
          this.requestHandler.serverSystem.streamingMode = newConfig.streamingMode;
        }
        if (newConfig.hasOwnProperty('debugMode') && typeof newConfig.debugMode === 'boolean') {
          this.config.debugMode = newConfig.debugMode;
        }
        if (newConfig.hasOwnProperty('failureThreshold')) {
          this.config.failureThreshold = parseInt(newConfig.failureThreshold, 10) || 0;
        }
        if (newConfig.hasOwnProperty('maxRetries')) {
          const retries = parseInt(newConfig.maxRetries, 10);
          this.config.maxRetries = retries >= 0 ? retries : 3;
          this.requestHandler.maxRetries = this.config.maxRetries;
        }
        if (newConfig.hasOwnProperty('retryDelay')) {
          this.config.retryDelay = parseInt(newConfig.retryDelay, 10) || 2000;
          this.requestHandler.retryDelay = this.config.retryDelay;
        }
        if (newConfig.hasOwnProperty('immediateSwitchStatusCodes')) {
          if (Array.isArray(newConfig.immediateSwitchStatusCodes)) {
            this.config.immediateSwitchStatusCodes = newConfig.immediateSwitchStatusCodes
              .map(c => parseInt(c, 10))
              .filter(c => !isNaN(c));
          }
        }
        this.logger.info('[管理] 配置已通过仪表盘动态更新。');
        res.status(200).json({ success: true, message: '配置已临时更新。' });
      } catch (error) {
        this.logger.error(`[管理] 更新配置失败: ${error.message}`);
        res.status(500).json({ success: false, message: error.message });
      }
    });

    dashboardApiRouter.post('/accounts', (req, res) => {
      const { index, authData } = req.body;
      if (!index || !authData) {
        return res.status(400).json({ success: false, message: "必须提供索引和认证数据。" });
      }

      let parsedData;
      try {
        parsedData = (typeof authData === 'string') ? JSON.parse(authData) : authData;
      } catch (e) {
        return res.status(400).json({ success: false, message: "认证数据的JSON格式无效。" });
      }

      const result = this.authSource.addAccount(parseInt(index, 10), parsedData);
      if (result.success) {
        if (!this.stats.accountCalls.hasOwnProperty(index)) {
          this.stats.accountCalls[index] = { total: 0, models: {} };
        }
      }
      res.status(result.success ? 200 : 400).json(result);
    });

    dashboardApiRouter.delete('/accounts/:index', (req, res) => {
      const index = parseInt(req.params.index, 10);
      const result = this.authSource.removeAccount(index);
      res.status(result.success ? 200 : 400).json(result);
    });

    // 挂载受保护的仪表盘API路由
    app.use('/dashboard', dashboardApiRouter);

    // 保护 /switch 路由
    app.post('/switch', dashboardApiAuth, async (req, res) => {
      this.logger.info('[管理] 接到 /switch 请求，手动触发账号切换。');
      if (this.requestHandler.isAuthSwitching) {
        const msg = '账号切换已在进行中，请稍后。';
        this.logger.warn(`[管理] /switch 请求被拒绝: ${msg}`);
        return res.status(429).send(msg);
      }
      const oldIndex = this.requestHandler.currentAuthIndex;
      try {
        await this.requestHandler._switchToNextAuth();
        const newIndex = this.requestHandler.currentAuthIndex;
        const message = `成功将账号从索引 ${oldIndex} 切换到 ${newIndex}。`;
        this.logger.info(`[管理] 手动切换成功。 ${message}`);
        res.status(200).send(message);
      } catch (error) {
        const errorMessage = `切换账号失败: ${error.message}`;
        this.logger.error(`[管理] 手动切换失败。错误: ${errorMessage}`);
        res.status(500).send(errorMessage);
      }
    });

    app.get('/health', (req, res) => {
      res.status(200).json({
        status: 'healthy',
        uptime: process.uptime(),
        config: {
          streamingMode: this.streamingMode,
          debugMode: this.config.debugMode,
          failureThreshold: this.config.failureThreshold,
          immediateSwitchStatusCodes: this.config.immediateSwitchStatusCodes,
          maxRetries: this.config.maxRetries,
          authMode: this.authSource.authMode,
          apiKeyAuth: (this.config.apiKeys && this.config.apiKeys.length > 0) ? '已启用' : '已禁用',
        },
        auth: {
          currentAuthIndex: this.requestHandler.currentAuthIndex,
          availableIndices: this.authSource.getAvailableIndices(),
          totalAuthSources: this.authSource.getAvailableIndices().length,
          failureCount: this.requestHandler.failureCount,
          isAuthSwitching: this.requestHandler.isAuthSwitching,
        },
        stats: this.stats,
        browser: {
          connected: !!this.browserManager.browser,
        },
        websocket: {
          internalClients: this.connectionRegistry.connections.size
        }
      });
    });

    // 主API代理
    app.use(this._createAuthMiddleware());
    app.all(/(.*)/, (req, res) => {
      // 修改: 增加对根路径的判断，防止其被代理
      if (req.path === '/' || req.path === '/favicon.ico' || req.path.startsWith('/dashboard')) {
        return res.status(204).send();
      }
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
    <title>服务器仪表盘</title>
    <style>
        :root {
            --pico-font-size: 16px;
            --pico-background-color: #11191f;
            --pico-color: #dce3e9;
            --pico-card-background-color: #1a242c;
            --pico-card-border-color: #2b3a47;
            --pico-primary: #3d8bfd;
            --pico-primary-hover: #529bff;
            --pico-primary-focus: rgba(61, 139, 253, 0.25);
            --pico-primary-inverse: #fff;
            --pico-form-element-background-color: #1a242c;
            --pico-form-element-border-color: #2b3a47;
            --pico-form-element-focus-color: var(--pico-primary);
            --pico-h1-color: #fff;
            --pico-h2-color: #f1f1f1;
            --pico-muted-color: #7a8c99;
            --pico-border-radius: 0.5rem;
            --info-color: #17a2b8; /* 天蓝色，用于状态文本 */
        }
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol"; margin: 0; padding: 2rem; background-color: var(--pico-background-color); color: var(--pico-color); }
        main.container { max-width: 1200px; margin: 0 auto; padding-top: 30px; display: none; /* Initially hidden */ }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(350px, 1fr)); gap: 1.5rem; }
        article { border: 1px solid var(--pico-card-border-color); border-radius: var(--pico-border-radius); padding: 1.5rem; background: var(--pico-card-background-color); }
        h1, h2 { margin-top: 0; color: var(--pico-h1-color); }
        h2 { border-bottom: 1px solid var(--pico-card-border-color); padding-bottom: 0.5rem; margin-bottom: 1rem; color: var(--pico-h2-color); }
        .status-grid { display: grid; grid-template-columns: auto 1fr; gap: 0.5rem 1rem; align-items: center;}
        .status-grid strong { color: var(--pico-color); white-space: nowrap;}
        .status-grid span { color: var(--pico-muted-color); text-align: right; }
        .status-text-info { color: var(--info-color); font-weight: bold; }
        .status-text-red { color: #dc3545; font-weight: bold; }
        .status-text-yellow { color: #ffc107; font-weight: bold; }
        .status-text-gray { color: var(--pico-muted-color); font-weight: bold; }
        .tag { display: inline-block; padding: 0.25em 0.6em; font-size: 0.75em; font-weight: 700; line-height: 1; text-align: center; white-space: nowrap; vertical-align: baseline; border-radius: 0.35rem; color: #fff; }
        .tag-info { background-color: #17a2b8; }
        .tag-blue { background-color: #007bff; }
        .tag-yellow { color: #212529; background-color: #ffc107; }
        ul { list-style: none; padding: 0; margin: 0; }
        .scrollable-list { max-height: 220px; overflow-y: auto; padding-right: 5px; border: 1px solid var(--pico-form-element-border-color); border-radius: 0.25rem; padding: 0.5rem;}
        .account-list li { display: flex; justify-content: space-between; align-items: center; padding: 0.5rem; border-radius: 0.25rem; }
        .account-list li:nth-child(odd) { background-color: rgba(255,255,255,0.03); }
        .account-list .current { font-weight: bold; color: var(--pico-primary); }
        details { width: 100%; border-bottom: 1px solid var(--pico-form-element-border-color); }
        details:last-child { border-bottom: none; }
        details summary { cursor: pointer; display: flex; justify-content: space-between; align-items: center; padding: 0.5rem 0.2rem; list-style: none; }
        details summary::-webkit-details-marker { display: none; }
        details summary:hover { background-color: rgba(255,255,255,0.05); }
        .model-stats-list { padding: 0.5rem 0 0.5rem 1.5rem; font-size: 0.9em; background-color: rgba(0,0,0,0.1); }
        .model-stats-list li { display: flex; justify-content: space-between; padding: 0.2rem; }
        button, input[type="text"], input[type="number"] { background-color: var(--pico-form-element-background-color); border: 1px solid var(--pico-form-element-border-color); color: var(--pico-color); padding: 0.5rem 1rem; border-radius: var(--pico-border-radius); }
        button { cursor: pointer; background-color: var(--pico-primary); border-color: var(--pico-primary); color: var(--pico-primary-inverse); }
        button:hover { background-color: var(--pico-primary-hover); }
        .btn-danger { background-color: #dc3545; border-color: #dc3545; }
        .btn-sm { font-size: 0.8em; padding: 0.2rem 0.5rem; }
        .top-banner { position: fixed; top: 0; right: 0; background-color: #ffc107; color: #212529; padding: 5px 15px; font-size: 0.9em; z-index: 1001; border-bottom-left-radius: 0.5rem; }
        .toast { position: fixed; bottom: 20px; right: 20px; background-color: var(--pico-primary); color: white; padding: 15px; border-radius: 5px; z-index: 1000; opacity: 0; transition: opacity 0.5s; }
        .toast.show { opacity: 1; }
        .toast.error { background-color: #dc3545; }
        form label { display: block; margin-bottom: 0.5rem; }
        form input { width: 100%; box-sizing: border-box; }
        .form-group { margin-bottom: 1rem; }
        .switch-field { display: flex; overflow: hidden; }
        .switch-field input { position: absolute !important; clip: rect(0, 0, 0, 0); height: 1px; width: 1px; border: 0; overflow: hidden; }
        .switch-field label { background-color: var(--pico-form-element-background-color); color: var(--pico-muted-color); font-size: 14px; line-height: 1; text-align: center; padding: 8px 16px; margin-right: -1px; border: 1px solid var(--pico-form-element-border-color); transition: all 0.1s ease-in-out; width: 50%; }
        .switch-field label:hover { cursor: pointer; }
        .switch-field input:checked + label { background-color: var(--pico-primary); color: var(--pico-primary-inverse); box-shadow: none; }
        .switch-field label:first-of-type { border-radius: 4px 0 0 4px; }
        .switch-field label:last-of-type { border-radius: 0 4px 4px 0; }
    </style>
</head>
<body data-theme="dark">
    <div class="top-banner">注意: 此面板中添加的账号和修改的变量均是临时的，重启后会丢失</div>
    <main class="container">
        <h1>🐢 服务器仪表盘</h1>
        <div class="grid">
            <article>
                <h2>服务器状态</h2>
                <div class="status-grid">
                    <strong>运行时间:</strong> <span id="uptime">--</span>
                    <strong>浏览器:</strong> <span id="browserConnected">--</span>
                    <strong>认证模式:</strong> <span id="authMode">--</span>
                    <strong>API密钥认证:</strong> <span id="apiKeyAuth">--</span>
                    <strong>调试模式:</strong> <span id="debugMode">--</span>
                    <strong>API总调用次数:</strong> <span id="totalCalls">0</span>
                </div>
            </article>
            <article>
                <h2>调用统计</h2>
                <div id="accountCalls" class="scrollable-list"></div>
            </article>
            
            <article>
                <h2>账号管理</h2>
                <div style="display: flex; gap: 1rem; margin-bottom: 1rem;">
                    <button id="switchAccountBtn">切换到下一个账号</button>
                    <button id="addAccountBtn">添加临时账号</button>
                </div>
                <h3>账号池</h3>
                <div id="accountPool" class="scrollable-list"></div>
            </article>
            
            <article>
                <h2>实时配置</h2>
                <form id="configForm">
                    <div class="form-group">
                      <label>流式模式</label>
                      <div class="switch-field">
                        <input type="radio" id="streamingMode_fake" name="streamingMode" value="fake" />
                        <label for="streamingMode_fake">Fake</label>
                        <input type="radio" id="streamingMode_real" name="streamingMode" value="real" checked/>
                        <label for="streamingMode_real">Real</label>
                      </div>
                    </div>

                    <div class="form-group">
                        <label for="configFailureThreshold">几次失败后切换账号 (0为禁用)</label>
                        <input type="number" id="configFailureThreshold" name="failureThreshold">
                    </div>
                    
                    <div class="form-group">
                        <label for="configMaxRetries">单次请求内部重试次数</label>
                        <input type="number" id="configMaxRetries" name="maxRetries">
                    </div>
                    
                    <div class="form-group">
                        <label for="configRetryDelay">重试间隔 (毫秒)</label>
                        <input type="number" id="configRetryDelay" name="retryDelay">
                    </div>

                    <div class="form-group">
                        <label for="configImmediateSwitchStatusCodes">立即切换的状态码 (逗号分隔)</label>
                        <input type="text" id="configImmediateSwitchStatusCodes" name="immediateSwitchStatusCodes">
                    </div>
                    
                    <button type="submit">应用临时更改</button>
                </form>
            </article>
        </div>
    </main>
    <div id="toast" class="toast"></div>
    <script>
        document.addEventListener('DOMContentLoaded', () => {
            const API_KEY_SESSION_STORAGE = 'dashboard_api_key';
            const API_BASE = '/dashboard';

            // DOM Elements
            const mainContainer = document.querySelector('main.container');
            const uptimeEl = document.getElementById('uptime');
            const debugModeEl = document.getElementById('debugMode');
            const browserConnectedEl = document.getElementById('browserConnected');
            const authModeEl = document.getElementById('authMode');
            const apiKeyAuthEl = document.getElementById('apiKeyAuth');
            const totalCallsEl = document.getElementById('totalCalls');
            const accountCallsEl = document.getElementById('accountCalls');
            const accountPoolEl = document.getElementById('accountPool');
            const switchAccountBtn = document.getElementById('switchAccountBtn');
            const addAccountBtn = document.getElementById('addAccountBtn');
            const configForm = document.getElementById('configForm');
            const toastEl = document.getElementById('toast');

            function getAuthHeaders(hasBody = false) {
                const headers = {
                    'X-Dashboard-Auth': sessionStorage.getItem(API_KEY_SESSION_STORAGE) || ''
                };
                if (hasBody) {
                    headers['Content-Type'] = 'application/json';
                }
                return headers;
            }

            function showToast(message, isError = false) {
                toastEl.textContent = message;
                toastEl.className = isError ? 'toast show error' : 'toast show';
                setTimeout(() => { toastEl.className = 'toast'; }, 3000);
            }

            function formatUptime(seconds) {
                const d = Math.floor(seconds / (3600*24));
                const h = Math.floor(seconds % (3600*24) / 3600);
                const m = Math.floor(seconds % 3600 / 60);
                const s = Math.floor(seconds % 60);
                return \`\${d}天 \${h}小时 \${m}分钟 \${s}秒\`;
            }

            function handleAuthFailure() {
                sessionStorage.removeItem(API_KEY_SESSION_STORAGE);
                mainContainer.style.display = 'none';
                document.body.insertAdjacentHTML('afterbegin', '<h1>认证已过期或无效，请刷新页面重试。</h1>');
                showToast('认证失败', true);
            }

            async function fetchData() {
                try {
                    const response = await fetch(\`\${API_BASE}/data\`, { headers: getAuthHeaders() });
                    if (response.status === 401) return handleAuthFailure();
                    if (!response.ok) throw new Error('获取数据失败');
                    const data = await response.json();
                    
                    uptimeEl.textContent = formatUptime(data.status.uptime);
                    browserConnectedEl.innerHTML = data.status.browserConnected ? '<span class="status-text-info">已连接</span>' : '<span class="status-text-red">已断开</span>';
                    authModeEl.innerHTML = data.status.authMode === 'env' ? '<span class="status-text-info">环境变量</span>' : '<span class="status-text-info">Cookie文件</span>';
                    apiKeyAuthEl.innerHTML = data.status.apiKeyAuth === '已启用' ? '<span class="status-text-info">已启用</span>' : '<span class="status-text-gray">已禁用</span>';
                    debugModeEl.innerHTML = data.status.debugMode ? '<span class="status-text-yellow">已启用</span>' : '<span class="status-text-gray">已禁用</span>';
                    totalCallsEl.textContent = data.stats.totalCalls;
                    
                    accountCallsEl.innerHTML = '';
                    const sortedAccounts = Object.entries(data.stats.accountCalls).sort((a,b) => parseInt(a[0]) - parseInt(b[0]));
                    const callsUl = document.createElement('ul');
                    callsUl.className = 'account-list';
                    for (const [index, stats] of sortedAccounts) {
                        const li = document.createElement('li');
                        const isCurrent = parseInt(index, 10) === data.auth.currentAuthIndex;
                        let modelStatsHtml = '<ul class="model-stats-list">';
                        const sortedModels = Object.entries(stats.models).sort((a,b) => b[1] - a[1]);
                        sortedModels.length > 0 ? sortedModels.forEach(([model, count]) => { modelStatsHtml += \`<li><span>\${model}:</span> <strong>\${count}</strong></li>\`; }) : modelStatsHtml += '<li>无模型调用记录</li>';
                        modelStatsHtml += '</ul>';
                        li.innerHTML = \`<details><summary><span class="\${isCurrent ? 'current' : ''}">账号 \${index}</span><strong>总计: \${stats.total}</strong></summary>\${modelStatsHtml}</details>\`;
                        if(isCurrent) { li.querySelector('summary').style.color = 'var(--pico-primary)'; }
                        callsUl.appendChild(li);
                    }
                    accountCallsEl.appendChild(callsUl);

                    accountPoolEl.innerHTML = '';
                    const poolUl = document.createElement('ul');
                    poolUl.className = 'account-list';
                    data.auth.accounts.forEach(acc => {
                        const li = document.createElement('li');
                        const isCurrent = acc.index === data.auth.currentAuthIndex;
                        const sourceTag = acc.source === 'temporary' ? '<span class="tag tag-yellow">临时</span>' : (acc.source === 'env' ? '<span class="tag tag-info">变量</span>' : '<span class="tag tag-blue">文件</span>');
                        let html = \`<span class="\${isCurrent ? 'current' : ''}">账号 \${acc.index} \${sourceTag}</span>\`;
                        if (acc.source === 'temporary') { html += \`<button class="btn-danger btn-sm" data-index="\${acc.index}">删除</button>\`; } else { html += '<span></span>'; }
                        li.innerHTML = html;
                        poolUl.appendChild(li);
                    });
                    accountPoolEl.appendChild(poolUl);
                    
                    const streamingModeInput = document.querySelector(\`input[name="streamingMode"][value="\${data.config.streamingMode}"]\`);
                    if(streamingModeInput) streamingModeInput.checked = true;
                    configForm.failureThreshold.value = data.config.failureThreshold;
                    configForm.maxRetries.value = data.config.maxRetries;
                    configForm.retryDelay.value = data.config.retryDelay;
                    configForm.immediateSwitchStatusCodes.value = data.config.immediateSwitchStatusCodes.join(', ');
                } catch (error) {
                    console.error('获取数据时出错:', error);
                    showToast(error.message, true);
                }
            }

            function initializeDashboardListeners() {
                switchAccountBtn.addEventListener('click', async () => {
                    switchAccountBtn.disabled = true;
                    switchAccountBtn.textContent = '切换中...';
                    try {
                        const response = await fetch('/switch', { method: 'POST', headers: getAuthHeaders() });
                        const text = await response.text();
                        if (!response.ok) throw new Error(text);
                        showToast(text);
                        await fetchData();
                    } catch (error) {
                        showToast(error.message, true);
                    } finally {
                        switchAccountBtn.disabled = false;
                        switchAccountBtn.textContent = '切换到下一个账号';
                    }
                });
            
                addAccountBtn.addEventListener('click', () => {
                    const index = prompt("为新的临时账号输入一个唯一的数字索引：");
                    if (!index || isNaN(parseInt(index))) { if(index !== null) alert("索引无效。"); return; }
                    const authDataStr = prompt("请输入单行压缩后的Cookie内容:");
                    if (!authDataStr) return;
                    let authData;
                    try { authData = JSON.parse(authDataStr); } catch(e) { alert("Cookie JSON格式无效。"); return; }
                    
                    fetch(\`\${API_BASE}/accounts\`, { method: 'POST', headers: getAuthHeaders(true), body: JSON.stringify({ index: parseInt(index), authData }) })
                        .then(res => res.json().then(data => ({ ok: res.ok, data }))).then(({ok, data}) => {
                        if (!ok) throw new Error(data.message);
                        showToast(data.message); fetchData(); }).catch(err => showToast(err.message, true));
                });
            
                accountPoolEl.addEventListener('click', e => {
                    if (e.target.matches('button.btn-danger')) {
                        const index = e.target.dataset.index;
                        if (confirm(\`您确定要删除临时账号 \${index} 吗？\`)) {
                            fetch(\`\${API_BASE}/accounts/\${index}\`, { method: 'DELETE', headers: getAuthHeaders() })
                                .then(res => res.json().then(data => ({ ok: res.ok, data }))).then(({ok, data}) => {
                                if (!ok) throw new Error(data.message);
                                showToast(data.message); fetchData(); }).catch(err => showToast(err.message, true));
                        }
                    }
                });

                configForm.addEventListener('submit', e => {
                    e.preventDefault();
                    const formData = new FormData(configForm);
                    const data = Object.fromEntries(formData.entries());
                    data.immediateSwitchStatusCodes = data.immediateSwitchStatusCodes.split(',').map(s => s.trim()).filter(Boolean);
                    fetch(\`\${API_BASE}/config\`, { method: 'POST', headers: getAuthHeaders(true), body: JSON.stringify(data) })
                        .then(res => res.json().then(data => ({ ok: res.ok, data }))).then(({ok, data}) => {
                        if (!ok) throw new Error(data.message);
                        showToast('配置已应用。'); fetchData(); }).catch(err => showToast(err.message, true));
                });

                configForm.addEventListener('change', e => {
                    if (e.target.name === 'streamingMode') {
                        fetch(\`\${API_BASE}/config\`, { method: 'POST', headers: getAuthHeaders(true), body: JSON.stringify({ streamingMode: e.target.value }) })
                            .then(res => res.json().then(d => ({ ok: res.ok, data: d }))).then(({ok, data}) => {
                            if (!ok) throw new Error(data.message);
                            showToast(\`流式模式已更新为: \${e.target.value.charAt(0).toUpperCase() + e.target.value.slice(1)}\`);
                            }).catch(err => showToast(err.message, true));
                    }
                });
            }

            async function verifyAndLoad(keyToVerify) {
                try {
                    const response = await fetch(\`\${API_BASE}/verify-key\`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ key: keyToVerify || '' })
                    });
                    const result = await response.json();
                    
                    if (response.ok && result.success) {
                        if (keyToVerify) {
                           sessionStorage.setItem(API_KEY_SESSION_STORAGE, keyToVerify);
                        }
                        mainContainer.style.display = 'block';
                        initializeDashboardListeners();
                        fetchData();
                        setInterval(fetchData, 5000);
                        return true;
                    } else {
                        sessionStorage.removeItem(API_KEY_SESSION_STORAGE);
                        return false;
                    }
                } catch (err) {
                    document.body.innerHTML = \`<h1>认证时发生错误: \${err.message}</h1>\`;
                    return false;
                }
            }

            async function checkAndInitiate() {
                const storedApiKey = sessionStorage.getItem(API_KEY_SESSION_STORAGE);
                
                // 尝试使用已存储的密钥或空密钥进行验证
                const initialCheckSuccess = await verifyAndLoad(storedApiKey);

                // 如果初次验证失败，说明服务器需要密钥，而我们没有提供或提供了错误的密钥
                if (!initialCheckSuccess) {
                    const newApiKey = prompt("请输入API密钥以访问仪表盘 (服务器需要认证):");
                    if (newApiKey) {
                        // 使用用户新输入的密钥再次尝试
                        const secondCheckSuccess = await verifyAndLoad(newApiKey);
                        if (!secondCheckSuccess) {
                           document.body.innerHTML = \`<h1>认证失败: 无效的API密钥</h1>\`;
                        }
                    } else {
                        // 用户取消了输入
                        document.body.innerHTML = '<h1>访问被拒绝</h1>';
                    }
                }
            }
            
            checkAndInitiate();
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
