const Logger = {
  enabled: true,
  output(...messages) {
    if (!this.enabled) return;
    const timestamp =
      new Date().toLocaleTimeString("zh-CN", { hour12: false }) +
      "." +
      new Date().getMilliseconds().toString().padStart(3, "0");
    console.log(`[ProxyClient] ${timestamp}`, ...messages);
    const logElement = document.createElement("div");
    logElement.textContent = `[${timestamp}] ${messages.join(" ")}`;
    document.body.appendChild(logElement);
  },
};

class ConnectionManager extends EventTarget {
  // =================================================================
  // ===                 *** 请修改此行   *** ===
  constructor(endpoint = "ws://127.0.0.1:9998") {
    // =================================================================
    super();
    this.endpoint = endpoint;
    this.socket = null;
    this.isConnected = false;
    this.reconnectDelay = 5000;
    this.reconnectAttempts = 0;
  }

  async establish() {
    if (this.isConnected) return Promise.resolve();
    Logger.output("正在连接到服务器:", this.endpoint);
    return new Promise((resolve, reject) => {
      try {
        this.socket = new WebSocket(this.endpoint);
        this.socket.addEventListener("open", () => {
          this.isConnected = true;
          this.reconnectAttempts = 0;
          Logger.output("✅ 连接成功!");
          this.dispatchEvent(new CustomEvent("connected"));
          resolve();
        });
        this.socket.addEventListener("close", () => {
          this.isConnected = false;
          Logger.output("❌ 连接已断开，准备重连...");
          this.dispatchEvent(new CustomEvent("disconnected"));
          this._scheduleReconnect();
        });
        this.socket.addEventListener("error", (error) => {
          Logger.output(" WebSocket 连接错误:", error);
          this.dispatchEvent(new CustomEvent("error", { detail: error }));
          if (!this.isConnected) reject(error);
        });
        this.socket.addEventListener("message", (event) => {
          this.dispatchEvent(
            new CustomEvent("message", { detail: event.data })
          );
        });
      } catch (e) {
        Logger.output(
          "WebSocket 初始化失败。请检查地址或浏览器安全策略。",
          e.message
        );
        reject(e);
      }
    });
  }

  transmit(data) {
    if (!this.isConnected || !this.socket) {
      Logger.output("无法发送数据：连接未建立");
      return false;
    }
    this.socket.send(JSON.stringify(data));
    return true;
  }

  _scheduleReconnect() {
    this.reconnectAttempts++;
    setTimeout(() => {
      Logger.output(`正在进行第 ${this.reconnectAttempts} 次重连尝试...`);
      this.establish().catch(() => {});
    }, this.reconnectDelay);
  }
}

class RequestProcessor {
  constructor() {
    this.activeOperations = new Map();
    this.targetDomain = "generativelanguage.googleapis.com";
    this.maxRetries = 1; // 最多尝试3次
    this.retryDelay = 2000; // 每次重试前等待2秒
  }

  // --- MODIFIED: execute 方法 ---
  // execute 现在返回一个包含 Promise 和超时取消功能的对象
  execute(requestSpec, operationId) {
    const IDLE_TIMEOUT_DURATION = 600000; // 空闲超时改为600秒
    const abortController = new AbortController();
    this.activeOperations.set(operationId, abortController);

    let timeoutId = null;

    // 创建一个可以被外部取消的超时Promise
    const startIdleTimeout = () => {
      return new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          const error = new Error(
            `超时: ${IDLE_TIMEOUT_DURATION / 1000} 秒内未收到任何数据`
          );
          abortController.abort();
          reject(error);
        }, IDLE_TIMEOUT_DURATION);
      });
    };

    // NEW: 用于从外部取消超时的函数
    const cancelTimeout = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        Logger.output("已收到数据块，超时限制已解除。");
      }
    };

    const attemptPromise = new Promise(async (resolve, reject) => {
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        try {
          Logger.output(
            `执行请求 (尝试 ${attempt}/${this.maxRetries}):`,
            requestSpec.method,
            requestSpec.path
          );

          const requestUrl = this._constructUrl(requestSpec);
          const requestConfig = this._buildRequestConfig(
            requestSpec,
            abortController.signal
          );

          const response = await fetch(requestUrl, requestConfig);

          if (!response.ok) {
            const errorBody = await response.text();
            const error = new Error(
              `Google API返回错误: ${response.status} ${response.statusText} ${errorBody}`
            );
            error.status = response.status;
            throw error;
          }

          // 请求成功，将response对象传递出去
          resolve(response);
          return;
        } catch (error) {
          if (error.name === "AbortError") {
            reject(error); // 如果是超时导致的终止，直接拒绝
            return;
          }
          const isNetworkError = error.message.includes("Failed to fetch");
          const isRetryableServerError =
            error.status && [500, 502, 503, 504].includes(error.status);
          if (
            (isNetworkError || isRetryableServerError) &&
            attempt < this.maxRetries
          ) {
            Logger.output(
              `❌ 请求尝试 #${attempt} 失败: ${error.message.substring(0, 200)}`
            );
            Logger.output(`将在 ${this.retryDelay / 1000}秒后重试...`);
            await new Promise((r) => setTimeout(r, this.retryDelay));
            continue;
          } else {
            reject(error);
            return;
          }
        }
      }
    });

    // 将“请求重试”和“空闲超时”进行赛跑
    const responsePromise = Promise.race([attemptPromise, startIdleTimeout()]);

    // 返回Promise和取消函数
    return { responsePromise, cancelTimeout };
  }

  // --- constructUrl, generateRandomString, buildRequestConfig, sanitizeHeaders 等其他方法保持不变 ---
  cancelAllOperations() {
    this.activeOperations.forEach((controller, id) => controller.abort());
    this.activeOperations.clear();
  }
  _constructUrl(requestSpec) {
    let pathSegment = requestSpec.path.startsWith("/")
      ? requestSpec.path.substring(1)
      : requestSpec.path;
    const queryParams = new URLSearchParams(requestSpec.query_params);
    if (requestSpec.streaming_mode === "fake") {
      Logger.output("假流式模式激活，正在修改请求...");
      if (pathSegment.includes(":streamGenerateContent")) {
        pathSegment = pathSegment.replace(
          ":streamGenerateContent",
          ":generateContent"
        );
        Logger.output(`API路径已修改为: ${pathSegment}`);
      }
      if (queryParams.has("alt") && queryParams.get("alt") === "sse") {
        queryParams.delete("alt");
        Logger.output('已移除 "alt=sse" 查询参数。');
      }
    }
    const queryString = queryParams.toString();
    return `https://${this.targetDomain}/${pathSegment}${
      queryString ? "?" + queryString : ""
    }`;
  }
  _generateRandomString(length) {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let result = "";
    for (let i = 0; i < length; i++)
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
  }
  _buildRequestConfig(requestSpec, signal) {
    const config = {
      method: requestSpec.method,
      headers: this._sanitizeHeaders(requestSpec.headers),
      signal,
    };
    if (
      ["POST", "PUT", "PATCH"].includes(requestSpec.method) &&
      requestSpec.body
    ) {
      try {
        const bodyObj = JSON.parse(requestSpec.body);
        if (bodyObj.contents?.[0]?.parts?.[0]?.text) {
          bodyObj.contents[bodyObj.contents.length - 1].parts[
            bodyObj.contents[bodyObj.contents.length - 1].parts.length - 1
          ].text += `\n\n[sig:${this._generateRandomString(5)}]`;
          Logger.output("已向提示文本末尾添加伪装字符串。");
        }
        config.body = JSON.stringify(bodyObj);
      } catch (e) {
        config.body = requestSpec.body;
      }
    }
    return config;
  }
  _sanitizeHeaders(headers) {
    const sanitized = { ...headers };
    [
      "host",
      "connection",
      "content-length",
      "origin",
      "referer",
      "user-agent",
      "sec-fetch-mode",
      "sec-fetch-site",
      "sec-fetch-dest",
    ].forEach((h) => delete sanitized[h]);
    return sanitized;
  }
}

class ProxySystem extends EventTarget {
  constructor(websocketEndpoint) {
    super();
    this.connectionManager = new ConnectionManager(websocketEndpoint);
    this.requestProcessor = new RequestProcessor();
    this._setupEventHandlers();
  }

  async initialize() {
    Logger.output("系统初始化中...");
    try {
      await this.connectionManager.establish();
      Logger.output("系统初始化完成，等待服务器指令...");
      this.dispatchEvent(new CustomEvent("ready"));
    } catch (error) {
      Logger.output("系统初始化失败:", error.message);
      this.dispatchEvent(new CustomEvent("error", { detail: error }));
      throw error;
    }
  }

  _setupEventHandlers() {
    this.connectionManager.addEventListener("message", (e) =>
      this._handleIncomingMessage(e.detail)
    );
    this.connectionManager.addEventListener("disconnected", () =>
      this.requestProcessor.cancelAllOperations()
    );
  }

  async _handleIncomingMessage(messageData) {
    let requestSpec = {};
    try {
      requestSpec = JSON.parse(messageData);
      Logger.output(
        `收到请求: ${requestSpec.method} ${requestSpec.path} (模式: ${
          requestSpec.streaming_mode || "fake"
        })`
      );
      await this._processProxyRequest(requestSpec);
    } catch (error) {
      Logger.output("消息处理错误:", error.message);
      this._sendErrorResponse(error, requestSpec.request_id);
    }
  }

  // --- MODIFIED: _processProxyRequest 方法 ---
  async _processProxyRequest(requestSpec) {
    const operationId = requestSpec.request_id;
    const mode = requestSpec.streaming_mode || "fake";

    const { responsePromise, cancelTimeout } = this.requestProcessor.execute(
      requestSpec,
      operationId
    );

    try {
      const response = await responsePromise;
      this._transmitHeaders(response, operationId);

      const reader = response.body.getReader();
      const textDecoder = new TextDecoder();
      let timeoutCancelled = false;
      let fullBody = ""; // 用于假流式模式

      // [新增] 用于记录最终结束原因的变量
      let finalFinishReason = "UNKNOWN";

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        if (!timeoutCancelled) {
          cancelTimeout();
          timeoutCancelled = true;
        }

        const chunk = textDecoder.decode(value, { stream: true });

        // [新增] 在每个数据块中解析和记录 finishReason
        if (mode === "real") {
          const lines = chunk.split("\n");
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const jsonData = JSON.parse(line.substring(5));
                if (
                  jsonData.candidates &&
                  jsonData.candidates[0].finishReason
                ) {
                  finalFinishReason = jsonData.candidates[0].finishReason;
                }
              } catch (e) {
                /* 忽略JSON解析错误 */
              }
            }
          }
        }

        if (mode === "real") {
          this._transmitChunk(chunk, operationId);
        } else {
          fullBody += chunk;
        }
      }

      // --- [新增] 流结束后，根据模式输出最终状态日志 ---
      Logger.output("流读取完成。");

      if (mode === "real") {
        // 真流式模式：基于流过程中记录的最后一个 finishReason 判断
        if (finalFinishReason === "STOP") {
          Logger.output("✅ 响应成功");
        } else {
          Logger.output(`🤔 响应结束异常，原因: ${finalFinishReason}`);
        }
      } else {
        // 假流式模式：解析完整的响应体来判断
        let logMessage;
        try {
          const parsedBody = JSON.parse(fullBody);
          const finishReason = parsedBody.candidates?.[0]?.finishReason;

          if (finishReason === "STOP") {
            logMessage = "✅ 响应成功";
          } else {
            logMessage = `🤔 响应结束异常，原因: ${finishReason || "未知"}`;
          }
        } catch (e) {
          logMessage = `⚠️ 响应非JSON格式`;
        }
        Logger.output(logMessage);
        this._transmitChunk(fullBody, operationId);
      }

      this._transmitStreamEnd(operationId);
    } catch (error) {
      Logger.output(`❌ 错误: ${error.message}`);
      if (error.name !== "AbortError") {
        this._sendErrorResponse(error, operationId);
      } else {
        this._sendErrorResponse(error, operationId);
      }
    }
  }

  _transmitHeaders(response, operationId) {
    const headerMap = {};
    response.headers.forEach((v, k) => {
      headerMap[k] = v;
    });
    this.connectionManager.transmit({
      request_id: operationId,
      event_type: "response_headers",
      status: response.status,
      headers: headerMap,
    });
  }

  _transmitChunk(chunk, operationId) {
    if (!chunk) return;
    this.connectionManager.transmit({
      request_id: operationId,
      event_type: "chunk",
      data: chunk,
    });
  }

  _transmitStreamEnd(operationId) {
    this.connectionManager.transmit({
      request_id: operationId,
      event_type: "stream_close",
    });
    Logger.output("任务完成，已发送流结束信号");
  }

  _sendErrorResponse(error, operationId) {
    if (!operationId) return;
    this.connectionManager.transmit({
      request_id: operationId,
      event_type: "error",
      status: 504,
      message: `代理端浏览器错误: ${error.message || "未知错误"}`,
    });
    Logger.output("已将错误信息发送回服务器");
  }
}

async function initializeProxySystem() {
  // 清理旧的日志
  document.body.innerHTML = "";
  const proxySystem = new ProxySystem();
  try {
    await proxySystem.initialize();
  } catch (error) {
    console.error("代理系统启动失败:", error);
    Logger.output("代理系统启动失败:", error.message);
  }
}

initializeProxySystem();
