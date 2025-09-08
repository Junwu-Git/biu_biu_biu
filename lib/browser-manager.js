const fs = require('fs');
const path = require('path');
const os = require('os');
const { firefox } = require('playwright');

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
    this.isClosing = false;

    this.logger.info('[系统] BrowserManager 已初始化。');
  }

  // 自定义错误类型，用于清晰地标识启动中断
  BrowserLaunchInterruptedError = class extends Error {
    constructor(message) {
      super(message);
      this.name = 'BrowserLaunchInterruptedError';
    }
  };

  // 包装器，用于保护异步操作免受中断影响
  async _interruptible(action) {
    if (this.isClosing) {
      this.logger.info('[浏览器] 操作由于启动中断而被跳过。');
      throw new this.BrowserLaunchInterruptedError('启动被中断');
    }
    try {
      return await action();
    } catch (error) {
      if (this.isClosing) {
        throw new this.BrowserLaunchInterruptedError(`操作在执行期间被中断: ${error.message}`);
      }
      throw error; // 非中断相关的错误，重新抛出
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
    this.logger.info('==================================================');

    const storageStateObject = await this.authSource.getAuth(authIndex);
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
      const scriptFilePath = path.join(__dirname, '..', this.scriptFileName);
      if (fs.existsSync(scriptFilePath)) {
        buildScriptContent = fs.readFileSync(scriptFilePath, 'utf-8');
        this.logger.info(`✅ [浏览器] 成功读取注入脚本 "${this.scriptFileName}"`);
      } else {
        this.logger.warn(`[浏览器] 未找到注入脚本 "${this.scriptFileName}"。将无注入继续运行。`);
        buildScriptContent = "console.log('dark-browser.js not found, running without injection.');";
      }
    } catch (error) {
      this.logger.error(`❌ [浏览器] 无法读取注入脚本 "${this.scriptFileName}"！`, error);
      throw error;
    }

    try {
      const camoufoxPath = process.env.CAMOUFOX_EXECUTABLE_PATH;
      if (!camoufoxPath) {
        const errorMessage = '❌ [浏览器] 致命错误: 环境变量 CAMOUFOX_EXECUTABLE_PATH 未设置。此应用被配置为必须使用 Camoufox 浏览器。';
        this.logger.error(errorMessage);
        throw new Error(errorMessage);
      }
      
      this.logger.info(`[浏览器] 将使用指定的 Camoufox 浏览器: ${camoufoxPath}`);

      const launchOptions = {
        headless: true,
        args: ['--disable-gpu', '--no-sandbox'],
        executablePath: camoufoxPath,
      };

      this.browser = await this._interruptible(() => firefox.launch(launchOptions));

      this.browser.on('disconnected', () => {
        if (this.isClosing) {
          this.logger.info('[浏览器] 浏览器实例已按预期关闭。');
        } else {
          this.logger.error('❌ [浏览器] 浏览器意外断开连接！服务器可能需要重启。');
        }
        this.browser = null; this.context = null; this.page = null;
      });

      this.context = await this._interruptible(() => this.browser.newContext({
        storageState: storageStateObject,
        viewport: { width: 1280, height: 720 },
      }));

      this.page = await this._interruptible(() => this.context.newPage());
      this.logger.info(`[浏览器] 正在加载账号 ${authIndex} 并访问目标网页...`);
      const targetUrl = this.config.automationTargets.targetUrl;
      const debugFolder = path.resolve(__dirname, '..', 'debug-screenshots');
      if (!fs.existsSync(debugFolder)) {
        fs.mkdirSync(debugFolder, { recursive: true });
      }

      let pageLoadedSuccessfully = false;
      const maxNavRetries = 3;
      for (let attempt = 1; attempt <= maxNavRetries; attempt++) {
        try {
          this.logger.info(`[浏览器] 页面加载尝试 #${attempt}/${maxNavRetries}...`);
          await this._interruptible(() => this.page.goto(targetUrl, { timeout: 120000, waitUntil: 'networkidle' }));

          const internalErrorLocator = this.page.locator('text=An internal error occurred');
          const isVisible = await this._interruptible(() => internalErrorLocator.isVisible({ timeout: 5000 }).catch(() => false));
          if (isVisible) {
            throw new Error('"An internal error occurred"，视为加载失败');
          }

          pageLoadedSuccessfully = true;
          this.logger.info('[浏览器] 网页加载成功，且内容正确。');

          if (this.config.debugMode) {
            const successPath = path.join(debugFolder, `success-load-${authIndex}-${new Date().toISOString().replace(/:/g, '-')}.png`);
            await this._interruptible(() => this.page.screenshot({ path: successPath, fullPage: true }));
            this.logger.info(`[调试] 成功加载的页面截图已保存: ${successPath}`);
          }
          break;
        } catch (error) {
          if (error instanceof this.BrowserLaunchInterruptedError) throw error;

          this.logger.warn(`[浏览器] 页面加载尝试 #${attempt} 失败: ${error.message}`);
          if (this.config.debugMode && this.page) {
            const errorScreenshotPath = path.join(debugFolder, `failed-nav-${authIndex}-${attempt}-${new Date().toISOString().replace(/:/g, '-')}.png`);
            await this._interruptible(() => this.page.screenshot({ path: errorScreenshotPath, fullPage: true })
              .catch(err => this.logger.warn(`[调试] 尝试保存失败截图时出错: ${err.message}`)));
            this.logger.info(`[调试] 失败截图已保存: ${errorScreenshotPath}`);
          }

          if (attempt < maxNavRetries) {
            this.logger.info('[浏览器] 等待 5 秒后重试...');
            await this._interruptible(() => new Promise(resolve => setTimeout(resolve, 5000)));
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
      this.logger.info('[浏览器] 页面加载完成，无条件等待10秒，确保UI完全稳定...');
      await this.page.waitForTimeout(10000);

      // 第二步：在一个固定时间内，持续不断地“清扫”页面
      this.logger.info('[浏览器] 开始在15秒内，持续清理所有弹窗...');
      const cleanupTimeout = Date.now() + 15000;
      let closedCount = 0;
      
      const closeButtonLocator = this.page.locator(
        "button:has-text('Got it'), button:has-text('✕')"
      );

      while (Date.now() < cleanupTimeout) {
        const buttons = await closeButtonLocator.all();
        for (const button of buttons) {
          await button.click({ force: true }).catch(() => {});
          closedCount++;
          this.logger.info(`[浏览器] 关闭了一个弹窗... (已尝试关闭 ${closedCount} 个)`);
        }
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
      await this._interruptible(() => editorLocator.waitFor({ state: 'attached', timeout: 120000 }));
      this.logger.info('[浏览器] 编辑器已附加。');

      this.logger.info('[浏览器] 等待3秒，之后将在编辑器上执行一次模拟点击以确保其激活...');
      await this._interruptible(() => this.page.waitForTimeout(3000));
      await this._interruptible(() => editorLocator.click({ force: true, timeout: 120000 }));

      await this._interruptible(() => this.page.evaluate(text => navigator.clipboard.writeText(text), buildScriptContent));
      const pasteKey = os.platform() === 'darwin' ? 'Meta+V' : 'Control+V';
      await this._interruptible(() => this.page.keyboard.press(pasteKey));
      this.logger.info('[浏览器] 注入脚本已粘贴。');

      const { role: previewRole, name: previewName } = this.config.automationTargets.previewButton;
      await this._interruptible(() => this.page.getByRole(previewRole, { name: previewName }).click());
      this.logger.info(`[浏览器] 已切换到 ${previewName} 视图。`);

      this.currentAuthIndex = authIndex;
      this.logger.info('==================================================');
      this.logger.info(`✅ [浏览器] 账号 ${authIndex} 初始化成功！`);
      this.logger.info('✅ [浏览器] 浏览器客户端已准备就绪。');
      this.logger.info('==================================================');
      return true; // 明确表示成功
    } catch (error) {
      if (error instanceof this.BrowserLaunchInterruptedError) {
        this.logger.info(`[INFO] 启动流程被用户中断。 (账号: ${authIndex})`);
        // 这是一个预期的中断，确保浏览器关闭后正常退出，不向上抛出错误
        await this.closeBrowser({ isSwitching: true }); // 假设中断是由于切换
        this.isClosing = false; // 重置标志，允许后续操作
        return false; // 明确表示中断
      }

      // 对于所有其他类型的错误，记录为致命错误并向上抛出
      this.logger.error(`❌ [浏览器] 账号 ${authIndex} 初始化遭遇致命错误: ${error.message}`, error);
      await this.closeBrowser();
      throw error; // 重新抛出，表示启动失败
    }
  }

  async closeBrowser(options = {}) {
    const { isSwitching = false } = options;
    if (!isSwitching) {
      this.isClosing = true;
      this.logger.info('[浏览器] 正在为应用级关闭设置全局停机标志。');
    } else {
      this.logger.info('[浏览器] 正在为账号切换关闭浏览器，跳过全局停机标志。');
    }

    if (this.browser) {
      this.logger.info('[浏览器] 正在关闭当前浏览器实例...');
      await this.browser.close().catch(err => this.logger.warn(`关闭浏览器时出错: ${err.message}`));
    } else if (isSwitching) {
      // 如果是在切换过程中，但没有浏览器实例，可能意味着之前的启动失败了。
      // 在这种情况下，我们需要确保 isClosing 标志被重置，以便下一次启动可以成功。
      this.logger.warn('[浏览器] 在账号切换期间尝试关闭浏览器，但没有发现实例。重置 isClosing 标志以确保可以启动新实例。');
      this.isClosing = false;
    }
  }

  async switchAccount(newAuthIndex) {
    this.logger.info(`🔄 [浏览器] 开始账号切换: 从 ${this.currentAuthIndex} 到 ${newAuthIndex}`);
    // 在切换账户时，这是一个组件级关闭，不应触发全局停机
    await this.closeBrowser({ isSwitching: true });
    
    // 在关闭旧浏览器后，重置 isClosing 标志，以确保新浏览器可以启动
    this.isClosing = false;
    
    await this.launchBrowser(newAuthIndex);
    this.logger.info(`✅ [浏览器] 账号切换完成，当前账号: ${this.currentAuthIndex}`);
  }

  async takeScreenshot(failureType) {
    if (!this.config.debugMode) {
      return;
    }

    if (!this.page) {
      this.logger.warn('[调试] 无法截图，因为页面对象 (page) 不存在。');
      return;
    }

    try {
      const debugFolder = path.resolve(__dirname, '..', 'debug-screenshots');
      if (!fs.existsSync(debugFolder)) {
        fs.mkdirSync(debugFolder, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/:/g, '-');
      const screenshotPath = path.join(debugFolder, `failure-${failureType}-${timestamp}.png`);
      
      await this.page.screenshot({ path: screenshotPath, fullPage: true });
      this.logger.info(`[调试] 屏幕截图已保存: ${screenshotPath}`);
    } catch (error) {
      this.logger.error(`[调试] 无法捕获屏幕截图: ${error.message}`);
    }
  }
}

module.exports = BrowserManager;